-- ページ本体と、本文から導出する派生データ（links、tags、pages_fts）。
-- 派生データは body と title だけから作り直せる（POST /api/admin/derived/rebuild）。
-- 時刻はすべて UNIX エポックのミリ秒。
--
-- ページの削除は論理削除で、行を消す経路はまだ無い。物理削除（purge）を足すときは:
-- - 外部キーに ON DELETE を付けていないので、revisions、tags、そのページから出る links を消し、
--   そのページを指す links.target_page_id を NULL にしてから pages の行を消す（D1 は外部キーを検査する）。
-- - seq は AUTOINCREMENT ではなく、最大の seq の行を消すとその値が次のページに再利用される。
--   pages_fts の行（rowid = seq）は論理削除の時点で消しているが、purge する前にも残っていないことを
--   保証する。残っていると、seq を再利用した新しいページが古いページの検索の行を引き継ぐ。
CREATE TABLE pages (
  -- pages_fts の rowid に使う。INTEGER PRIMARY KEY で rowid に別名を付けないと、VACUUM で
  -- rowid が振り直されて FTS の行と対応しなくなりうる。連番で推測できるので API には出さない
  seq INTEGER PRIMARY KEY,
  -- 16 バイトの乱数の base64url（22 文字）。draft は id の URL だけで読めるので推測できない値にする
  id TEXT NOT NULL UNIQUE,
  visibility TEXT NOT NULL DEFAULT 'draft' CHECK (visibility IN ('public', 'draft')),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  -- 削除した actor。形式は revisions.actor と同じ
  deleted_by TEXT CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  -- @personal-wiki/domain の normalizeTitleKey の結果。SQLite の関数では同じ畳み方を再現できない
  title_key TEXT NOT NULL,
  -- 大きい TEXT は行の後ろに置く。SQLite は列を先頭から順に読むので、前にあると後ろの小さい列を
  -- 読むたびに overflow page をたどる
  title TEXT NOT NULL,
  body TEXT NOT NULL
);

-- 削除済みのページの title は、新しいページが使えるように一意性から外す
CREATE UNIQUE INDEX pages_title_key_alive ON pages (title_key) WHERE deleted_at IS NULL;

-- 保存後の内容を版ごとに積む。actor は 'owner' か 'token:<名前>'
CREATE TABLE revisions (
  page_id TEXT NOT NULL REFERENCES pages (id),
  version INTEGER NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (page_id, version)
);

-- 小さい行を主キーだけで引くので WITHOUT ROWID にし、主キーの自動索引の分の書き込みを省く
CREATE TABLE links (
  source_page_id TEXT NOT NULL REFERENCES pages (id),
  target_title_key TEXT NOT NULL,
  -- target_title_key と同じ title_key を持つ削除されていないページ。無ければ NULL。
  -- draft のページにも解決するので、anonymous に返す読み取りは pages と結合して
  -- visibility = 'public' で絞る（draft の存在や id を漏らさない）
  target_page_id TEXT REFERENCES pages (id),
  PRIMARY KEY (source_page_id, target_title_key)
) WITHOUT ROWID;

-- backlink を title と id の両方から引き、保存時の再解決もこの 2 つで行を探す
CREATE INDEX links_target_title_key ON links (target_title_key);
CREATE INDEX links_target_page_id ON links (target_page_id);

CREATE TABLE tags (
  page_id TEXT NOT NULL REFERENCES pages (id),
  -- extractDerived が返す foldTitle 済みの値。ページをまたぐ一覧と絞り込みはこちらで引く
  tag_key TEXT NOT NULL,
  -- 本文に最初に現れた表記
  tag TEXT NOT NULL,
  PRIMARY KEY (page_id, tag_key)
) WITHOUT ROWID;

CREATE INDEX tags_tag_key ON tags (tag_key);

-- own content。external content と書き込み行数がほぼ変わらず、こちらの方が更新の手順が単純。
-- title と body は NFKC 正規化して入れる（trigram は全角英数や半角カナを畳まないため）。
-- body には Markdown ではなく extractDerived の plainText を入れる
CREATE VIRTUAL TABLE pages_fts USING fts5 (title, body, tokenize = 'trigram');

-- 保存の batch の先頭文が、版が合わないときだけこの表に行を入れようとし、trigger が batch 全体を
-- rollback させる。版が合うときは INSERT ... SELECT が 0 行なので発火せず、行も残らない。
-- D1 の batch では直前の UPDATE の結果で後続の文を条件付けられない（changes() は直後の 1 文にしか効かない）。
CREATE TABLE save_guard (page_id TEXT NOT NULL);

CREATE TRIGGER save_guard_reject BEFORE INSERT ON save_guard
BEGIN
  SELECT RAISE(ABORT, 'version_conflict');
END;
