import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
  DeclarationNode,
  NativeDiagnostic,
  NativeDocument,
  SourceRange as NativeSourceRange,
} from "../../packages/language-core/src/index.js";
import { formatNativeDocument } from "../../packages/language-core/src/index.js";
import {
  CompletionItemKind,
  createConnection,
  DiagnosticSeverity,
  FileChangeType,
  InsertTextFormat,
  MarkupKind,
  ProposedFeatures,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
  type CompletionItem,
  type Definition,
  type DocumentSymbol,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type Location,
  type Position,
  type Range,
  type SignatureHelp,
  type TextEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

import { MAX_TOKENS_PER_FILE, NativeWorkspaceIndex, type WorkspaceLimits } from "./workspaceIndex.js";

const INDEX_FILES_NOTIFICATION = "tiangzNative/indexFiles";
const SERVER_STATS_REQUEST = "tiangzNative/serverStats";
const SLOW_VALIDATION_MS = 50;
const SLOW_LOG_INTERVAL_MS = 5_000;
const FILE_READ_CONCURRENCY = 8;

interface NativeSettings extends WorkspaceLimits {
  readonly validationDebounceMs: number;
  readonly initialFileLimit: number;
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let settings = normalizeSettings(undefined);
const index = new NativeWorkspaceIndex(settings);
const publishedUris = new Set<string>();
let validationTimer: NodeJS.Timeout | undefined;
let lastSlowLogAt = 0;
let shuttingDown = false;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  settings = normalizeSettings(params.initializationOptions);
  index.setLimits(settings);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ["@", ":"] },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      workspace: { workspaceFolders: { supported: true } },
    },
  };
});

connection.onInitialized(() => {
  connection.console.log("TiangZ Native Language Server initialized");
});

connection.onDidChangeConfiguration((change) => {
  const changed = isRecord(change.settings) ? change.settings.tiangzNative : undefined;
  settings = normalizeSettings(changed);
  index.setLimits(settings);
  scheduleValidation();
});

connection.onNotification(INDEX_FILES_NOTIFICATION, (value: unknown) => {
  if (!Array.isArray(value)) return;
  const uris = value.filter((item): item is string => typeof item === "string").slice(0, settings.initialFileLimit);
  void loadFiles(uris);
});

connection.onDidChangeWatchedFiles((change) => {
  const changed: string[] = [];
  for (const event of change.changes) {
    if (event.type === FileChangeType.Deleted) {
      index.delete(event.uri);
    } else {
      changed.push(event.uri);
    }
  }
  if (changed.length > 0) void loadFiles(changed);
  else scheduleValidation();
});

documents.onDidOpen((event) => {
  index.update(event.document.uri, event.document.getText(), event.document.version);
  scheduleValidation();
});

documents.onDidChangeContent((event) => {
  index.update(event.document.uri, event.document.getText(), event.document.version);
  scheduleValidation();
});

documents.onDidClose((event) => {
  if (event.document.uri.startsWith("file:")) void loadFiles([event.document.uri]);
  else {
    index.delete(event.document.uri);
    scheduleValidation();
  }
});

connection.onCompletion((params): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const linePrefix = document.getText({ start: { line: params.position.line, character: 0 }, end: params.position });
  if (/@[A-Za-z_]*$/.test(linePrefix)) return annotationCompletions();
  if (/\bextends\s+[A-Za-z_]*$/.test(linePrefix)) {
    return uniqueEntityNames().map((name) => ({ label: name, kind: CompletionItemKind.Class }));
  }
  if (/:\s*[A-Za-z0-9_\[\]]*$/.test(linePrefix)) return typeCompletions();
  return declarationCompletions();
});

connection.onHover((params): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const word = wordAt(document, params.position);
  if (!word) return null;
  const current = index.getDocument(params.textDocument.uri);
  const offset = document.offsetAt(params.position);
  const local = current ? describeNodeAt(current, offset) : undefined;
  const description = local ?? describeGlobal(word);
  return description ? { contents: { kind: MarkupKind.Markdown, value: description } } : null;
});

connection.onDefinition((params): Definition | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const word = wordAt(document, params.position);
  if (!word) return null;
  const nativeDocument = index.getDocument(params.textDocument.uri);
  const target = nativeDocument ? symbolAt(nativeDocument, document.offsetAt(params.position), word) : undefined;
  return target ? findDefinition(target) : null;
});

