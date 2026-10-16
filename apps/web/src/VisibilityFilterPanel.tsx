import { Link } from "./Link";
import { RailSection } from "./Rail";
import { listHref, type VisibilityFilter } from "./route";

const OPTIONS: { value: VisibilityFilter; label: string }[] = [
  { value: "", label: "すべて" },
  { value: "public", label: "公開" },
  { value: "draft", label: "下書き" },
];

/**
 * 一覧を公開範囲で絞り込む欄。owner だけに出す（匿名の一覧はもともと public だけ）。
 * 選択肢はリンクにする。戻る操作と新しいタブで、絞り込みを行き来できる。
 * 選択中のタグは保ったまま、公開範囲だけを切り替える。
 */
export function VisibilityFilterPanel({ tag, active }: { tag: string; active: VisibilityFilter }) {
  return (
    <RailSection title="公開範囲" className="rail-section-visibility">
      <nav className="segmented" aria-label="公開範囲で絞り込む">
        {OPTIONS.map(({ value, label }) => (
          <Link
            key={label}
            className="segmented-option"
            data-value={value === "" ? undefined : value}
            href={listHref({ tag, visibility: value })}
            aria-current={value === active ? "page" : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>
    </RailSection>
  );
}
