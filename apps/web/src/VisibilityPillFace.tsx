type Visibility = "draft" | "public";

const LABELS: ReadonlyArray<{ value: Visibility; label: string }> = [
  { value: "draft", label: "下書き" },
  { value: "public", label: "公開" },
];

/**
 * 公開範囲の印の中身（丸、名前、▾）。編集の画面の印と、読み込み中に印の幅を空けておくスケルトンが使う。
 * 名前は両方を同じ位置に重ね、出していない方を見えなくする。どちらの公開範囲でも幅が同じになり、
 * 切り替えや読み込みの後に title が折り返し直さない
 */
export function VisibilityPillFace({
  shown,
  spinning = false,
}: {
  shown: Visibility;
  spinning?: boolean;
}) {
  return (
    <>
      <span
        className={spinning ? "visibility-mark visibility-spinner" : "visibility-mark"}
        aria-hidden="true"
      />
      <span className="visibility-label">
        {LABELS.map(({ value, label }) => (
          <span key={value} data-shown={value === shown ? "" : undefined}>
            {label}
          </span>
        ))}
      </span>
      <span aria-hidden="true">▾</span>
    </>
  );
}
