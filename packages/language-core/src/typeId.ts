export const MIN_NATIVE_TYPE_ID = 1;
export const MAX_NATIVE_TYPE_ID = 0xffff;

export type NextTypeIdResult =
  | Readonly<{ status: "available"; typeId: number }>
  | Readonly<{ status: "duplicate"; duplicateTypeIds: readonly number[] }>
  | Readonly<{ status: "exhausted" }>;

export function findNextAvailableTypeId(typeIds: Iterable<number | undefined>): NextTypeIdResult {
  const counts = new Uint8Array(MAX_NATIVE_TYPE_ID + 1);
  for (const typeId of typeIds) {
    if (typeId === undefined || !Number.isInteger(typeId) || typeId < MIN_NATIVE_TYPE_ID || typeId > MAX_NATIVE_TYPE_ID) {
      continue;
    }
    if (counts[typeId]! < 2) counts[typeId] = counts[typeId]! + 1;
  }

  const duplicateTypeIds: number[] = [];
  for (let typeId = MIN_NATIVE_TYPE_ID; typeId <= MAX_NATIVE_TYPE_ID; typeId += 1) {
    if (counts[typeId]! > 1) duplicateTypeIds.push(typeId);
  }
  if (duplicateTypeIds.length > 0) return { status: "duplicate", duplicateTypeIds };

  for (let typeId = MIN_NATIVE_TYPE_ID; typeId <= MAX_NATIVE_TYPE_ID; typeId += 1) {
    if (counts[typeId] === 0) return { status: "available", typeId };
  }
  return { status: "exhausted" };
}
