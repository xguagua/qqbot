import {
  ATTACHMENT_TIMEOUT_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILES,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "../config";
import { AppError } from "../errors";
import type { QQAttachment } from "../qq/schema";

export interface LoadedAttachment {
  kind: "image" | "file";
  filename: string;
  dataUrl: string;
}

export interface AttachmentLoader {
  load(attachments: readonly QQAttachment[]): Promise<LoadedAttachment[]>;
}

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function privateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first! >= 224
  );
}

function validateAttachmentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("attachment_invalid", "Invalid attachment URL");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== "" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    privateIpv4(hostname) ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe8") ||
    hostname.startsWith("fe9") ||
    hostname.startsWith("fea") ||
    hostname.startsWith("feb")
  ) {
    throw new AppError("attachment_invalid", "Unsafe attachment URL");
  }
  return url;
}

function safeFilename(value: string | undefined, index: number): string {
  const cleaned = (value ?? "")
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 120);
  return cleaned || `attachment-${index + 1}`;
}

function safeContentType(qqValue: string | undefined, headerValue: string | null): string {
  const candidate = (headerValue ?? qqValue ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(candidate)
    ? candidate
    : "application/octet-stream";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export class HttpAttachmentLoader implements AttachmentLoader {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(
    fetchImpl: typeof fetch = globalThis.fetch,
    now: () => number = Date.now,
  ) {
    this.#fetch = (input, init) => fetchImpl(input, init);
    this.#now = now;
  }

  async load(attachments: readonly QQAttachment[]): Promise<LoadedAttachment[]> {
    if (attachments.length > MAX_ATTACHMENT_FILES) {
      throw new AppError(
        "attachment_invalid",
        `At most ${MAX_ATTACHMENT_FILES} attachments are allowed`,
      );
    }

    const deadline = this.#now() + ATTACHMENT_TIMEOUT_MS;
    const loaded: LoadedAttachment[] = [];
    let totalBytes = 0;

    for (let index = 0; index < attachments.length; index += 1) {
      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        throw new AppError("attachment_unavailable", "Attachment download timed out");
      }
      const attachment = attachments[index]!;
      let currentUrl = validateAttachmentUrl(attachment.url);
      let response: Response | null = null;

      for (let redirect = 0; redirect <= 2; redirect += 1) {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          Math.max(1, deadline - this.#now()),
        );
        try {
          response = await this.#fetch(currentUrl, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
          });
        } catch {
          throw new AppError("attachment_unavailable", "Attachment download failed");
        } finally {
          clearTimeout(timer);
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location === null || redirect === 2) {
            throw new AppError("attachment_unavailable", "Invalid attachment redirect");
          }
          currentUrl = validateAttachmentUrl(new URL(location, currentUrl).toString());
          continue;
        }
        break;
      }

      if (response === null || !response.ok) {
        throw new AppError("attachment_unavailable", "Attachment download failed");
      }
      const declaredSize = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (
        Number.isFinite(declaredSize) &&
        (declaredSize > MAX_ATTACHMENT_BYTES ||
          totalBytes + declaredSize > MAX_TOTAL_ATTACHMENT_BYTES)
      ) {
        throw new AppError("attachment_too_large", "Attachment exceeds size limit");
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      totalBytes += bytes.byteLength;
      if (
        bytes.byteLength > MAX_ATTACHMENT_BYTES ||
        totalBytes > MAX_TOTAL_ATTACHMENT_BYTES
      ) {
        throw new AppError("attachment_too_large", "Attachment exceeds size limit");
      }

      const contentType = safeContentType(
        attachment.contentType,
        response.headers.get("content-type"),
      );
      loaded.push({
        kind: IMAGE_TYPES.has(contentType) ? "image" : "file",
        filename: safeFilename(attachment.filename, index),
        dataUrl: `data:${contentType};base64,${bytesToBase64(bytes)}`,
      });
    }

    return loaded;
  }
}
