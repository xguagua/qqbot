import { AppError } from "../errors";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8,
  type Bytes,
} from "../util";

const ED25519_PKCS8_PREFIX: Bytes = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22,
  0x04, 0x20,
]);

interface QQKeyMaterial {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

const keyCache = new Map<string, Promise<QQKeyMaterial>>();

function deriveSeed(clientSecret: string): Bytes {
  let seed = utf8(clientSecret);
  if (seed.byteLength === 0) {
    throw new AppError("configuration", "QQ client secret is empty");
  }
  while (seed.byteLength < 32) {
    seed = concatBytes(seed, seed);
  }
  return seed.slice(0, 32);
}

async function secretCacheKey(clientSecret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(clientSecret));
  return bytesToHex(new Uint8Array(digest));
}

function decodeBase64Url(value: string): Bytes {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function createKeyMaterial(clientSecret: string): Promise<QQKeyMaterial> {
  const seed = deriveSeed(clientSecret);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    concatBytes(ED25519_PKCS8_PREFIX, seed),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (typeof jwk.x !== "string" || jwk.x.length === 0) {
    throw new AppError("configuration", "Unable to derive QQ public key");
  }

  const publicKeyBytes = decodeBase64Url(jwk.x);
  const publicKey = await crypto.subtle.importKey(
    "raw",
    publicKeyBytes,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return { privateKey, publicKey };
}

async function getKeyMaterial(clientSecret: string): Promise<QQKeyMaterial> {
  const cacheKey = await secretCacheKey(clientSecret);
  const cached = keyCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const pending = createKeyMaterial(clientSecret);
  keyCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    keyCache.delete(cacheKey);
    throw error;
  }
}

export async function signWebhookChallenge(clientSecret: string, eventTs: string, plainToken: string): Promise<string> {
  const { privateKey } = await getKeyMaterial(clientSecret);
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    utf8(`${eventTs}${plainToken}`),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function signWebhookPayload(
  clientSecret: string,
  timestamp: string,
  rawBody: Bytes,
): Promise<string> {
  const { privateKey } = await getKeyMaterial(clientSecret);
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    concatBytes(utf8(timestamp), rawBody),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyWebhookSignature(
  request: Request,
  rawBody: Bytes,
  clientSecret: string,
  expectedAppId: string,
): Promise<void> {
  const providedAppId = request.headers.get("x-bot-appid");
  if (providedAppId !== null && providedAppId !== expectedAppId) {
    throw new AppError("appid_mismatch", "Webhook AppID does not match", 401);
  }

  const signatureHeader = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signatureHeader || !timestamp) {
    throw new AppError("signature_invalid", "Missing webhook signature headers", 401);
  }

  let signature: Bytes;
  try {
    signature = hexToBytes(signatureHeader);
  } catch {
    throw new AppError("signature_invalid", "Invalid webhook signature", 401);
  }

  if (signature.byteLength !== 64 || (signature[63]! & 0xe0) !== 0) {
    throw new AppError("signature_invalid", "Invalid webhook signature", 401);
  }

  const { publicKey } = await getKeyMaterial(clientSecret);
  const signedMessage = concatBytes(utf8(timestamp), rawBody);

  let valid = false;
  try {
    valid = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, signedMessage);
  } catch {
    valid = false;
  }

  if (!valid) {
    throw new AppError("signature_invalid", "Webhook signature verification failed", 401);
  }
}
