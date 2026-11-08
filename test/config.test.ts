import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config";
import { testEnv } from "./helpers";

describe("minimal runtime configuration", () => {
  it("loads QQ credentials and deployment metadata", () => {
    expect(loadRuntimeConfig(testEnv())).toEqual({
      qqAppId: "test-app-id",
      qqClientSecret: "DG5g3B4j9X2KOErG",
      gitCommitSha: "test-commit",
      deployedAt: "2026-11-08T00:00:00+08:00",
    });
  });

  it("fails closed when required credentials are missing", () => {
    expect(() =>
      loadRuntimeConfig(testEnv({ QQ_APP_ID: "" })),
    ).toThrowError(expect.objectContaining({ code: "configuration" }));
  });
});
