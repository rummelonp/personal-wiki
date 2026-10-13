-- 機械（AI エージェントやスクリプト）が Bearer で使う API トークン。
-- 平文は発行時に 1 回だけ表示し、ここには SHA-256 の hex だけを置く。
-- 時刻はすべて UNIX エポックのミリ秒。
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  -- 失効後も行を残し、名前を使い回さない（principal の名前が revision の actor に残るため）
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  -- write は read を含む。並びを固定して、比較と検査を単純にする
  scopes TEXT NOT NULL CHECK (scopes IN ('read', 'read write')),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
