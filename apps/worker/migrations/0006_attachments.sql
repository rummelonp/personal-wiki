-- 添付（R2 に置く画像）の台帳と、本文からの参照。
-- 画像の中身は R2 のキー attachments/<name> に置き、ここには配信に要る値だけを持つ。
-- 時刻は UNIX エポックのミリ秒。
--
-- R2 に put してから attachments に INSERT する（attachments/routes.ts）。INSERT が失敗して残るのは
-- 行の無い R2 のオブジェクトだけで、配信は行を見て判断するのでどこからも読めない。
-- 行を消す処理（purge）を足すときは、scripts/backup.mjs の DATA_TABLES にある、読む順の前提を見直す。
CREATE TABLE attachments (
  -- 本文の ![[name]] に書く名前。乱数 22 文字と拡張子（@personal-wiki/domain の isAttachmentName）
  name TEXT NOT NULL PRIMARY KEY,
  -- 配信の Content-Type はこの値を使う。形式を足すたびに表を作り直さないよう、CHECK にせずアプリで検査する
  content_type TEXT NOT NULL,
  -- バイト数
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  -- 保存した actor。形式は revisions.actor と同じ
  created_by TEXT NOT NULL
) WITHOUT ROWID;

-- ページの本文が埋め込む添付。links と同じ派生データで、保存、削除、
-- POST /api/admin/derived/rebuild が同じ文で書く。匿名に添付を配信してよいかは、削除されていない
-- ページからの参照があるかで決める。
-- まだ無い添付（アップロードが終わる前の保存など）も指せるよう、attachments への外部キーは張らない。
-- 物理削除（purge）を足すときは、tags と同じようにここの行も消してから pages の行を消す。
CREATE TABLE attachment_refs (
  page_id TEXT NOT NULL REFERENCES pages (id),
  name TEXT NOT NULL,
  PRIMARY KEY (page_id, name)
) WITHOUT ROWID;

-- 添付の名前から参照するページを引く。参照の無くなった添付を R2 から消す処理（まだ無い）が使う
CREATE INDEX attachment_refs_name ON attachment_refs (name);