connection.onReferences((params): Location[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const word = wordAt(document, params.position);
  if (!word) return [];
  const nativeDocument = index.getDocument(params.textDocument.uri);
  const target = nativeDocument ? symbolAt(nativeDocument, document.offsetAt(params.position), word) : undefined;
  if (!target || !findDefinition(target)) return [];
  return findReferences(target, params.context.includeDeclaration);
});

connection.onSignatureHelp((params): SignatureHelp | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const linePrefix = document.getText({
    start: { line: params.position.line, character: 0 },
    end: params.position,
  });
  if (/@typeId\s*\([^)]*$/.test(linePrefix)) {
    return {
      signatures: [{
        label: "@typeId(id: integer)",
        documentation: "为 Entity 分配 1..65535 范围内、全局唯一的类型编号。",
        parameters: [{ label: "id: integer", documentation: "全局唯一的 Entity typeId。" }],
      }],
      activeSignature: 0,
      activeParameter: 0,
    };
  }

  const operationMatch = /\bop\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)$/.exec(linePrefix);
  if (!operationMatch) return null;
  const operationName = operationMatch[1]!;
  const activeParameter = (operationMatch[2]!.match(/,/g) ?? []).length;
  const operation = index.getModel().operations.find((candidate) => candidate.name === operationName);
  if (operation) {
    const parameters = operation.params.map((parameter) => `${parameter.name}: ${parameter.type}`);
    return {
      signatures: [{
        label: `op ${operation.name}(${parameters.join(", ")}): ${operation.returnType}`,
        parameters: parameters.map((label) => ({ label })),
      }],
      activeSignature: 0,
      activeParameter: Math.min(activeParameter, Math.max(0, parameters.length - 1)),
    };
  }
  return {
    signatures: [{
      label: `op ${operationName}(parameter: type, ...): returnType`,
      documentation: "声明一个 Native op；参数格式为 name: type。",
      parameters: [{ label: "parameter: type" }],
    }],
    activeSignature: 0,
    activeParameter: 0,
  };
});

connection.onDocumentFormatting((params): TextEdit[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const text = document.getText();
  if (Buffer.byteLength(text, "utf8") > settings.maxFileSizeBytes) return [];
  const formatted = formatNativeDocument(text, {
    maxDiagnostics: settings.maxDiagnosticsPerFile + 1,
    maxTokens: MAX_TOKENS_PER_FILE,
  });
  if (formatted === text) return [];
  return [{
    range: { start: { line: 0, character: 0 }, end: document.positionAt(text.length) },
    newText: formatted,
  }];
});

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const document = index.getDocument(params.textDocument.uri);
  if (!document) return [];
  return document.declarations.map(toDocumentSymbol);
});

connection.onRequest(SERVER_STATS_REQUEST, () => ({
  ...settings,
  ...index.getStats(),
  heapUsedBytes: process.memoryUsage().heapUsed,
}));

connection.onShutdown(() => {
  shuttingDown = true;
  if (validationTimer) clearTimeout(validationTimer);
  validationTimer = undefined;
  for (const uri of publishedUris) connection.sendDiagnostics({ uri, diagnostics: [] });
  publishedUris.clear();
  index.clear();
});

documents.listen(connection);
connection.listen();

async function loadFiles(uris: readonly string[]): Promise<void> {
  const pending = [...new Set(uris)].filter((uri) => uri.startsWith("file:") && uri.endsWith(".native"));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (!shuttingDown) {
      const uri = pending[cursor];
      cursor += 1;
      if (!uri) return;
      if (documents.get(uri)) continue;
      await loadFile(uri);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FILE_READ_CONCURRENCY, pending.length) }, worker));
  scheduleValidation(0);
}

async function loadFile(uri: string): Promise<void> {
  try {
    const file = fileURLToPath(uri);
    const metadata = await stat(file);
    if (metadata.size > settings.maxFileSizeBytes) {
      if (shuttingDown) return;
      index.updateOversized(uri, metadata.size);
      return;
    }
    const text = await readFile(file, "utf8");
    if (!shuttingDown && !documents.get(uri)) index.update(uri, text);
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code === "ENOENT") index.delete(uri);
    else connection.console.error(`Failed to read ${uri}: ${errorMessage(error)}`);
  }
}

