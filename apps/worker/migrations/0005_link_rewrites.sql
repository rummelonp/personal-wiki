-- title を変えたページへのリンクを、他のページの本文で書き換える待ち行列。
-- rename の batch がリンク元ごとに 1 行積み、POST /api/link-rewrites/step が 1 ページずつ書き換えて消す
-- （pages/link-rewrites.ts）。rename の batch は旧 key の links から target_page_id を外すので、
-- リンク元はその時点でここに記録しておく必要がある。
--
-- old_title_key は rename 前の title_key。書き換え先の title は積んだ時点では決めず、処理する時点の
-- target の title を使う（連続して改名しても最終の title に 1 回で書き換える）。
-- 同じ行を積み直すと created_at と actor が新しくなり（attempts は 0 に戻る）、処理の順番は後ろに回る。
-- actor は最後に積み直した rename の呼び出し元で、書き換えの revision の actor になる。形式は revisions.actor と同じ。
-- attempts は step がこのリンク元を処理しようとした回数。本文を解析する前に数えるので、CPU の上限で
-- invocation ごと打ち切られても残る。上限を超えたリンク元は failed として捨てる。
-- 外部キーを付けないのは、行が一時的で、消えたページの行は処理時に読み捨てるため。
CREATE TABLE link_rewrites (
  source_page_id TEXT NOT NULL,
  target_page_id TEXT NOT NULL,
  old_title_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_page_id, target_page_id, old_title_key)
) WITHOUT ROWID;

-- web が rename したページの分だけを進めるときに target で絞る
CREATE INDEX link_rewrites_target ON link_rewrites (target_page_id);
