-- 機械（AI エージェントやスクリプト）が Bearer で使う API トークン。
-- 平文は発行時に 1 回だけ表示し、ここには SHA-256 の hex だけを置く。
-- 時刻はすべて UNIX エポックのミリ秒の INTEGER（後続のテーブルも揃える）。
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  -- 失効後も行を残し、名前を使い回さない（principal の名前が revision の actor に残るため）
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  -- 空白区切りの scope の並び（例: 'read write'）。値の検査は発行スクリプトと読み出し側で行う。
  -- SQLite は CHECK を ALTER できず、値を列挙するとスコープを足すたびにテーブルを作り直すことになる。
  scopes TEXT NOT NULL CHECK (scopes <> ''),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
