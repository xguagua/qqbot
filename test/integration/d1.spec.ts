import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { D1ConfigRepository } from "../../src/storage/config";
import { D1ChatRepository } from "../../src/storage/chat";

let db: D1Database;
let dispose: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: "wrangler.toml",
    persist: false,
    remoteBindings: false,
  });
  db = proxy.env.DB;
  dispose = proxy.dispose;
  const migrations = await Promise.all(
    [
      "../../migrations/0001_initial.sql",
      "../../migrations/0002_chat_sessions.sql",
      "../../migrations/0003_chat_enabled.sql",
      "../../migrations/0004_auto_reply_enabled.sql",
      "../../migrations/0005_auto_reply_force.sql",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  const statements = migrations
    .flatMap((migration) => migration.split(";"))
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  await db.batch(statements.map((statement) => db.prepare(statement)));
});

afterAll(async () => {
  await dispose?.();
});

describe("D1 configuration repository", () => {
  it("isolates groups, versions updates, and audits field names only", async () => {
    const now = Date.parse("2026-10-25T10:00:00Z");
    const repository = new D1ConfigRepository(db, () => now);

    const initial = await repository.get("integration-group-a");
    expect(initial).toMatchObject({
      groupOpenid: "integration-group-a",
      model: "deepseek-flash",
      reasoningEffort: "low",
      chatEnabled: true,
      autoReplyEnabled: true,
      autoReplyForce: false,
      version: 0,
    });

    const updated = await repository.update(
      "integration-group-a",
      "integration-admin",
      {
        model: "deepseek-v4-pro",
        systemPrompt: "PRIVATE_PROMPT_VALUE",
        chatEnabled: false,
        autoReplyEnabled: false,
        autoReplyForce: true,
      },
    );
    expect(updated).toMatchObject({
      model: "deepseek-v4-pro",
      reasoningEffort: "low",
      systemPrompt: "PRIVATE_PROMPT_VALUE",
      chatEnabled: false,
      autoReplyEnabled: false,
      autoReplyForce: true,
      updatedByOpenid: "integration-admin",
      version: 1,
    });

    await expect(repository.get("integration-group-b")).resolves.toMatchObject({
      model: "deepseek-flash",
      systemPrompt: expect.not.stringContaining("PRIVATE_PROMPT_VALUE"),
      version: 0,
    });

    const audit = await db
      .prepare(
        "SELECT group_openid, actor_member_openid, changed_fields, " +
          "previous_version, new_version FROM config_audits WHERE group_openid = ?",
      )
      .bind("integration-group-a")
      .first<Record<string, unknown>>();
    expect(audit).toMatchObject({
      group_openid: "integration-group-a",
      actor_member_openid: "integration-admin",
      changed_fields:
        "model,system_prompt,chat_enabled,auto_reply_enabled,auto_reply_force",
      previous_version: 0,
      new_version: 1,
    });
    expect(JSON.stringify(audit)).not.toContain("PRIVATE_PROMPT_VALUE");
  });

  it("rejects a stale concurrent update instead of writing a second audit", async () => {
    const repository = new D1ConfigRepository(db, () => Date.parse("2026-10-25T11:00:00Z"));
    const attempts = await Promise.allSettled([
      repository.update("integration-group-race", "admin-a", {
        model: "deepseek-v4-pro",
      }),
      repository.update("integration-group-race", "admin-b", {
        reasoningEffort: "high",
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);

    const auditCount = await db
      .prepare("SELECT COUNT(*) AS count FROM config_audits WHERE group_openid = ?")
      .bind("integration-group-race")
      .first<{ count: number }>();
    expect(auditCount?.count).toBe(1);
  });

  it("deletes only audits older than thirty days", async () => {
    const oldId = crypto.randomUUID();
    const recentId = crypto.randomUUID();
    await db.batch([
      db
        .prepare(
          "INSERT INTO config_audits " +
            "(id, group_openid, actor_member_openid, changed_fields, previous_version, " +
            "new_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          oldId,
          "cleanup-group",
          "actor",
          "model",
          0,
          1,
          "2026-09-01T00:00:00.000Z",
        ),
      db
        .prepare(
          "INSERT INTO config_audits " +
            "(id, group_openid, actor_member_openid, changed_fields, previous_version, " +
            "new_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          recentId,
          "cleanup-group",
          "actor",
          "reasoning_effort",
          1,
          2,
          "2026-10-01T00:00:00.000Z",
        ),
    ]);

    const repository = new D1ConfigRepository(
      db,
      () => Date.parse("2026-10-25T00:00:00Z"),
    );
    await repository.cleanupAudits();
    const remaining = await db
      .prepare("SELECT id FROM config_audits WHERE group_openid = ?")
      .bind("cleanup-group")
      .all<{ id: string }>();
    expect(remaining.results.map((row) => row.id)).toEqual([recentId]);
  });

  it("isolates chat context by group and member and expires old sessions", async () => {
    let now = Date.parse("2026-11-01T10:00:00Z");
    const repository = new D1ChatRepository(db, () => now);

    await repository.appendTurn(
      "chat-group-a",
      "chat-member-a",
      "user A one",
      "assistant A one",
    );
    await expect(
      repository.load("chat-group-a", "chat-member-a"),
    ).resolves.toEqual([
      { role: "user", content: "user A one" },
      { role: "assistant", content: "assistant A one" },
    ]);
    await expect(
      repository.load("chat-group-a", "chat-member-b"),
    ).resolves.toEqual([]);
    await expect(
      repository.load("chat-group-b", "chat-member-a"),
    ).resolves.toEqual([]);

    for (let index = 2; index <= 6; index += 1) {
      await repository.appendTurn(
        "chat-group-a",
        "chat-member-a",
        `user A ${index}`,
        `assistant A ${index}`,
      );
    }
    const retained = await repository.load("chat-group-a", "chat-member-a");
    expect(retained).toHaveLength(8);
    expect(retained[0]).toEqual({ role: "user", content: "user A 3" });
    expect(retained[7]).toEqual({ role: "assistant", content: "assistant A 6" });

    now += 24 * 60 * 60_000 + 1;
    await expect(
      repository.load("chat-group-a", "chat-member-a"),
    ).resolves.toEqual([]);
  });
});
