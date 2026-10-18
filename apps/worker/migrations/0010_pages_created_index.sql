-- 一覧を作成日時の順に並べるときの (created_at DESC, id DESC) を引く部分インデックス。役割は
-- pages_alive_updated と同じで、無いと一覧の 1 回の読み取り行数がページ数に比例する。
-- created_at は作成のときにしか書かないので、保存のたびのインデックスへの書き込みは増えない。
-- テーブルは変えないので、この migration を当てた D1 でも Worker の前の版はそのまま動く。
CREATE INDEX pages_alive_created ON pages (created_at, id) WHERE deleted_at IS NULL;
