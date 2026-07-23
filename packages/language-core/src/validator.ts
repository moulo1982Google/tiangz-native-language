import { parseNativeDocument } from "./parser.js";
import type {
  AnnotationNode,
  EntityDeclarationNode,
  FieldDeclarationNode,
  NativeDiagnostic,
  NativeDocument,
  NativeEntityModel,
  NativeOperationModel,
  NativeSemanticModel,
  NativeSource,
  NativeWorkspaceAnalysis,
  OperationDeclarationNode,
  SourceRange,
} from "./types.js";

const ENTITY_FIELD_TYPES = new Set(["u32", "i32", "i8", "f32"]);
const OP_PARAMETER_TYPES = new Set(["u32", "i32", "i8", "f64", "bool", "bytes", "f64[]"]);
const OP_RETURN_TYPES = new Set(["u32", "i32", "i8", "f64", "bool", "bytes", "void"]);

interface EntityEntry {
  readonly document: NativeDocument;
  readonly node: EntityDeclarationNode;
}

interface OperationEntry {
  readonly document: NativeDocument;
  readonly node: OperationDeclarationNode;
}

export function analyzeNativeWorkspace(sources: readonly NativeSource[]): NativeWorkspaceAnalysis {
  const documents = sources.map((source) => parseNativeDocument(source.text, source.uri));
  return analyzeNativeDocuments(documents);
}

export function analyzeNativeDocuments(documents: readonly NativeDocument[]): NativeWorkspaceAnalysis {
  const diagnostics: NativeDiagnostic[] = documents.flatMap((document) => [...document.diagnostics]);
  const entities: EntityEntry[] = [];
  const operations: OperationEntry[] = [];
  for (const document of documents) {
    for (const declaration of document.declarations) {
      if (declaration.kind === "entity") entities.push({ document, node: declaration });
      else operations.push({ document, node: declaration });
    }
  }

  const entityByName = validateEntities(entities, diagnostics);
  validateOperations(operations, diagnostics);
  validateInheritance(entities, entityByName, diagnostics);
  validateEntityRoot(documents, entityByName, diagnostics);

  const model: NativeSemanticModel = {
    entities: entities.map(toEntityModel),
    operations: operations.map(toOperationModel),
  };
  diagnostics.sort(compareDiagnostics);
  return { documents, model, diagnostics };
}

export function assertValidNativeWorkspace(sources: readonly NativeSource[]): NativeSemanticModel {
  const analysis = analyzeNativeWorkspace(sources);
  if (analysis.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new NativeLanguageError(analysis.diagnostics);
  }
  return analysis.model;
}

export function assertValidNativeDocuments(documents: readonly NativeDocument[]): NativeSemanticModel {
  const analysis = analyzeNativeDocuments(documents);
  if (analysis.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new NativeLanguageError(analysis.diagnostics);
  }
  return analysis.model;
}

export class NativeLanguageError extends Error {
  public constructor(public readonly diagnostics: readonly NativeDiagnostic[]) {
    super(formatNativeDiagnostics(diagnostics));
    this.name = "NativeLanguageError";
  }
}

export function formatNativeDiagnostics(diagnostics: readonly NativeDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const position = diagnostic.range.start;
      return `${diagnostic.uri}:${position.line + 1}:${position.character + 1} ${diagnostic.code}: ${diagnostic.message}`;
    })
    .join("\n");
}

