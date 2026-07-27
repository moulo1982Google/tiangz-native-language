import type {
  NativeEntityModel,
  NativeFieldModel,
  NativeOperationModel,
  NativeSemanticModel,
} from "./types.js";

export interface NativeGeneratedSymbols {
  readonly rust: readonly string[];
  readonly typeScript: readonly string[];
}

export interface NativeProjectedEntityField {
  readonly ownerName: string;
  readonly name: string;
  readonly type: NativeFieldModel["type"];
  readonly readonly: boolean;
  readonly defaultValue?: string;
  readonly memberId?: number;
  readonly storage: NativeFieldModel["storage"];
  readonly fieldId: number;
  readonly rustPath: readonly string[];
  readonly rustFieldConstant: string;
  readonly typeScriptProperty: string;
  readonly typeScriptFieldConstant?: string;
}

export interface NativeEntityApiProjection {
  readonly entityName: string;
  readonly refName: string;
  readonly createArgsName: string;
  readonly fieldTableName: string;
  readonly fileName: string;
  readonly lifecycle: "component" | "handle";
  readonly fields: readonly NativeProjectedEntityField[];
}

export function projectNativeEntityApi(
  model: Pick<NativeSemanticModel, "entities">,
  entity: NativeEntityModel,
): NativeEntityApiProjection {
  const fields = flattenProjectedFields(model.entities, entity).map((field, index) => ({
    ...field,
    fieldId: index + 1,
    rustFieldConstant: `${toNativeScreamingSnakeCase(entity.name)}_FIELD_${toNativeScreamingSnakeCase(field.name)}`,
    typeScriptProperty: `Native${entity.name}Ref.${field.name}`,
    ...(field.ownerName === entity.name
      ? { typeScriptFieldConstant: `Native${entity.name}Field.${toNativePascalCase(field.name)}` }
      : {}),
  }));
  return {
    entityName: entity.name,
    refName: `Native${entity.name}Ref`,
    createArgsName: `Native${entity.name}CreateArgs`,
    fieldTableName: `Native${entity.name}Field`,
    fileName: `Native${entity.name}Ref.ts`,
    lifecycle: entity.component ? "component" : "handle",
    fields,
  };
}

function flattenProjectedFields(
  entities: readonly NativeEntityModel[],
  entity: NativeEntityModel,
  visited = new Set<string>(),
): Array<Omit<NativeProjectedEntityField, "fieldId" | "rustFieldConstant" | "typeScriptProperty" | "typeScriptFieldConstant">> {
  if (visited.has(entity.name)) return [];
  visited.add(entity.name);
  const parent = entity.parent
    ? entities.find((candidate) => candidate.name === entity.parent)
    : undefined;
  const inherited = parent
    ? flattenProjectedFields(entities, parent, visited).map((field) => ({
        ...field,
        rustPath: [toNativeSnakeCase(parent.name), ...field.rustPath],
      }))
    : [];
  return [
    ...inherited,
    ...entity.fields.map((field) => ({
      ownerName: entity.name,
      name: field.name,
      type: field.type,
      readonly: field.readonly,
      ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
      ...(field.memberId !== undefined ? { memberId: field.memberId } : {}),
      storage: field.storage,
      rustPath: [toNativeSnakeCase(field.name)],
    })),
  ];
}

export function projectNativeEntitySymbols(
  entity: Pick<NativeEntityModel, "name" | "abstract">,
): NativeGeneratedSymbols {
  const snakeName = toNativeSnakeCase(entity.name);
  const rust = [`${entity.name}Data`];
  const typeScript: string[] = [];
  if (!entity.abstract) {
    rust.push(
      `NativeEntityData::${entity.name}`,
      `ENTITY_TYPE_${toNativeScreamingSnakeCase(entity.name)}`,
      `get_${snakeName}_number`,
      `set_${snakeName}_number`,
    );
    typeScript.push(
      `Native${entity.name}Ref`,
      `Native${entity.name}CreateArgs`,
      `Native${entity.name}Field`,
      `Native${entity.name}Ref.ts`,
    );
  }
  return { rust, typeScript };
}

export function projectNativeFieldSymbols(
  entity: Pick<NativeEntityModel, "name" | "abstract">,
  field: Pick<NativeFieldModel, "name">,
): NativeGeneratedSymbols {
  const rust = [`${entity.name}Data.${toNativeSnakeCase(field.name)}`];
  const typeScript: string[] = [];
  if (!entity.abstract) {
    rust.push(`${toNativeScreamingSnakeCase(entity.name)}_FIELD_${toNativeScreamingSnakeCase(field.name)}`);
    typeScript.push(
      `Native${entity.name}Ref.${field.name}`,
      `Native${entity.name}Field.${toNativePascalCase(field.name)}`,
    );
  }
  return { rust, typeScript };
}

export function projectNativeOperationSymbols(
  operation: Pick<NativeOperationModel, "name">,
): NativeGeneratedSymbols {
  const hostMethod = toNativeCamelCase(operation.name);
  return {
    rust: [nativeRustOperationName(operation.name)],
    typeScript: [`NativeOps.${operation.name}`, `NativeHostOpsApi.${hostMethod}`],
  };
}

export function nativeRustOperationName(name: string): string {
  return `op_native_${toNativeSnakeCase(name)}`;
}

export function toNativeSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function toNativeScreamingSnakeCase(value: string): string {
  return toNativeSnakeCase(value).toUpperCase();
}

export function toNativePascalCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function toNativeCamelCase(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
