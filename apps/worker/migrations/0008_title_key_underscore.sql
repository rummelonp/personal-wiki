-- title_key の規則に、`_` を空白と同じ文字に畳む段を足す（@personal-wiki/domain の foldTitle）。
-- 新しい規則の key は、旧規則の key の `_` を空白にしたものと等しいので、保存済みの key を replace で移す。
-- tags.tag_key は `_` を区別する規則のまま変えない。
--
-- 生きているページ同士が新しい規則で同じ key になる（"a b" と "a_b"）と、最初の UPDATE が
-- pages_title_key_alive の一意制約で失敗する。migration は 1 つの batch で流れるので、そのときは
-- 何も書き換わらず、適用済みにもならない。どちらかの title を変えてから適用し直す（docs/deploy.md）。
UPDATE pages SET title_key = replace(title_key, '_', ' ') WHERE instr(title_key, '_') > 0;

-- 1 つの本文に [[a b]] と [[a_b]] があると、同じリンク元の行が同じ key になる。OR IGNORE で
-- 置き換えられずに `_` が残った行は、置き換えた先の行がすでにある重複なので消す。
-- link_rewrites も同じ（同じリンク元と対象で、旧 key だけが `_` と空白で違う行）。
UPDATE OR IGNORE links SET target_title_key = replace(target_title_key, '_', ' ')
  WHERE instr(target_title_key, '_') > 0;
DELETE FROM links WHERE instr(target_title_key, '_') > 0;

UPDATE OR IGNORE link_rewrites SET old_title_key = replace(old_title_key, '_', ' ')
  WHERE instr(old_title_key, '_') > 0;
DELETE FROM link_rewrites WHERE instr(old_title_key, '_') > 0;

-- key が変わったページと、key が変わったリンクの解決先を付け直す。derived:rebuild を待たずに
-- backlink が新しい規則で引ける（"a_b" のページに [[a b]] のリンク元が出る）
UPDATE links SET target_page_id = (
    SELECT p.id FROM pages AS p WHERE p.title_key = links.target_title_key AND p.deleted_at IS NULL
  )
  WHERE target_page_id IS NOT (
    SELECT p.id FROM pages AS p WHERE p.title_key = links.target_title_key AND p.deleted_at IS NULL
  );
