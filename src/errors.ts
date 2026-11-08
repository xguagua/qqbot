export type ErrorCode =
  | "configuration"
  | "invalid_request"
  | "payload_too_large"
  | "signature_invalid"
  | "appid_mismatch"
  | "storage_unavailable"
  | "upstream_unavailable"
  | "qq_business_error"
  | "reply_window_expired"
  | "internal";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly diagnosticCode: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    status = 500,
    diagnosticCode?: string,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.diagnosticCode = diagnosticCode;
  }
}

export function errorCode(error: unknown): ErrorCode {
  return error instanceof AppError ? error.code : "internal";
}

export function errorDiagnostic(error: unknown): string | undefined {
  return error instanceof AppError ? error.diagnosticCode : undefined;
}