function scheduleValidation(delay = settings.validationDebounceMs): void {
  if (shuttingDown) return;
  if (validationTimer) clearTimeout(validationTimer);
  validationTimer = setTimeout(() => {
    validationTimer = undefined;
    publishValidation();
  }, Math.max(0, delay));
}

function publishValidation(): void {
  const snapshot = index.validate();
  const nextUris = new Set(snapshot.diagnosticsByUri.keys());
  for (const [uri, diagnostics] of snapshot.diagnosticsByUri) {
    connection.sendDiagnostics({ uri, diagnostics: diagnostics.map(toLspDiagnostic) });
  }
  for (const uri of publishedUris) {
    if (!nextUris.has(uri)) connection.sendDiagnostics({ uri, diagnostics: [] });
  }
  publishedUris.clear();
  for (const uri of nextUris) publishedUris.add(uri);

  const now = Date.now();
  if (snapshot.stats.lastValidationMs >= SLOW_VALIDATION_MS && now - lastSlowLogAt >= SLOW_LOG_INTERVAL_MS) {
    lastSlowLogAt = now;
    connection.console.warn(
      `Slow validation: ${snapshot.stats.lastValidationMs.toFixed(2)} ms for ${snapshot.stats.cachedFiles} files`,
    );
  }
}

function toLspDiagnostic(diagnostic: NativeDiagnostic) {
  return {
    range: toRange(diagnostic.range),
    severity: diagnostic.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
    code: diagnostic.code,
    source: "tiangz-native",
    message: diagnostic.message,
  };
}

function annotationCompletions(): CompletionItem[] {
  return [
    { label: "typeId", kind: CompletionItemKind.Property, insertText: "typeId(${1:1})", insertTextFormat: InsertTextFormat.Snippet },
    { label: "component", kind: CompletionItemKind.Property },
  ];
}

function typeCompletions(): CompletionItem[] {
  return ["u32", "i32", "i8", "f32", "f64", "bool", "bytes", "f64[]", "void"]
    .map((label) => ({ label, kind: CompletionItemKind.TypeParameter }));
}

function declarationCompletions(): CompletionItem[] {
  return [
    { label: "namespace", kind: CompletionItemKind.Keyword, insertText: "namespace ${1:demo};", insertTextFormat: InsertTextFormat.Snippet },
    { label: "entity", kind: CompletionItemKind.Keyword },
    { label: "abstract entity", kind: CompletionItemKind.Snippet, insertText: "abstract entity ${1:Entity} {\n  ${2}\n}", insertTextFormat: InsertTextFormat.Snippet },
    { label: "op", kind: CompletionItemKind.Snippet, insertText: "op ${1:Operation}(${2}): ${3:void};", insertTextFormat: InsertTextFormat.Snippet },
    { label: "readonly", kind: CompletionItemKind.Keyword },
  ];
}

function uniqueEntityNames(): readonly string[] {
  return [...new Set(index.getModel().entities.map((entity) => entity.name))].sort((left, right) => left.localeCompare(right, "en"));
}

function wordAt(document: TextDocument, position: Position): string | undefined {
  const text = document.getText();
  const offset = document.offsetAt(position);
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1] ?? "")) start -= 1;
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end] ?? "")) end += 1;
  return end > start ? text.slice(start, end) : undefined;
}

function describeNodeAt(document: NativeDocument, offset: number): string | undefined {
  for (const declaration of document.declarations) {
    if (!containsOffset(declaration.range, offset)) continue;
    if (declaration.kind === "entity") {
      for (const field of declaration.fields) {
        if (containsOffset(field.range, offset)) {
          const modifier = field.readonly ? "readonly " : "";
          const defaultValue = field.defaultValue ? ` = ${field.defaultValue.raw}` : "";
          return `\`${modifier}${field.name.name}: ${field.type.name}${defaultValue}\``;
        }
      }
      const parent = declaration.parent ? ` extends ${declaration.parent.name}` : "";
      return `\`${declaration.abstract ? "abstract " : ""}entity ${declaration.name.name}${parent}\``;
    }
    const parameters = declaration.parameters.map((parameter) => `${parameter.name.name}: ${parameter.type.name}`).join(", ");
    return `\`op ${declaration.name.name}(${parameters}): ${declaration.returnType.name}\``;
  }
  return undefined;
}

