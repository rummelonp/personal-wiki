-- OAuth の client の登録（DCR）を UTC の 1 日ごとに数える。登録は匿名で呼べ、1 回ごとに KV に
-- 書き込むので、1 日の上限を超えた登録を KV に書く前に断る（auth/oauth-registration.ts）。
-- 1 日 1 行しか増えないので、古い行は消さない。
CREATE TABLE oauth_client_registrations (
  -- 'YYYY-MM-DD'（UTC）
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK (count >= 0)
);