function validateEntities(
  entities: readonly EntityEntry[],
  diagnostics: NativeDiagnostic[],
): Map<string, EntityEntry> {
  const entityByName = new Map<string, EntityEntry>();
  const entityByTypeId = new Map<number, EntityEntry>();
  for (const entry of entities) {
    const { document, node } = entry;
    if (node.name.name) {
      const previous = entityByName.get(node.name.name);
      if (previous) {
        report(
          diagnostics,
          document.uri,
          "native.semantic.duplicate-entity",
          `Entity ${node.name.name} 已在 ${previous.document.uri} 中声明`,
          node.name.range,
        );
      } else {
        entityByName.set(node.name.name, entry);
      }
    }

    validateEntityAnnotations(entry, diagnostics);
    validateEntityFields(entry, diagnostics);
    const typeId = readTypeId(node);
    const hasTypeId = hasAnnotation(node, "typeId");
    if (node.abstract) {
      if (hasTypeId) {
        report(diagnostics, document.uri, "native.semantic.abstract-type-id", "抽象 Entity 不能声明 @typeId", annotationRange(node, "typeId"));
      }
      if (hasAnnotation(node, "component")) {
        report(diagnostics, document.uri, "native.semantic.abstract-component", "抽象 Entity 不能标记为 @component", annotationRange(node, "component"));
      }
    } else if (!hasTypeId) {
      report(diagnostics, document.uri, "native.semantic.type-id-required", `具体 Entity ${node.name.name} 必须声明 @typeId(1..65535)`, node.name.range);
    } else if (typeId !== undefined && typeId >= 1 && typeId <= 0xffff) {
      const previous = entityByTypeId.get(typeId);
      if (previous) {
        report(
          diagnostics,
          document.uri,
          "native.semantic.duplicate-type-id",
          `@typeId(${typeId}) 已被 ${previous.node.name.name} 使用`,
          annotationRange(node, "typeId"),
        );
      } else {
        entityByTypeId.set(typeId, entry);
      }
    }
  }
  return entityByName;
}

function validateEntityAnnotations(entry: EntityEntry, diagnostics: NativeDiagnostic[]): void {
  const seen = new Map<string, AnnotationNode>();
  for (const annotation of entry.node.annotations) {
    const name = annotation.name.name;
    const previous = seen.get(name);
    if (previous) {
      report(diagnostics, entry.document.uri, "native.semantic.duplicate-annotation", `重复的 @${name} 注解`, annotation.range);
    } else {
      seen.set(name, annotation);
    }
    if (name === "typeId") {
      if (annotation.arguments.length !== 1 || !Number.isSafeInteger(annotation.arguments[0]?.value)) {
        report(diagnostics, entry.document.uri, "native.semantic.invalid-type-id", "@typeId 必须且只能包含一个整数参数", annotation.range);
        continue;
      }
      const value = annotation.arguments[0]!.value;
      if (value < 1 || value > 0xffff) {
        report(diagnostics, entry.document.uri, "native.semantic.type-id-range", "@typeId 必须在 1 到 65535 之间", annotation.arguments[0]!.range);
      }
    } else if (name === "component") {
      if (annotation.arguments.length !== 0) {
        report(diagnostics, entry.document.uri, "native.semantic.component-arguments", "@component 不接受参数", annotation.range);
      }
    } else if (name) {
      report(diagnostics, entry.document.uri, "native.semantic.unknown-annotation", `未知注解 @${name}`, annotation.name.range);
    }
  }
}

function validateEntityFields(entry: EntityEntry, diagnostics: NativeDiagnostic[]): void {
  const names = new Set<string>();
  for (const field of entry.node.fields) {
    if (field.name.name && names.has(field.name.name)) {
      report(diagnostics, entry.document.uri, "native.semantic.duplicate-field", `字段 ${field.name.name} 重复声明`, field.name.range);
    }
    names.add(field.name.name);
    if (!ENTITY_FIELD_TYPES.has(field.type.name)) {
      report(diagnostics, entry.document.uri, "native.semantic.invalid-field-type", `不支持的 Entity 字段类型 ${field.type.name}`, field.type.range);
      continue;
    }
    if (field.defaultValue) validateDefaultValue(entry.document.uri, field, diagnostics);
  }
}

function validateDefaultValue(uri: string, field: FieldDeclarationNode, diagnostics: NativeDiagnostic[]): void {
  const literal = field.defaultValue!;
  const value = literal.value;
  if (!Number.isFinite(value)) {
    report(diagnostics, uri, "native.semantic.non-finite-default", `字段 ${field.name.name} 的默认值必须是有限数值`, literal.range);
    return;
  }
  if (field.type.name === "f32") {
    if (Math.abs(value) > 3.4028234663852886e38) {
      report(diagnostics, uri, "native.semantic.f32-range", `字段 ${field.name.name} 的默认值超出 f32 范围`, literal.range);
    }
    return;
  }
  if (!Number.isInteger(value)) {
    report(diagnostics, uri, "native.semantic.integer-default", `字段 ${field.name.name} 的默认值必须是整数`, literal.range);
    return;
  }
  const ranges: Readonly<Record<string, readonly [number, number]>> = {
    u32: [0, 0xffff_ffff],
    i32: [-0x8000_0000, 0x7fff_ffff],
    i8: [-128, 127],
  };
  const range = ranges[field.type.name];
  if (range && (value < range[0] || value > range[1])) {
    report(diagnostics, uri, "native.semantic.integer-range", `字段 ${field.name.name} 的默认值超出 ${field.type.name} 范围`, literal.range);
  }
}

