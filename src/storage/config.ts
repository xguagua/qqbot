import {
  ALLOWED_MODELS,
  ALLOWED_REASONING_EFFORTS,
  AUDIT_RETENTION_DAYS,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SYSTEM_PROMPT,
  MAX_SYSTEM_PROMPT_CHARS,
  type DeepSeekModel,
  type ReasoningEffort,
} from "../config";
import { AppError } from "../errors";
import { asRecord } from "../util";

export interface GroupConfig {
  groupOpenid: string;
  model: DeepSeekModel;
  reasoningEffort: ReasoningEffort;
  systemPrompt: string;
  updatedByOpenid: string;
  updatedAt: string;
  version: number;
}

export type ConfigField = "model" | "reasoning_effort" | "system_prompt";

export interface GroupConfigChanges {
  model?: DeepSeekModel;
  reasoningEffort?: ReasoningEffort;
  systemPrompt?: string;
}

export interface ConfigRepository {
  get(groupOpenid: string): Promise<GroupConfig>;
  update(
    groupOpenid: string,
    actorMemberOpenid: string,
    changes: GroupConfigChanges,
  ): Promise<GroupConfig>;
  cleanupAudits(): Promise<void>;
}

interface GroupConfigRow {
  group_openid: string;
  model: string;
  reasoning_effort: string;
  system_prompt: string;
  updated_by_openid: string;
  updated_at: string;
  version: number;
}

function isModel(value: unknown): value is DeepSeekModel {
  return typeof value === "string" && ALLOWED_MODELS.includes(value as DeepSeekModel);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    ALLOWED_REASONING_EFFORTS.includes(value as ReasoningEffort)
  );
}

export function defaultGroupConfig(groupOpenid: string): GroupConfig {
  return {
    groupOpenid,
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    updatedByOpenid: "",
    updatedAt: "",
    version: 0,
  };
}

function parseConfigRow(row: unknown, expectedGroupOpenid: string): GroupConfig {
  const record = asRecord(row);
  if (
    record === null ||
    record.group_openid !== expectedGroupOpenid ||
    !isModel(record.model) ||
    !isReasoningEffort(record.reasoning_effort) ||
    typeof record.system_prompt !== "string" ||
    record.system_prompt.length === 0 ||
    record.system_prompt.length > MAX_SYSTEM_PROMPT_CHARS ||
    typeof record.updated_by_openid !== "string" ||
    typeof record.updated_at !== "string" ||
    typeof record.version !== "number" ||
    !Number.isSafeInteger(record.version) ||
    record.version < 1
  ) {
    throw new AppError("storage_unavailable", "Stored group configuration is invalid");
  }

  return {
    groupOpenid: record.group_openid,
    model: record.model,
    reasoningEffort: record.reasoning_effort,
    systemPrompt: record.system_prompt,
    updatedByOpenid: record.updated_by_openid,
    updatedAt: record.updated_at,
    version: record.version,
  };
}

function changedFields(changes: GroupConfigChanges): ConfigField[] {
  const fields: ConfigField[] = [];
  if (changes.model !== undefined) {
    fields.push("model");
  }
  if (changes.reasoningEffort !== undefined) {
    fields.push("reasoning_effort");
  }
  if (changes.systemPrompt !== undefined) {
    fields.push("system_prompt");
  }
  return fields;
}

function applyChanges(config: GroupConfig, changes: GroupConfigChanges): GroupConfig {
  return {
    ...config,
    model: changes.model ?? config.model,
    reasoningEffort: changes.reasoningEffort ?? config.reasoningEffort,
    systemPrompt: changes.systemPrompt ?? config.systemPrompt,
  };
}

export class D1ConfigRepository implements ConfigRepository {
  readonly #db: D1Database;
  readonly #now: () => number;

  constructor(db: D1Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  async get(groupOpenid: string): Promise<GroupConfig> {
    try {
      const row = await this.#db
        .prepare(
          "SELECT group_openid, model, reasoning_effort, system_prompt, " +
            "updated_by_openid, updated_at, version FROM group_configs " +
            "WHERE group_openid = ?",
        )
        .bind(groupOpenid)
        .first<GroupConfigRow>();
      return row === null ? defaultGroupConfig(groupOpenid) : parseConfigRow(row, groupOpenid);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("storage_unavailable", "Unable to read group configuration");
    }
  }

  async update(
    groupOpenid: string,
    actorMemberOpenid: string,
    changes: GroupConfigChanges,
  ): Promise<GroupConfig> {
    const fields = changedFields(changes);
    if (fields.length === 0) {
      throw new AppError("invalid_request", "No configuration fields were changed");
    }

    const current = await this.get(groupOpenid);
    const next = applyChanges(current, changes);
    const nextVersion = current.version + 1;
    const updatedAt = new Date(this.#now()).toISOString();
    const auditId = crypto.randomUUID();

    const update = this.#db
      .prepare(
        "INSERT INTO group_configs " +
          "(group_openid, model, reasoning_effort, system_prompt, updated_by_openid, " +
          "updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(group_openid) DO UPDATE SET " +
          "model = excluded.model, reasoning_effort = excluded.reasoning_effort, " +
          "system_prompt = excluded.system_prompt, updated_by_openid = excluded.updated_by_openid, " +
          "updated_at = excluded.updated_at, version = excluded.version " +
          "WHERE group_configs.version = ?",
      )
      .bind(
        groupOpenid,
        next.model,
        next.reasoningEffort,
        next.systemPrompt,
        actorMemberOpenid,
        updatedAt,
        nextVersion,
        current.version,
      );

    const audit = this.#db
      .prepare(
        "INSERT INTO config_audits " +
          "(id, group_openid, actor_member_openid, changed_fields, previous_version, " +
          "new_version, created_at) " +
          "SELECT ?, group_openid, ?, ?, ?, version, ? FROM group_configs " +
          "WHERE group_openid = ? AND version = ? AND updated_at = ? AND changes() = 1",
      )
      .bind(
        auditId,
        actorMemberOpenid,
        fields.join(","),
        current.version,
        updatedAt,
        groupOpenid,
        nextVersion,
        updatedAt,
      );

    try {
      const results = await this.#db.batch([update, audit]);
      const updateResult = results[0];
      const auditResult = results[1];
      if (updateResult?.meta.changes !== 1 || auditResult?.meta.changes !== 1) {
        throw new AppError("storage_unavailable", "Configuration update conflicted");
      }
      return {
        ...next,
        updatedByOpenid: actorMemberOpenid,
        updatedAt,
        version: nextVersion,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("storage_unavailable", "Unable to update group configuration");
    }
  }

  async cleanupAudits(): Promise<void> {
    const cutoff = new Date(
      this.#now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    ).toISOString();
    try {
      await this.#db
        .prepare("DELETE FROM config_audits WHERE created_at < ?")
        .bind(cutoff)
        .run();
    } catch {
      throw new AppError("storage_unavailable", "Unable to clean configuration audits");
    }
  }
}
