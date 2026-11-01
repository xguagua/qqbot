import { describe, expect, it } from "vitest";
import { HttpAttachmentLoader } from "../src/files/attachments";

const textAttachment = {
  url: "https://cdn.example.test/notes.txt",
  filename: "notes.txt",
  contentType: "text/plain",
  size: 5,
};

describe("attachment loader", () => {
  it("downloads a file into a data URL", async () => {
    let requestedUrl = "";
    const loader = new HttpAttachmentLoader(async (input) => {
      requestedUrl = String(input);
      return new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "5" },
      });
    });
    await expect(loader.load([textAttachment])).resolves.toEqual([
      {
        kind: "file",
        filename: "notes.txt",
        dataUrl: "data:text/plain;base64,aGVsbG8=",
      },
    ]);
    expect(requestedUrl).toBe("https://cdn.example.test/notes.txt");
  });

  it("recognizes supported images", async () => {
    const loader = new HttpAttachmentLoader(async () =>
      new Response("hello", {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const [loaded] = await loader.load([
      {
        ...textAttachment,
        url: "https://cdn.example.test/image.png",
        filename: "image.png",
        contentType: "image/png",
      },
    ]);
    expect(loaded?.kind).toBe("image");
  });

  it.each([
    "http://cdn.example.test/file",
    "https://localhost/file",
    "https://127.0.0.1/file",
    "https://10.0.0.1/file",
    "https://[::1]/file",
    "https://user:pass@cdn.example.test/file",
  ])("rejects unsafe attachment URL: %s", async (url) => {
    let called = false;
    const loader = new HttpAttachmentLoader(async () => {
      called = true;
      return new Response("hello");
    });
    await expect(loader.load([{ ...textAttachment, url }])).rejects.toMatchObject({
      code: "attachment_invalid",
    });
    expect(called).toBe(false);
  });

  it("rejects files over the declared size limit", async () => {
    const loader = new HttpAttachmentLoader(async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": String(5 * 1024 * 1024) },
      }),
    );
    await expect(loader.load([textAttachment])).rejects.toMatchObject({
      code: "attachment_too_large",
    });
  });

  it("rejects more than three attachments", async () => {
    const loader = new HttpAttachmentLoader();
    await expect(
      loader.load([textAttachment, textAttachment, textAttachment, textAttachment]),
    ).rejects.toMatchObject({ code: "attachment_invalid" });
  });
});
