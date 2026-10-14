import { RailLayout } from "./Rail";

/** 起動時とページの取得中の表示。切り替わりで文字が横にずれないよう、本文と同じ列に置く。 */
export function Loading() {
  return (
    <RailLayout rail={null}>
      <p className="muted">読み込み中…</p>
    </RailLayout>
  );
}
