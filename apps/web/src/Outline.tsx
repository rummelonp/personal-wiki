import type { CSSProperties } from "react";
import type { OutlineItem } from "./heading-outline";
import { RailSection } from "./Rail";

/** 見出しが無ければ出さない。クリックで編集欄のその見出しへ移る。 */
export function Outline({
  items,
  onJump,
}: {
  items: OutlineItem[];
  onJump: (offset: number) => void;
}) {
  if (items.length === 0) return null;
  const top = Math.min(...items.map((item) => item.level));
  return (
    <RailSection title="目次">
      <ul className="outline">
        {items.map((item) => (
          <li key={item.offset} style={{ "--outline-depth": item.level - top } as CSSProperties}>
            <button type="button" className="outline-link" onClick={() => onJump(item.offset)}>
              {item.text}
            </button>
          </li>
        ))}
      </ul>
    </RailSection>
  );
}