function validateOperations(operations: readonly OperationEntry[], diagnostics: NativeDiagnostic[]): void {
  const byName = new Map<string, OperationEntry>();
  for (const entry of operations) {
    const { document, node } = entry;
    if (node.name.name) {
      const previous = byName.get(node.name.name);
      if (previous) {
        report(
          diagnostics,
          document.uri,
          "native.semantic.duplicate-operation",
          `Native op ${node.name.name} 已在 ${previous.document.uri} 中声明`,
          node.name.range,
        );
      } else {
        byName.set(node.name.name, entry);
      }
    }
    const parameterNames = new Set<string>();
    for (const parameter of node.parameters) {
      if (parameter.name.name && parameterNames.has(parameter.name.name)) {
        report(diagnostics, document.uri, "native.semantic.duplicate-parameter", `参数 ${parameter.name.name} 重复声明`, parameter.name.range);
      }
      parameterNames.add(parameter.name.name);
      if (!OP_PARAMETER_TYPES.has(parameter.type.name)) {
        report(diagnostics, document.uri, "native.semantic.invalid-parameter-type", `Native op 不支持参数类型 ${parameter.type.name}`, parameter.type.range);
      }
    }
    if (!OP_RETURN_TYPES.has(node.returnType.name)) {
      report(diagnostics, document.uri, "native.semantic.invalid-return-type", `Native op 不支持返回类型 ${node.returnType.name}`, node.returnType.range);
    }
  }
}

function validateInheritance(
  entities: readonly EntityEntry[],
  entityByName: ReadonlyMap<string, EntityEntry>,
  diagnostics: NativeDiagnostic[],
): void {
  const states = new Map<string, "visiting" | "visited">();
  const visit = (entry: EntityEntry): void => {
    const name = entry.node.name.name;
    if (!name || states.get(name) === "visited") return;
    if (states.get(name) === "visiting") return;
    states.set(name, "visiting");
    const parentName = entry.node.parent?.name;
    if (parentName) {
      const parent = entityByName.get(parentName);
      if (!parent) {
        report(diagnostics, entry.document.uri, "native.semantic.unknown-parent", `找不到父 Entity ${parentName}`, entry.node.parent!.range);
      } else if (states.get(parentName) === "visiting") {
        report(diagnostics, entry.document.uri, "native.semantic.inheritance-cycle", `继承链在 ${parentName} 处形成循环`, entry.node.parent!.range);
      } else {
        visit(parent);
      }
    }
    states.set(name, "visited");
  };
  for (const entity of entities) visit(entity);

  for (const entry of entities) {
    if (!entry.node.abstract && entry.node.name.name !== "Entity" && !inheritsFrom(entry, "Entity", entityByName)) {
      report(diagnostics, entry.document.uri, "native.semantic.entity-base", `具体 Entity ${entry.node.name.name} 必须继承 Entity`, entry.node.name.range);
    }
    validateInheritedFields(entry, entityByName, diagnostics);
  }
}

function validateInheritedFields(
  entry: EntityEntry,
  entityByName: ReadonlyMap<string, EntityEntry>,
  diagnostics: NativeDiagnostic[],
): void {
  const ancestors: EntityEntry[] = [];
  const visited = new Set<string>();
  let parentName = entry.node.parent?.name;
  while (parentName && !visited.has(parentName)) {
    visited.add(parentName);
    const parent = entityByName.get(parentName);
    if (!parent) break;
    ancestors.unshift(parent);
    parentName = parent.node.parent?.name;
  }
  const names = new Set<string>();
  for (const ancestor of ancestors) {
    for (const field of ancestor.node.fields) names.add(field.name.name);
  }
  for (const field of entry.node.fields) {
    if (names.has(field.name.name)) {
      report(diagnostics, entry.document.uri, "native.semantic.inherited-field", `字段 ${field.name.name} 与继承字段重名`, field.name.range);
    }
    names.add(field.name.name);
  }
}