function describeGlobal(word: string): string | undefined {
  const entity = index.getModel().entities.find((candidate) => candidate.name === word);
  if (entity) {
    const parent = entity.parent ? ` extends ${entity.parent}` : "";
    return `\`${entity.abstract ? "abstract " : ""}entity ${entity.name}${parent}\`  \n${entity.sourceFile}`;
  }
  const operation = index.getModel().operations.find((candidate) => candidate.name === word);
  if (operation) {
    const parameters = operation.params.map((parameter) => `${parameter.name}: ${parameter.type}`).join(", ");
    return `\`op ${operation.name}(${parameters}): ${operation.returnType}\`  \n${operation.sourceFile}`;
  }
  return undefined;
}

type SymbolTarget = Readonly<{ kind: "entity" | "operation"; name: string }>;

function symbolAt(document: NativeDocument, offset: number, word: string): SymbolTarget | undefined {
  for (const declaration of document.declarations) {
    if (declaration.name.name === word && containsOffset(declaration.name.range, offset)) {
      return { kind: declaration.kind, name: word };
    }
    if (declaration.kind === "entity"
      && declaration.parent?.name === word
      && containsOffset(declaration.parent.range, offset)) {
      return { kind: "entity", name: word };
    }
  }
  return undefined;
}

function findDefinition(target: SymbolTarget): Definition | null {
  for (const document of index.getDocuments()) {
    for (const declaration of document.declarations) {
      if (declaration.kind === target.kind && declaration.name.name === target.name) {
        return { uri: document.uri, range: toRange(declaration.name.range) } satisfies Location;
      }
    }
  }
  return null;
}

function findReferences(target: SymbolTarget, includeDeclaration: boolean): Location[] {
  const locations: Location[] = [];
  const seen = new Set<string>();
  for (const document of index.getDocuments()) {
    for (const declaration of document.declarations) {
      if (includeDeclaration && declaration.kind === target.kind && declaration.name.name === target.name) {
        add(document.uri, declaration.name.range);
      }
      if (target.kind === "entity" && declaration.kind === "entity" && declaration.parent?.name === target.name) {
        add(document.uri, declaration.parent.range);
      }
    }
  }
  return locations;

  function add(uri: string, range: NativeSourceRange): void {
    const key = `${uri}:${range.start.offset}:${range.end.offset}`;
    if (seen.has(key)) return;
    seen.add(key);
    locations.push({ uri, range: toRange(range) });
  }
}

function toDocumentSymbol(declaration: DeclarationNode): DocumentSymbol {
  if (declaration.kind === "entity") {
    return {
      name: declaration.name.name,
      detail: declaration.parent ? `extends ${declaration.parent.name}` : declaration.abstract ? "abstract entity" : "entity",
      kind: SymbolKind.Class,
      range: toRange(declaration.range),
      selectionRange: toRange(declaration.name.range),
      children: declaration.fields.map((field) => ({
        name: field.name.name,
        detail: field.type.name,
        kind: SymbolKind.Field,
        range: toRange(field.range),
        selectionRange: toRange(field.name.range),
      })),
    };
  }
  return {
    name: declaration.name.name,
    detail: `returns ${declaration.returnType.name}`,
    kind: SymbolKind.Function,
    range: toRange(declaration.range),
    selectionRange: toRange(declaration.name.range),
    children: declaration.parameters.map((parameter) => ({
      name: parameter.name.name,
      detail: parameter.type.name,
      kind: SymbolKind.Variable,
      range: toRange(parameter.range),
      selectionRange: toRange(parameter.name.range),
    })),
  };
}

function containsOffset(range: NativeSourceRange, offset: number): boolean {
  return offset >= range.start.offset && offset <= range.end.offset;
}

function toRange(range: NativeSourceRange): Range {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function normalizeSettings(value: unknown): NativeSettings {
  const source = isRecord(value) ? value : {};
  return {
    validationDebounceMs: boundedNumber(source.validationDebounceMs, 100, 20, 2_000),
    maxFileSizeBytes: boundedNumber(source.maxFileSizeBytes, 2 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024),
    maxDiagnosticsPerFile: boundedNumber(source.maxDiagnosticsPerFile, 200, 10, 2_000),
    initialFileLimit: boundedNumber(source.initialFileLimit, 10_000, 100, 100_000),
  };
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
