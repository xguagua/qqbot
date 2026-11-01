export type ErrorCode =
  | "configuration"
  | "invalid_request"
  | "payload_too_large"
  | "signature_invalid"
  | "appid_mismatch"
  | "storage_unavailable"
  | "rate_limited"
  | "budget_exhausted"
  | "upstream_unavailable"
  | "upstream_timeout"
  | "response_empty"
  | "qq_business_error"
  | "attachment_invalid"
  | "attachment_too_large"
  | "attachment_unavailable"
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

export class DeepSeekError extends AppError {
  readonly retryable: boolean;
  readonly requestMayBeBillable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; requestMayBeBillable?: boolean } = {},
  ) {
    super(code, message, 502);
    this.name = "DeepSeekError";
    this.retryable = options.retryable ?? false;
    this.requestMayBeBillable = options.requestMayBeBillable ?? false;
  }
}

export function errorCode(error: unknown): ErrorCode {
  return error instanceof AppError ? error.code : "internal";
}

export function errorDiagnostic(error: unknown): string | undefined {
  return error instanceof AppError ? error.diagnosticCode : undefined;
}