function validateEntityRoot(
  documents: readonly NativeDocument[],
  entityByName: ReadonlyMap<string, EntityEntry>,
  diagnostics: NativeDiagnostic[],
): void {
  const root = entityByName.get("Entity");
  if (!root) {
    const document = documents[0];
    if (document) report(diagnostics, document.uri, "native.semantic.entity-root-required", "Native schema 必须包含抽象根实体 Entity", firstRange(document));
    return;
  }
  if (!root.node.abstract) {
    report(diagnostics, root.document.uri, "native.semantic.entity-root-abstract", "根实体 Entity 必须声明为 abstract", root.node.name.range);
  }
  for (const requiredName of ["id", "instanceId"]) {
    const field = root.node.fields.find((candidate) => candidate.name.name === requiredName);
    if (!field || field.type.name !== "u32" || !field.readonly) {
      report(diagnostics, root.document.uri, "native.semantic.entity-root-field", `Entity.${requiredName} 必须是 readonly u32`, field?.range ?? root.node.range);
    }
  }
}

function inheritsFrom(
  entry: EntityEntry,
  ancestorName: string,
  entityByName: ReadonlyMap<string, EntityEntry>,
): boolean {
  const visited = new Set<string>();
  let currentName = entry.node.parent?.name;
  while (currentName && !visited.has(currentName)) {
    if (currentName === ancestorName) return true;
    visited.add(currentName);
    currentName = entityByName.get(currentName)?.node.parent?.name;
  }
  return false;
}

function toEntityModel(entry: EntityEntry): NativeEntityModel {
  const namespace = entry.document.namespace?.name.name ?? "";
  const typeId = readTypeId(entry.node);
  return {
    namespace,
    sourceFile: entry.document.uri,
    ...(typeId !== undefined ? { typeId } : {}),
    component: hasAnnotation(entry.node, "component"),
    abstract: entry.node.abstract,
    name: entry.node.name.name,
    ...(entry.node.parent ? { parent: entry.node.parent.name } : {}),
    fields: entry.node.fields.map((field) => ({
      readonly: field.readonly,
      name: field.name.name,
      type: field.type.name,
      ...(field.defaultValue ? { defaultValue: field.defaultValue.raw } : {}),
      range: field.range,
    })),
    range: entry.node.range,
  };
}

function toOperationModel(entry: OperationEntry): NativeOperationModel {
  return {
    namespace: entry.document.namespace?.name.name ?? "",
    sourceFile: entry.document.uri,
    name: entry.node.name.name,
    params: entry.node.parameters.map((parameter) => ({
      name: parameter.name.name,
      type: parameter.type.name,
      range: parameter.range,
    })),
    returnType: entry.node.returnType.name,
    range: entry.node.range,
  };
}

function hasAnnotation(node: EntityDeclarationNode, name: string): boolean {
  return node.annotations.some((annotation) => annotation.name.name === name);
}

function annotationRange(node: EntityDeclarationNode, name: string): SourceRange {
  return node.annotations.find((annotation) => annotation.name.name === name)?.range ?? node.name.range;
}

function readTypeId(node: EntityDeclarationNode): number | undefined {
  const annotation = node.annotations.find((candidate) => candidate.name.name === "typeId");
  const value = annotation?.arguments[0]?.value;
  return Number.isSafeInteger(value) ? value : undefined;
}

function firstRange(document: NativeDocument): SourceRange {
  return document.namespace?.range ?? document.declarations[0]?.range ?? {
    start: { offset: 0, line: 0, character: 0 },
    end: { offset: 0, line: 0, character: 0 },
  };
}

function report(
  diagnostics: NativeDiagnostic[],
  uri: string,
  code: string,
  message: string,
  range: SourceRange,
): void {
  diagnostics.push({ uri, code, severity: "error", message, range });
}

function compareDiagnostics(left: NativeDiagnostic, right: NativeDiagnostic): number {
  return left.uri.localeCompare(right.uri, "en")
    || left.range.start.offset - right.range.start.offset
    || left.code.localeCompare(right.code, "en");
}
