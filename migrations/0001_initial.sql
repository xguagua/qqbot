CREATE TABLE IF NOT EXISTS group_configs (
  group_openid TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  updated_by_openid TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS config_audits (
  id TEXT PRIMARY KEY,
  group_openid TEXT NOT NULL,
  actor_member_openid TEXT NOT NULL,
  changed_fields TEXT NOT NULL,
  previous_version INTEGER NOT NULL,
  new_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_config_audits_created_at
  ON config_audits(created_at);

CREATE INDEX IF NOT EXISTS idx_config_audits_group_created
  ON config_audits(group_openid, created_at);
