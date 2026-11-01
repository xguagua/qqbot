import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors";
import {
  signWebhookChallenge,
  signWebhookPayload,
  verifyWebhookSignature,
} from "../src/qq/verify";
import { bytes, TEST_APP_ID, TEST_SECRET } from "./helpers";

function requestWithSignature(signature: string, timestamp = "1725442341"): Request {
  return new Request("https://worker.example/webhook", {
    method: "POST",
    headers: {
      "x-bot-appid": TEST_APP_ID,
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
  });
}

describe("QQ webhook Ed25519", () => {
  it("produces the deterministic challenge signature", async () => {
    await expect(
      signWebhookChallenge(TEST_SECRET, "1725442341", "Arq0D5A61EgUu4OxUvOp"),
    ).resolves.toBe(
      "87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d0" +
        "1bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706",
    );
  });

  it("accepts the exact signed bytes", async () => {
    const raw = bytes('{"op":0,"t":"GROUP_AT_MESSAGE_CREATE","d":{}}');
    const timestamp = "1725442341";
    const signature = await signWebhookPayload(TEST_SECRET, timestamp, raw);
    await expect(
      verifyWebhookSignature(
        requestWithSignature(signature, timestamp),
        raw,
        TEST_SECRET,
        TEST_APP_ID,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a changed body byte", async () => {
    const raw = bytes('{"op":0,"d":{"value":1}}');
    const timestamp = "1725442341";
    const signature = await signWebhookPayload(TEST_SECRET, timestamp, raw);
    const changed = bytes('{"op":0,"d":{"value":2}}');
    await expect(
      verifyWebhookSignature(
        requestWithSignature(signature, timestamp),
        changed,
        TEST_SECRET,
        TEST_APP_ID,
      ),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("rejects a changed timestamp", async () => {
    const raw = bytes('{"op":0}');
    const signature = await signWebhookPayload(TEST_SECRET, "1725442341", raw);
    await expect(
      verifyWebhookSignature(
        requestWithSignature(signature, "1725442342"),
        raw,
        TEST_SECRET,
        TEST_APP_ID,
      ),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it.each([
    ["", "empty"],
    ["xyz", "non-hex"],
    ["00", "short"],
    ["00".repeat(64), "wrong length"],
  ])("safely rejects an invalid signature (%s)", async (signature) => {
    await expect(
      verifyWebhookSignature(
        requestWithSignature(signature),
        bytes("{}"),
        TEST_SECRET,
        TEST_APP_ID,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a mismatched app ID", async () => {
    const raw = bytes("{}");
    const signature = await signWebhookPayload(TEST_SECRET, "1725442341", raw);
    const request = new Request("https://worker.example/webhook", {
      method: "POST",
      headers: {
        "x-bot-appid": "another-app",
        "x-signature-ed25519": signature,
        "x-signature-timestamp": "1725442341",
      },
    });
    await expect(
      verifyWebhookSignature(request, raw, TEST_SECRET, TEST_APP_ID),
    ).rejects.toMatchObject({ code: "appid_mismatch" });
  });
});
