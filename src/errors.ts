export type VgcErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_TEAM'
  | 'INVALID_REPLAY'
  | 'WRONG_FORMAT'
  | 'NOT_FOUND'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_SCHEMA_CHANGED'
  | 'CALCULATION_FAILED'
  | 'STORAGE_ERROR'
  | 'CONFIGURATION_ERROR';

export class VgcError extends Error {
  readonly code: VgcErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: VgcErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VgcError';
    this.code = code;
    if (details) this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toErrorPayload(error: unknown) {
  if (error instanceof VgcError) {
    return {
      ok: false as const,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }

  return {
    ok: false as const,
    error: {
      code: 'INVALID_INPUT' as const,
      message: errorMessage(error),
    },
  };
}
