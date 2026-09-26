import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
  DeclarationNode,
  EntityDeclarationNode,
  NativeDiagnostic,
  NativeDocument,
  NativeEntityModel,
  NativeFieldModel,
  NativeGeneratedSymbols,
  NativeProjectedEntityField,
  NativeOperationModel,
  SourceRange as NativeSourceRange,
} from "../../packages/language-core/src/index.js";
import {
  findNextAvailableTypeId,
  formatNativeDocument,
  projectNativeEntityApi,
  projectNativeEntitySymbols,
  projectNativeFieldSymbols,
  projectNativeOperationSymbols,
  toNativeCamelCase,
} from "../../packages/language-core/src/index.js";
import {
  CodeActionKind,
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
  type CodeAction,
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
let sourceRootUris: readonly string[] = [];

connection.onInitialize((params: InitializeParams): InitializeResult => {
  settings = normalizeSettings(params.initializationOptions);
  sourceRootUris = normalizeSourceRootUris(params.initializationOptions);
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
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      workspace: { workspaceFolders: { supported: true } },
    },
  };
});

connection.onInitialized(() => {
  connection.console.log("TiangZ Native 语言服务器已初始化");
});

connection.onDidChangeConfiguration((change) => {
  const changed = isRecord(change.settings) ? change.settings.tiangzNative : undefined;
  settings = normalizeSettings(changed);
  index.setLimits(settings);
  scheduleValidation();
});

connection.onNotification(INDEX_FILES_NOTIFICATION, (value: unknown) => {
  if (!Array.isArray(value)) return;
  const uris = value
    .filter((item): item is string => typeof item === "string" && shouldIndexUri(item))
    .slice(0, settings.initialFileLimit);
  void loadFiles(uris);
});

connection.onDidChangeWatchedFiles((change) => {
  const changed: string[] = [];
  for (const event of change.changes) {
    if (event.type === FileChangeType.Deleted) {
      index.delete(event.uri);
    } else if (shouldIndexUri(event.uri)) {
      changed.push(event.uri);
    }
  }
  if (changed.length > 0) void loadFiles(changed);
  else scheduleValidation();
});

documents.onDidOpen((event) => {
  if (!shouldIndexUri(event.document.uri)) {
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    return;
  }
  index.update(event.document.uri, event.document.getText(), event.document.version);
  scheduleValidation();
});

documents.onDidChangeContent((event) => {
  if (!shouldIndexUri(event.document.uri)) return;
  index.update(event.document.uri, event.document.getText(), event.document.version);
  scheduleValidation();
});

