import { AppError } from "./errors";

const textEncoder = new TextEncoder();

export type Bytes = Uint8Array<ArrayBuffer>;

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function utf8(value: string): Bytes {
  return textEncoder.encode(value);
}

export function bytesToHex(bytes: Bytes): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

export function hexToBytes(value: string): Bytes {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    throw new AppError("signature_invalid", "Invalid hexadecimal value", 401);
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

export function concatBytes(...parts: Bytes[]): Bytes {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export async function readJsonObject(request: Request, maxBytes = 1_048_576): Promise<{
  raw: Bytes;
  value: Record<string, unknown>;
}> {
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AppError("payload_too_large", "Request body is too large", 413);
  }

  const rawBuffer = await request.arrayBuffer();
  if (rawBuffer.byteLength > maxBytes) {
    throw new AppError("payload_too_large", "Request body is too large", 413);
  }

  const raw = new Uint8Array(rawBuffer);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new AppError("invalid_request", "Request body is not valid JSON", 400);
  }

  const value = asRecord(parsed);
  if (value === null) {
    throw new AppError("invalid_request", "Request body must be a JSON object", 400);
  }
  return { raw, value };
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function truncateText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
