import type { NativeEntityModel, NativeFieldModel, NativeOperationModel } from "./types.js";

export interface NativeGeneratedSymbols {
  readonly rust: readonly string[];
  readonly typeScript: readonly string[];
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
