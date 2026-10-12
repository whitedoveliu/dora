/** Error taxonomy. Every failure carries a stable code so callers and tests can assert on it. */

export type DoraErrorCode =
  | 'config_error'
  | 'not_found'
  | 'invalid_argument'
  | 'access_denied'
  | 'help_gate_blocked'
  | 'bash_blocked'
  | 'timeout'
  | 'connector_unavailable'
  | 'vault_locked'
  | 'model_error'
  | 'budget_exhausted'
  | 'lease_conflict'
  | 'internal_error';

export class DoraError extends Error {
  readonly code: DoraErrorCode;
  readonly details: Record<string, unknown>;
  readonly exitCode: number;

  constructor(code: DoraErrorCode, message: string, options: { details?: Record<string, unknown>; exitCode?: number } = {}) {
    super(message);
    this.name = 'DoraError';
    this.code = code;
    this.details = options.details ?? {};
    this.exitCode = options.exitCode ?? 1;
  }
}

export class AccessDeniedError extends DoraError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('access_denied', message, { details, exitCode: 4 });
    this.name = 'AccessDeniedError';
  }
}

/** The help gate: exit code 3, help pages attached, callable next turn. */
export class HelpGateBlockedError extends DoraError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('help_gate_blocked', message, { details, exitCode: 3 });
    this.name = 'HelpGateBlockedError';
  }
}

export class BashBlockedError extends DoraError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('bash_blocked', message, { details, exitCode: 2 });
    this.name = 'BashBlockedError';
  }
}

export function isDoraError(err: unknown): err is DoraError {
  return err instanceof DoraError;
}

export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' ? err : JSON.stringify(err));
}
