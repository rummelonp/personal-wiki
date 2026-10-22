-- public で削除されていないページを (updated_at DESC, id DESC) で並べる一覧（トップの HTML、llms.txt、
-- sitemap.xml）が引く部分インデックス。pages_alive_updated は公開範囲で絞らないので、それをたどると
-- 間に挟まる draft の行もすべて読み、draft が増えるほど 1 回の読み取り行数が増える。
-- 入るのは public の行だけなので、draft の保存ではインデックスへの書き込みが増えない。
-- テーブルは変えないので、この migration を当てた D1 でも Worker の前の版はそのまま動き、
-- DROP INDEX pages_public_updated で戻せる。
CREATE INDEX pages_public_updated ON pages (updated_at, id) WHERE deleted_at IS NULL AND visibility = 'public';
