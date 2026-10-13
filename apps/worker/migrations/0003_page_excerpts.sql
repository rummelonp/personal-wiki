-- 一覧に出す本文の抜粋。body から作り直せる派生データなので、保存と
-- POST /api/admin/derived/rebuild が links や tags と同じ経路で書く。
--
-- pages に列を足さないのは、ALTER TABLE ADD COLUMN が列を行の末尾（body の後ろ）に置くため。
-- 一覧が抜粋を読むたびに、body の overflow page をたどることになる。
--
-- この migration の前からあるページは、rebuild を回すまで行が無く、一覧では抜粋が省かれる。
-- 物理削除（purge）を足すときは、tags と同じようにここの行も消してから pages の行を消す。
CREATE TABLE page_excerpts (
  page_id TEXT NOT NULL PRIMARY KEY REFERENCES pages (id),
  -- 本文が空のページは空文字列
  excerpt TEXT NOT NULL
) WITHOUT ROWID;