documents.onDidClose((event) => {
  if (!shouldIndexUri(event.document.uri)) return;
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
        documentation: "为具体 Entity 分配一个 1..65535 范围内、工作区全局唯一的类型编号。",
        parameters: [{ label: "id: integer", documentation: "用于 Rust 存储和 TS 句柄创建的 Entity 类型编号。" }],
      }],
      activeSignature: 0,
      activeParameter: 0,
    };
  }
  if (/@memberId\s*\([^)]*$/.test(linePrefix)) {
    return {
      signatures: [{
        label: "@memberId(id: integer)",
        documentation: "为 @replicated Entity 的字段分配稳定复制编号，范围为 1..63。",
        parameters: [{ label: "id: integer", documentation: "对应 u64 dirty mask 的 bit；发布后不要因字段换序而修改。" }],
      }],
      activeSignature: 0,
      activeParameter: 0,
    };
  }
  if (/@persistent\s*\([^)]*$/.test(linePrefix)) {
    return {
      signatures: [{
        label: "@persistent(version: integer)",
        documentation: "为普通 Entity 声明稳定的持久化结构版本，并生成 Snapshot Codec 与 Repository 描述。",
        parameters: [{ label: "version: integer", documentation: "结构不兼容变更时递增；仅修改运行时数据不改变版本。" }],
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
      label: `op ${operationName}(参数名: 类型, ...): 返回类型`,
      documentation: "声明一个从 TypeScript 调用 Rust Host 的 Native op；参数格式为 name: type。",
      parameters: [{ label: "参数名: 类型" }],
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

connection.onCodeAction((params): CodeAction[] => {
  if (params.context.only && !params.context.only.includes(CodeActionKind.QuickFix)) return [];
  const document = documents.get(params.textDocument.uri);
  const nativeDocument = index.getDocument(params.textDocument.uri);
  if (!document || !nativeDocument) return [];
  if (nativeDocument.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return [];

  const relevantDiagnostics = params.context.diagnostics.filter(
    (diagnostic) => diagnostic.code === "native.semantic.type-id-required",
  );
  if (relevantDiagnostics.length === 0) return [];

  const allocation = findNextAvailableTypeId(index.getModel().entities.map((entity) => entity.typeId));
  return relevantDiagnostics.flatMap((diagnostic): CodeAction[] => {
    const entity = findEntityAt(nativeDocument, document.offsetAt(diagnostic.range.start));
    if (!entity || entity.abstract || entity.annotations.some((annotation) => annotation.name.name === "typeId")) return [];

    const title = `为 ${entity.name.name} 分配下一个可用 typeId`;
    if (allocation.status === "duplicate") {
      const preview = allocation.duplicateTypeIds.slice(0, 8).join(", ");
      const suffix = allocation.duplicateTypeIds.length > 8 ? ", ..." : "";
      return [{
        title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        disabled: { reason: `工作区存在重复 typeId：${preview}${suffix}，请先解决冲突` },
      }];
    }
    if (allocation.status === "exhausted") {
      return [{
        title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        disabled: { reason: "typeId 1..65535 已全部使用" },
      }];
    }

    const position = toRange(entity.range).start;
    const lineStartOffset = document.offsetAt({ line: position.line, character: 0 });
    const prefix = document.getText().slice(lineStartOffset, entity.range.start.offset);
    const indent = /^\s*/.exec(prefix)?.[0] ?? "";
    const eol = document.getText().includes("\r\n") ? "\r\n" : "\n";
    return [{
      title: `添加 @typeId(${allocation.typeId})`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      isPreferred: true,
      edit: {
        changes: {
          [params.textDocument.uri]: [{
            range: { start: position, end: position },
            newText: `@typeId(${allocation.typeId})${eol}${indent}`,
          }],
        },
      },
    }];
  });
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
    else connection.console.error(`读取 ${uri} 失败：${errorMessage(error)}`);
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
      `校验耗时较长：${snapshot.stats.cachedFiles} 个文件共 ${snapshot.stats.lastValidationMs.toFixed(2)} ms`,
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
    { label: "typeId", detail: "为具体 Entity 分配全局唯一类型编号", kind: CompletionItemKind.Property, insertText: "typeId(${1:1})", insertTextFormat: InsertTextFormat.Snippet },
    { label: "component", detail: "将 Entity 标记为 Component", kind: CompletionItemKind.Property },
    { label: "replicated", detail: "为固定字段 Entity 生成帧尾脏掩码和强类型 Delta", kind: CompletionItemKind.Property },
    { label: "persistent", detail: "生成有版本的 Snapshot Codec 与 Repository 描述", kind: CompletionItemKind.Property, insertText: "persistent(${1:1})", insertTextFormat: InsertTextFormat.Snippet },
    { label: "queued", detail: "只能排队写入；确认由 DBProxy backlog.enqueueAck 决定（默认 aof，memory 仅内存），不代表 PG 提交；不能直接保存或加入事务", kind: CompletionItemKind.Property },
    { label: "transactional", detail: "持久化记录只能通过事务写入，不生成单独保存方法", kind: CompletionItemKind.Property },
    { label: "memberId", detail: "为复制字段分配稳定的 1..63 成员编号", kind: CompletionItemKind.Property, insertText: "memberId(${1:1})", insertTextFormat: InsertTextFormat.Snippet },
    { label: "hot", detail: "将字段标记为高频访问数据，供 Rust 热池布局生成", kind: CompletionItemKind.Property },
    { label: "cold", detail: "将字段标记为低频访问数据，供 Rust 冷池布局生成", kind: CompletionItemKind.Property },
    { label: "transient", detail: "将运行时字段排除在持久化 Snapshot 之外", kind: CompletionItemKind.Property },
  ];
}

function typeCompletions(): CompletionItem[] {
  return ["u32", "i32", "i64", "i8", "f32", "f64", "bool", "bytes", "f64[]", "void"]
    .map((label) => ({ label, kind: CompletionItemKind.TypeParameter }));
}

function declarationCompletions(): CompletionItem[] {
  return [
    { label: "namespace", detail: "声明当前文件的命名空间", kind: CompletionItemKind.Keyword, insertText: "namespace ${1:demo};", insertTextFormat: InsertTextFormat.Snippet },
    { label: "entity", detail: "声明 Native Entity", kind: CompletionItemKind.Keyword },
    { label: "abstract entity", detail: "声明不可直接创建的抽象 Entity", kind: CompletionItemKind.Snippet, insertText: "abstract entity ${1:Entity} {\n  ${2}\n}", insertTextFormat: InsertTextFormat.Snippet },
    { label: "op", detail: "声明 TypeScript 调用 Rust Host 的 Native op", kind: CompletionItemKind.Snippet, insertText: "op ${1:Operation}(${2}): ${3:void};", insertTextFormat: InsertTextFormat.Snippet },
    { label: "readonly", detail: "声明创建后不可通过通用 setter 修改的字段", kind: CompletionItemKind.Keyword },
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
      if (declaration.parent && containsOffset(declaration.parent.range, offset)) {
        const parentName = declaration.parent.name;
        const parent = index.getModel().entities.find((entity) => entity.name === parentName);
        if (parent) return describeEntityModel(parent);
      }
      const entity = index.getModel().entities.find(
        (candidate) => candidate.sourceFile === document.uri && candidate.name === declaration.name.name,
      );
      for (const field of declaration.fields) {
        if (containsOffset(field.range, offset)) {
          const modifier = field.readonly ? "readonly " : "";
          const defaultValue = field.defaultValue ? ` = ${field.defaultValue.raw}` : "";
          const signature = `\`${modifier}${field.name.name}: ${field.type.name}${defaultValue}\``;
          const fieldModel = entity?.fields.find((candidate) => candidate.name === field.name.name);
          return entity && fieldModel
            ? describeFieldModel(entity, fieldModel, signature)
            : signature;
        }
      }
      const parent = declaration.parent ? ` extends ${declaration.parent.name}` : "";
      return entity ? describeEntityModel(entity, false) : `\`${declaration.abstract ? "abstract " : ""}entity ${declaration.name.name}${parent}\``;
    }
    const parameters = declaration.parameters.map((parameter) => `${parameter.name.name}: ${parameter.type.name}`).join(", ");
    const signature = `\`op ${declaration.name.name}(${parameters}): ${declaration.returnType.name}\``;
    const operation = index.getModel().operations.find(
      (candidate) => candidate.sourceFile === document.uri && candidate.name === declaration.name.name,
    );
    return operation ? describeOperationModel(operation, false) : signature;
  }
  return undefined;
}

function describeGlobal(word: string): string | undefined {
  const entity = index.getModel().entities.find((candidate) => candidate.name === word);
  if (entity) return describeEntityModel(entity);
  const operation = index.getModel().operations.find((candidate) => candidate.name === word);
  if (operation) {
    return describeOperationModel(operation, true);
  }
  return undefined;
}

function describeEntityModel(entity: NativeEntityModel, showSource = true): string {
  const parent = entity.parent ? ` extends ${entity.parent}` : "";
  const kind = entity.abstract ? "抽象实体" : entity.component ? "Component 实体" : "实体";
  const api = projectNativeEntityApi(index.getModel(), entity);
  const flattenedFields = api.fields;
  const ownFieldCount = entity.fields.length;
  const inheritedFieldCount = Math.max(0, flattenedFields.length - ownFieldCount);
  const hotFieldCount = flattenedFields.filter((field) => field.storage === "hot").length;
  const coldFieldCount = flattenedFields.filter((field) => field.storage === "cold").length;
  const lines = [
    `### ${kind} ${markdownCode(entity.name)}`,
    "",
    `\`${entity.abstract ? "abstract " : ""}entity ${entity.name}${parent}\``,
    "",
    `- **命名空间**：${markdownCode(entity.namespace || "（未声明）")}`,
    `- **类型编号**：${entity.typeId === undefined ? "无（抽象实体不生成 typeId）" : markdownCode(String(entity.typeId))}`,
    `- **父实体**：${entity.parent ? markdownCode(entity.parent) : "无"}`,
    `- **帧尾复制**：${entity.replicated ? "已启用，将生成 dirty mask 和强类型 Delta" : "未启用"}`,
    `- **持久化**：${entity.persistenceVersion === undefined ? "未声明" : `schema 版本 ${markdownCode(String(entity.persistenceVersion))}，生成严格 Codec 与 Repository 描述`}`,
    ...(entity.persistenceVersion === undefined ? [] : [`- **写法**：${describePersistenceWriteMode(entity)}`]),
    `- **字段**：本级 ${ownFieldCount} 个，继承 ${inheritedFieldCount} 个，共 ${flattenedFields.length} 个`,
    `- **存储布局**：显式热字段 ${hotFieldCount} 个，显式冷字段 ${coldFieldCount} 个${hotFieldCount + coldFieldCount > 0 ? "；codegen 将额外生成 Hot/Cold 候选布局" : "；保持默认布局"}`,
  ];
  if (flattenedFields.length > 0) {
    lines.push(`- **完整字段顺序**：${describeFieldOrder(flattenedFields)}`);
  }
  if (!entity.abstract) {
    lines.push("", "TS 侧持有 Native handle；实体数据实际保存在 Rust 侧。`typeId` 用于创建对应的 Rust 数据变体。");
    appendEntityUsageExample(lines, entity, api);
    if (entity.persistenceVersion !== undefined) {
      const persistenceFile = `Native${entity.name}Persistence`;
      lines.push(
        "",
        "**持久化使用示例**",
        "",
        "```ts",
        `import { CreateNative${entity.name}Repository } from "#generated/model/native/${persistenceFile}";`,
        "",
        `const repository = CreateNative${entity.name}Repository(process.name);`,
        `const loaded = await repository.Load(String(${toNativeCamelCase(entity.name)}.id));`,
        persistenceWriteExample(entity),
        "```",
        "",
        "`instanceId`等`@transient`字段不会进入快照；恢复后的Entity创建和生命周期仍由业务所有者负责。",
      );
    }
  } else {
    lines.push("", "抽象实体只生成 Rust 基础数据结构，不生成可独立创建的 TS handle。");
  }
  appendGeneratedSymbols(lines, projectNativeEntitySymbols(entity));
  if (showSource) lines.push("", `**声明文件**：${markdownCode(entity.sourceFile)}`);
  return lines.join("\n");
}

function describePersistenceWriteMode(entity: NativeEntityModel): string {
  switch (entity.persistenceWriteMode) {
    case "queued":
      return "`@queued`：只能排队写入；DBProxy `backlog.enqueueAck` 决定确认档位：默认 `aof` 等 Redis 本地 AOF 落盘，`memory` 只确认 Redis 内存，两者都不表示 PG 已提交。不能直接保存或加入事务；Redis 崩溃可能丢失 memory 档尚未落盘的已确认入队。测试用 memory 存储后端不提供持久性。";
    case "transactional":
      return "`@transactional`：只能通过事务写入；不生成单独保存方法";
    default: {
      const ordinary: undefined = entity.persistenceWriteMode;
      void ordinary;
      return "普通写入：可直接保存或加入事务，不能排队写入";
    }
  }
}

function persistenceWriteExample(entity: NativeEntityModel): string {
  const value = toNativeCamelCase(entity.name);
  const key = `String(${value}.id)`;
  switch (entity.persistenceWriteMode) {
    case "queued":
      return `await repository.Enqueue(${key}, ${value});`;
    case "transactional":
      return `await records.CommitRecords({ operationId, writes: [repository.TransactionWrite(${key}, ${value}, loaded?.revision ?? 0n)], result });`;
    default: {
      const ordinary: undefined = entity.persistenceWriteMode;
      void ordinary;
      return `const saved = await repository.Save(${key}, ${value}, loaded?.revision ?? 0n);`;
    }
  }
}

function describeFieldModel(entity: NativeEntityModel, field: NativeFieldModel, signature: string): string {
  const api = projectNativeEntityApi(index.getModel(), entity);
  const projectedField = api.fields.find(
    (entry) => entry.ownerName === entity.name && entry.name === field.name,
  );
  const fieldNumber = projectedField?.fieldId;
  const symbols = projectNativeFieldSymbols(entity, field);
  const rustMember = symbols.rust[0];
  const fieldConstant = symbols.rust[1];
  const tsProperty = symbols.typeScript[0];
  const lines = [
    `### 字段 ${markdownCode(field.name)}`,
    "",
    signature,
    "",
    `- **所属 Entity**：${markdownCode(entity.name)}`,
    `- **数据类型**：${markdownCode(field.type)}`,
    `- **可写性**：${field.readonly ? "只读，创建后不能通过通用 setter 修改" : "可读写"}`,
    `- **默认值**：${field.defaultValue === undefined ? "未声明" : markdownCode(field.defaultValue)}`,
    `- **字段编号**：${fieldNumber === undefined ? "无法计算" : markdownCode(String(fieldNumber))}${fieldConstant ? `（Rust 常量 ${markdownCode(fieldConstant)}）` : ""}`,
    `- **复制 MemberId**：${field.memberId === undefined ? "未参与固定字段脏同步" : `${markdownCode(String(field.memberId))}（dirty mask bit ${field.memberId}）`}`,
    `- **存储温度**：${field.storage === "hot" ? "热字段；高频批处理应只遍历 Hot Pool" : field.storage === "cold" ? "冷字段；不进入高频扫描工作集" : "默认；保持普通 Entity 布局"}`,
    `- **持久化**：${field.transient ? "运行时字段，不进入 Snapshot" : "默认进入声明了 @persistent 的 Entity Snapshot"}`,
    `- **Rust 实际成员**：${rustMember ? markdownCode(rustMember) : "未生成"}`,
  ];
  if (tsProperty && fieldNumber !== undefined) {
    const variableName = toNativeCamelCase(entity.name);
    lines.push(
      `- **TS 访问属性**：${markdownCode(tsProperty)}`,
      "",
      `TS 属性通过 \`NativeOps.EntityGetNumber(handle, ${fieldNumber})\`${field.readonly ? " 读取" : ` / \`EntitySetNumber(handle, ${fieldNumber}, value)\` 读写`}；字段编号只负责跨 V8 边界定位，数据仍保存在上面的 Rust 结构体成员中。`,
      "",
      "**字段使用示例**",
      "",
      "```ts",
      ...(field.readonly
        ? [`const ${field.name} = ${variableName}.${field.name};`]
        : [`${variableName}.${field.name} += 1;`, `const ${field.name} = ${variableName}.${field.name};`]),
      "```",
    );
  } else if (entity.abstract) {
    lines.push("", "该字段属于抽象实体；具体子实体会继承它，并在各自的 TS handle 中生成访问属性。");
  }
  appendGeneratedSymbols(lines, symbols);
  return lines.join("\n");
}

function describeOperationModel(operation: NativeOperationModel, showSource: boolean): string {
  const parameters = operation.params.map((parameter) => `${parameter.name}: ${parameter.type}`).join(", ");
  const symbols = projectNativeOperationSymbols(operation);
  const rustOperation = symbols.rust[0]!;
  const tsFacade = symbols.typeScript[0]!;
  const hostMethod = symbols.typeScript[1]!;
  const lines = [
    `### Native 操作 ${markdownCode(operation.name)}`,
    "",
    `\`op ${operation.name}(${parameters}): ${operation.returnType}\``,
    "",
    `- **命名空间**：${markdownCode(operation.namespace || "（未声明）")}`,
    `- **参数数量**：${operation.params.length}`,
    `- **返回类型**：${markdownCode(operation.returnType)}`,
    `- **TS 调用入口**：${markdownCode(tsFacade)}`,
    `- **Host 接口**：${markdownCode(hostMethod)}`,
    `- **Rust 函数**：${markdownCode(rustOperation)}`,
    "",
    `调用链：TS 业务代码 → ${markdownCode(tsFacade)} → ${markdownCode(hostMethod)} → ${markdownCode(rustOperation)}。`,
  ];
  appendGeneratedSymbols(lines, symbols);
  if (showSource) lines.push("", `**声明文件**：${markdownCode(operation.sourceFile)}`);
  return lines.join("\n");
}

function appendGeneratedSymbols(lines: string[], symbols: NativeGeneratedSymbols): void {
  lines.push("", "**生成符号**");
  if (symbols.rust.length > 0) lines.push(`- **Rust**：${symbols.rust.map(markdownCode).join(", ")}`);
  if (symbols.typeScript.length > 0) lines.push(`- **TypeScript**：${symbols.typeScript.map(markdownCode).join(", ")}`);
}

function appendEntityUsageExample(
  lines: string[],
  entity: NativeEntityModel,
  api: ReturnType<typeof projectNativeEntityApi>,
): void {
  const fields = api.fields;
  const refName = api.refName;
  const variableName = toNativeCamelCase(entity.name);
  const generatedFile = `app/generated/model/native/${api.fileName}`;
  const writableField = fields.find((field) => !field.readonly);
  lines.push(
    "",
    "**TypeScript 使用示例**",
    "",
    `生成文件：${markdownCode(generatedFile)}`,
    "",
    "下面的相对路径以 `app/demo/xxx` 目录中的业务文件为例；业务文件层级不同时只需调整 import 路径。",
    "",
    "```ts",
    `import { ${refName} } from \"../../generated/model/native/${refName}\";`,
    "",
    api.lifecycle === "component"
      ? `const ${variableName} = owner.AddComponent(${refName}, {`
      : `const ${variableName} = ${refName}.Create({`,
    ...fields.map((field) => {
      const comment = field.defaultValue === undefined ? "" : ` // 可省略，默认 ${field.defaultValue}`;
      return `  ${field.name}: ${exampleFieldValue(field)},${comment}`;
    }),
    "});",
  );
  if (writableField) {
    lines.push(
      "",
      `${variableName}.${writableField.name} += 1;`,
      `const ${writableField.name} = ${variableName}.${writableField.name};`,
    );
  } else if (fields[0]) {
    lines.push("", `const ${fields[0].name} = ${variableName}.${fields[0].name};`);
  }
  if (api.lifecycle === "component") {
    lines.push(
      "",
      `const same${entity.name} = owner.GetComponent(${refName});`,
      `owner.RemoveComponent(${refName});`,
      "```",
      "",
      "该类型标有 `@component`，Native handle 的创建和销毁由父 Entity 的 Component 生命周期管理；业务代码不直接调用 `Create()` 或 `Dispose()`。",
    );
  } else {
    lines.push("", `${variableName}.Dispose();`, "```");
  }
}

function exampleFieldValue(field: Pick<NativeProjectedEntityField, "name" | "defaultValue">): string {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.name === "id" || field.name === "instanceId") return "1";
  return "0";
}

function describeFieldOrder(fields: readonly NativeProjectedEntityField[]): string {
  const limit = 12;
  const visible = fields.slice(0, limit).map((field) => `${field.fieldId}. ${markdownCode(field.name)}`);
  if (fields.length > limit) visible.push(`……另有 ${fields.length - limit} 个`);
  return visible.join("，");
}

function markdownCode(value: string): string {
  return `\`${value}\``;
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

function findEntityAt(document: NativeDocument, offset: number): EntityDeclarationNode | undefined {
  return document.declarations.find(
    (declaration): declaration is EntityDeclarationNode => declaration.kind === "entity"
      && containsOffset(declaration.name.range, offset),
  );
}

function toDocumentSymbol(declaration: DeclarationNode): DocumentSymbol {
  if (declaration.kind === "entity") {
    return {
      name: declaration.name.name,
      detail: declaration.parent ? `继承 ${declaration.parent.name}` : declaration.abstract ? "抽象实体" : "实体",
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
    detail: `返回 ${declaration.returnType.name}`,
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

function normalizeSourceRootUris(value: unknown): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value.sourceRootUris)) return [];
  return [...new Set(value.sourceRootUris
    .filter((uri): uri is string => typeof uri === "string" && uri.startsWith("file:"))
    .map((uri) => normalizeUri(uri).replace(/\/+$/, "")))];
}

function shouldIndexUri(uri: string): boolean {
  if (!uri.startsWith("file:") || sourceRootUris.length === 0) return true;
  const candidate = normalizeUri(uri);
  return sourceRootUris.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

function normalizeUri(uri: string): string {
  return process.platform === "win32" ? uri.toLowerCase() : uri;
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
