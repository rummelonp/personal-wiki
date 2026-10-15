-- api_tokens の name の UNIQUE を外し、token を id で識別する。name は重複してよいラベルになり、
-- 失効させた token と同じ名前でも発行し直せる。SQLite は制約を ALTER できないので、表を作り直して
-- 行を id ごと移す。api_tokens を参照する外部キーとトリガーは無い。列の並びは backup.mjs の TABLES と一致させる。
--
-- actor（revisions.actor など）に残る 'token:<name>' は書き換えない。そのころ name は一意だったので、
-- 1 本の token を指したまま読める。新しく書く actor の形は revisions.ts の actorOf にある。
CREATE TABLE api_tokens_new (
  -- 失効後も行を消さないので、id は最大値の次から振られ、使い回されない。
  -- 例外は api_tokens を含めずにバックアップから戻した D1 で、id が 1 から振り直される（docs/operations.md）。
  id INTEGER PRIMARY KEY,
  -- actor の 'token:<id>:<name>' を古い 'token:<name>' と `:` の数で見分けるので、name に `:` を入れさせない。
  -- 発行スクリプトも同じ規則で検査するが、wrangler での直接の挿入やダンプの load はそれを通らない。
  name TEXT NOT NULL CHECK (instr(name, ':') = 0),
  token_hash TEXT NOT NULL UNIQUE,
  -- 空白区切りの scope の並び（例: 'read write'）。値の検査は発行スクリプトと読み出し側で行う。
  -- SQLite は CHECK を ALTER できず、値を列挙するとスコープを足すたびにテーブルを作り直すことになる。
  scopes TEXT NOT NULL CHECK (scopes <> ''),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

INSERT INTO api_tokens_new (id, name, token_hash, scopes, created_at, last_used_at, revoked_at)
  SELECT id, name, token_hash, scopes, created_at, last_used_at, revoked_at FROM api_tokens;

DROP TABLE api_tokens;

ALTER TABLE api_tokens_new RENAME TO api_tokens;
