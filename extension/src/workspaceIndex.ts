import {
  analyzeNativeDocuments,
  parseNativeDocument,
  type NativeDiagnostic,
  type NativeDocument,
  type NativeSemanticModel,
} from "../../packages/language-core/src/index.js";

export interface WorkspaceLimits {
  readonly maxFileSizeBytes: number;
  readonly maxDiagnosticsPerFile: number;
}

export interface WorkspaceIndexStats {
  readonly cachedFiles: number;
  readonly parsedFiles: number;
  readonly parseCount: number;
  readonly validationCount: number;
  readonly entityCount: number;
  readonly operationCount: number;
  readonly lastValidationMs: number;
  readonly maxValidationMs: number;
}

export interface ValidationSnapshot {
  readonly diagnosticsByUri: ReadonlyMap<string, readonly NativeDiagnostic[]>;
  readonly model: NativeSemanticModel;
  readonly stats: WorkspaceIndexStats;
}

interface CacheEntry {
  readonly fingerprint: string;
  readonly version: number | undefined;
  readonly document: NativeDocument | undefined;
  readonly localDiagnostics: readonly NativeDiagnostic[];
}

export const MAX_TOKENS_PER_FILE = 100_000;

const ZERO_RANGE = {
  start: { offset: 0, line: 0, character: 0 },
  end: { offset: 0, line: 0, character: 0 },
} as const;

export class NativeWorkspaceIndex {
  private readonly entries = new Map<string, CacheEntry>();
  private parseCount = 0;
  private validationCount = 0;
  private lastValidationMs = 0;
  private maxValidationMs = 0;
  private lastModel: NativeSemanticModel = { entities: [], operations: [] };
  private workspaceRoots: readonly string[] = [];
  private readonly models = new Map<string, NativeSemanticModel>();

  public constructor(private limits: WorkspaceLimits) {}

  public setLimits(limits: WorkspaceLimits): void {
    this.limits = limits;
  }

  /** 每个工作区文件夹拥有独立的符号/typeId，嵌套根按最长匹配。 / Each workspace folder owns symbols and type IDs; nested roots use the longest match. */
  public setWorkspaceFolders(uris: readonly string[]): void {
    this.workspaceRoots = [...new Set(uris.map(normalizeUri))].sort((left, right) => right.length - left.length);
    this.models.clear();
    this.lastModel = { entities: [], operations: [] };
  }

  private owner(uri: string): string {
    if (this.workspaceRoots.length === 0) return "";
    const candidate = normalizeUri(uri);
    return this.workspaceRoots.find(root => candidate === root || candidate.startsWith(`${root}/`)) ?? candidate;
  }

