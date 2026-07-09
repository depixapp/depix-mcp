// Small typed accessors for reading loosely-typed API JSON without `any`.

export function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
export function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function stringArray(value: unknown): string[] {
  return arr(value).filter((v): v is string => typeof v === "string");
}
