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

  public constructor(private limits: WorkspaceLimits) {}

  public setLimits(limits: WorkspaceLimits): void {
    this.limits = limits;
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
      maxTokens: 100_000,
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
        message: `File size ${byteLength} bytes exceeds language server limit ${this.limits.maxFileSizeBytes} bytes`,
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

  public getDocuments(): readonly NativeDocument[] {
    return [...this.entries.values()].flatMap((entry) => entry.document ? [entry.document] : []);
  }

  public getUris(): readonly string[] {
    return [...this.entries.keys()];
  }

  public getModel(): NativeSemanticModel {
    return this.lastModel;
  }

  public validate(): ValidationSnapshot {
    const startedAt = performance.now();
    const analysis = analyzeNativeDocuments(this.getDocuments());
    const grouped = new Map<string, NativeDiagnostic[]>();
    for (const uri of this.entries.keys()) grouped.set(uri, []);
    for (const diagnostic of analysis.diagnostics) pushDiagnostic(grouped, diagnostic);
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
        message: `${omitted} additional diagnostics were suppressed`,
        range: diagnostics.at(-1)?.range ?? ZERO_RANGE,
      });
    }

    this.lastValidationMs = performance.now() - startedAt;
    this.maxValidationMs = Math.max(this.maxValidationMs, this.lastValidationMs);
    this.validationCount += 1;
    this.lastModel = analysis.model;
    return {
      diagnosticsByUri: grouped,
      model: analysis.model,
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
    this.lastModel = { entities: [], operations: [] };
  }
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
