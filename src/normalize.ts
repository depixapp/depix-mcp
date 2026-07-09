// Normalization of the heterogeneous API envelopes into stable tool shapes
// (spec §4.0, "Normalização"). Unwraps { checkout } / { product } wrappers,
// collapses is_live/is_test (boolean | SQLite int 0/1 | inverted is_test) into a
// single boolean, tolerantly parses metadata (object | JSON string | null), and
// derives has_more exactly from the API's filter-wide `stats.total`.

/**
 * Normalize a live/test flag to a single boolean.
 * Rule (spec §4.0): is_live = (is_live === true || is_live === 1); when only
 * is_test is present, is_live = !(is_test === true || is_test === 1).
 */
export function normalizeIsLive(raw: {
  is_live?: unknown;
  is_test?: unknown;
}): boolean {
  if (raw.is_live !== undefined && raw.is_live !== null) {
    return raw.is_live === true || raw.is_live === 1;
  }
  if (raw.is_test !== undefined && raw.is_test !== null) {
    return !(raw.is_test === true || raw.is_test === 1);
  }
  // Absent both: default to non-live (safer — treat unknown as sandbox).
  return false;
}

/** Normalize an SQLite-style 0/1-or-boolean flag to boolean. */
export function normalizeBool(value: unknown): boolean {
  return value === true || value === 1;
}

/**
 * Parse metadata tolerantly. Object → object; valid JSON string → parsed value;
 * unparseable string → the raw string (no data loss); null/undefined → null.
 */
export function parseMetadata(value: unknown): Record<string, unknown> | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
      return value;
    } catch {
      return value;
    }
  }
  return null;
}

/** Unwrap a single-key envelope like { checkout: {...} } → {...}. */
export function unwrap<T = Record<string, unknown>>(
  body: unknown,
  key: string,
): T {
  if (body && typeof body === "object" && key in (body as Record<string, unknown>)) {
    return (body as Record<string, unknown>)[key] as T;
  }
  return body as T;
}

/**
 * Derive has_more EXACTLY from a filter-wide total (spec §4.1): the naive
 * `page.length === limit` over-reports on a full last page when total is an
 * exact multiple of limit, costing the agent an extra empty fetch.
 */
export function deriveHasMore(offset: number, pageLength: number, total: number): boolean {
  return offset + pageLength < total;
}

/** Whether a status is terminal, given the canonical terminal set. */
export function isTerminal(status: string, terminalSet: readonly string[]): boolean {
  return terminalSet.includes(status);
}
