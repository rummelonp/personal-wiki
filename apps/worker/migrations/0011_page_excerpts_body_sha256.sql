-- 保存されている本文全体の SHA-256（小文字の 16 進 64 文字。read_page の bodySha256 と同じ値）。
-- 一覧が本文を読まずに各件のハッシュを返すための派生データで、抜粋と同じ文が同じ batch で書く。
-- pages でなく page_excerpts に置く理由は 0003_page_excerpts.sql と同じで、一覧はすでにこのテーブルを結合している。
--
-- NULL はまだ計算していないことを表し、一覧はハッシュを返さない。この migration の前からある行は
-- derived:rebuild を回すまで NULL のまま。列を足すだけなので、当てた D1 でも Worker の前の版はそのまま動く
-- （前の版の INSERT はこの列を書かず NULL になる）。
ALTER TABLE page_excerpts ADD COLUMN body_sha256 TEXT;