  public update(uri: string, text: string, version?: number): boolean {
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength > this.limits.maxFileSizeBytes) {
      return this.updateOversized(uri, byteLength, version);
    }
    const fingerprint = `${byteLength}:${hashText(text)}`;
    const previous = this.entries.get(uri);
    if (previous?.fingerprint === fingerprint) {
      if (previous.version !== version) this.entries.set(uri, { ...previous, version });
      return false;
    }
    const document = parseNativeDocument(text, uri, {
      maxDiagnostics: this.limits.maxDiagnosticsPerFile + 1,
      maxTokens: MAX_TOKENS_PER_FILE,
    });
    this.parseCount += 1;
    this.entries.set(uri, {
      fingerprint,
      version,
      document,
      localDiagnostics: [],
    });
    return true;
  }

  public updateOversized(uri: string, byteLength: number, version?: number): boolean {
    const fingerprint = `oversized:${byteLength}`;
    const previous = this.entries.get(uri);
    if (previous?.fingerprint === fingerprint) {
      if (previous.version !== version) this.entries.set(uri, { ...previous, version });
      return false;
    }
    this.entries.set(uri, {
      fingerprint,
      version,
      document: undefined,
      localDiagnostics: [{
        uri,
        code: "native.performance.file-too-large",
        severity: "warning",
        message: `文件大小 ${byteLength} 字节，超过语言服务器上限 ${this.limits.maxFileSizeBytes} 字节`,
        range: ZERO_RANGE,
      }],
    });
    return true;
  }

  public delete(uri: string): boolean {
    return this.entries.delete(uri);
  }

  public has(uri: string): boolean {
    return this.entries.has(uri);
  }

  public getDocument(uri: string): NativeDocument | undefined {
    return this.entries.get(uri)?.document;
  }

  public getDocuments(uri?: string): readonly NativeDocument[] {
    const owner = uri === undefined ? undefined : this.owner(uri);
    return [...this.entries.entries()].flatMap(([candidate, entry]) =>
      entry.document && (owner === undefined || this.owner(candidate) === owner) ? [entry.document] : []);
  }

  public getUris(): readonly string[] {
    return [...this.entries.keys()];
  }

  public getModel(uri?: string): NativeSemanticModel {
    return uri === undefined ? this.lastModel : this.models.get(this.owner(uri)) ?? { entities: [], operations: [] };
  }

  public validate(): ValidationSnapshot {
    const startedAt = performance.now();
    const projects = new Map<string, NativeDocument[]>();
    for (const document of this.getDocuments()) {
      const owner = this.owner(document.uri);
      const files = projects.get(owner) ?? [];
      files.push(document);
      projects.set(owner, files);
    }
    this.models.clear();
    const analyses = [...projects].map(([owner, files]) => {
      const analysis = analyzeNativeDocuments(files);
      this.models.set(owner, analysis.model);
      return analysis;
    });
    const grouped = new Map<string, NativeDiagnostic[]>();
    for (const uri of this.entries.keys()) grouped.set(uri, []);
    for (const analysis of analyses) for (const diagnostic of analysis.diagnostics) pushDiagnostic(grouped, diagnostic);
    for (const entry of this.entries.values()) {
      for (const diagnostic of entry.localDiagnostics) pushDiagnostic(grouped, diagnostic);
    }
    for (const [uri, diagnostics] of grouped) {
      if (diagnostics.length <= this.limits.maxDiagnosticsPerFile) continue;
      const omitted = diagnostics.length - this.limits.maxDiagnosticsPerFile;
      diagnostics.length = this.limits.maxDiagnosticsPerFile;
      diagnostics.push({
        uri,
        code: "native.performance.diagnostic-limit",
        severity: "warning",
        message: `另有 ${omitted} 条诊断已被抑制`,
        range: diagnostics.at(-1)?.range ?? ZERO_RANGE,
      });
    }

    this.lastValidationMs = performance.now() - startedAt;
    this.maxValidationMs = Math.max(this.maxValidationMs, this.lastValidationMs);
    this.validationCount += 1;
    this.lastModel = {
      entities: analyses.flatMap(analysis => analysis.model.entities),
      operations: analyses.flatMap(analysis => analysis.model.operations),
    };
    return {
      diagnosticsByUri: grouped,
      model: this.lastModel,
      stats: this.getStats(),
    };
  }

  public getStats(): WorkspaceIndexStats {
    return {
      cachedFiles: this.entries.size,
      parsedFiles: this.getDocuments().length,
      parseCount: this.parseCount,
      validationCount: this.validationCount,
      entityCount: this.lastModel.entities.length,
      operationCount: this.lastModel.operations.length,
      lastValidationMs: this.lastValidationMs,
      maxValidationMs: this.maxValidationMs,
    };
  }

  public clear(): void {
    this.entries.clear();
    this.models.clear();
    this.lastModel = { entities: [], operations: [] };
  }
}

function normalizeUri(uri: string): string {
  const normalized = uri.replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pushDiagnostic(grouped: Map<string, NativeDiagnostic[]>, diagnostic: NativeDiagnostic): void {
  const diagnostics = grouped.get(diagnostic.uri) ?? [];
  diagnostics.push(diagnostic);
  grouped.set(diagnostic.uri, diagnostics);
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
