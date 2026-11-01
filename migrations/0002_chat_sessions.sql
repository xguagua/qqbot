CREATE TABLE IF NOT EXISTS chat_sessions (
  group_openid TEXT NOT NULL,
  member_openid TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (group_openid, member_openid)
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_expires_at
  ON chat_sessions(expires_at);
