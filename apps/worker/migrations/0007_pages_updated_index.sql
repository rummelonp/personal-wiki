-- 最近の更新と title の一覧が並べる (updated_at DESC, id DESC) を引く部分インデックス。
-- インデックスが無いと、limit に関係なく削除されていない全ページを読んで並べ替えるので、匿名にも開いた一覧の
-- 1 回の読み取り行数がページ数に比例し、D1 の読み取りの無料枠を少ないリクエストで使い切れる。
-- テーブルは変えないので、この migration を当てた D1 でも Worker の前の版はそのまま動き、派生データの
-- 作り直しも要らない。保存（updated_at が変わる）と削除のたびに、インデックスへの書き込みが 1〜2 行増える。
CREATE INDEX pages_alive_updated ON pages (updated_at, id) WHERE deleted_at IS NULL;
