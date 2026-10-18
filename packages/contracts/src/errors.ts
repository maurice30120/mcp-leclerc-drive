/**
 * Normalized tool error taxonomy.
 *
 * Every capability execution — the real Leclerc adapter in Chrome and the
 * deterministic mocks in the Node harness — resolves to either a structured
 * success output or a {@link ToolError} carrying one of these codes. Raw
 * exceptions never cross the capability boundary.
 */

/**
 * The seven injectable fault families required by the harness (issue #42),
 * plus the orchestration-level codes produced by the agent itself.
 */
export const TOOL_ERROR_CODES = [
  // Injectable fault families (mock + real adapter parity)
  "PRODUCT_NOT_FOUND",
  "PRODUCT_UNAVAILABLE",
  "CART_MUTATION_REFUSED",
  "INVALID_ID",
  "SESSION_EXPIRED",
  "EMPTY_RESULT",
  "TRANSIENT_ERROR",
  // Orchestration-level codes
  "INVALID_INPUT",
  "UNKNOWN_CAPABILITY",
  "CAPABILITY_FAILED",
  "APPROVAL_REQUIRED",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** Codes a scenario may inject at tool level (the seven fault families). */
export const FAULT_CODES = [
  "PRODUCT_NOT_FOUND",
  "PRODUCT_UNAVAILABLE",
  "CART_MUTATION_REFUSED",
  "INVALID_ID",
  "SESSION_EXPIRED",
  "EMPTY_RESULT",
  "TRANSIENT_ERROR",
] as const;

export type FaultCode = (typeof FAULT_CODES)[number];

/** Errors that a retry of the same call could plausibly resolve. */
const RETRYABLE_CODES: ReadonlySet<ToolErrorCode> = new Set([
  "TRANSIENT_ERROR",
  "SESSION_EXPIRED",
]);

/** Normalized, serializable tool error. */
export interface ToolError {
  ok: false;
  code: ToolErrorCode;
  /** Human-readable French message, safe to show to the user. */
  message: string;
  /** True when a later retry of the same call could succeed. */
  retryable: boolean;
  /** Optional structured details (never secrets, never raw exceptions). */
  details?: Record<string, unknown>;
}

/** Structured success wrapper used across the capability boundary. */
export interface ToolOk<T> {
  ok: true;
  output: T;
}

export type ToolResult<T> = ToolOk<T> | ToolError;

export function toolError(
  code: ToolErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ToolError {
  return {
    ok: false,
    code,
    message,
    retryable: RETRYABLE_CODES.has(code),
    ...(details ? { details } : {}),
  };
}

export function isToolError(v: unknown): v is ToolError {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { ok?: unknown }).ok === false &&
    TOOL_ERROR_CODES.includes((v as { code?: unknown }).code as ToolErrorCode)
  );
}

/** Wrap an unexpected exception into a normalized CAPABILITY_FAILED error. */
export function toToolError(err: unknown, capability: string): ToolError {
  if (isToolError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return toolError(
    "CAPABILITY_FAILED",
    `Capacité ${capability} : échec inattendu (${message}).`,
  );
}
