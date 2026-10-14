import { type CSSProperties, useRef } from "react";
import type { OutlineItem } from "./heading-outline";
import { RailSection } from "./Rail";

/** 見出しがこの数に満たないページでは、本文の前の目次を出さない。数行のページでは目次が本文より目立つ。 */
const INLINE_OUTLINE_MIN_ITEMS = 3;

interface OutlineProps {
  items: OutlineItem[];
  /** 見出しの位置（本文の中での添字）へ編集欄を移す */
  onJump: (offset: number) => void;
}

function OutlineList({ items, onJump }: OutlineProps) {
  const top = Math.min(...items.map((item) => item.level));
  return (
    <ul className="outline">
      {items.map((item) => (
        <li key={item.offset} style={{ "--outline-depth": item.level - top } as CSSProperties}>
          <button type="button" className="outline-link" onClick={() => onJump(item.offset)}>
            {item.text}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * 右の列の目次。見出しが無ければ出さない。クリックで編集欄のその見出しへ移る。
 * 狭い画面では右の列が本文の下に回って長いページで届かないので、CSS で隠し、`InlineOutline` に任せる。
 */
export function Outline({ items, onJump }: OutlineProps) {
  if (items.length === 0) return null;
  return (
    <RailSection title="目次" className="rail-section-outline">
      <OutlineList items={items} onJump={onJump} />
    </RailSection>
  );
}

/**
 * 狭い画面で title の下に置く、畳んだ目次。広い画面では CSS で隠し、右の列の `Outline` を使う。
 * 見出しを選ぶと畳んでから移る。開いたままだと、移った先の見出しが目次の下に押し出される。
 */
export function InlineOutline({ items, onJump }: OutlineProps) {
  const details = useRef<HTMLDetailsElement>(null);
  if (items.length < INLINE_OUTLINE_MIN_ITEMS) return null;

  function jump(offset: number) {
    const element = details.current;
    if (element === null) return;
    element.open = false;
    onJump(offset);
    // 押した見出しのボタンは畳んで見えなくなり、focus が失われて、キーボードの利用者が位置を失う。
    // ブラウザが focus を外す前でも、畳んだ中のボタンに残っているものは失われたものとして扱う。
    // 移った先の本文が focus を取っていればそれに任せ、取っていないときだけ summary に戻す。
    // 戻すときにスクロールすると、移った先から目次へ引き戻される。
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active === null || active === document.body || element.contains(active)) {
        element.querySelector("summary")?.focus({ preventScroll: true });
      }
    });
  }

  return (
    <details ref={details} className="toc">
      <summary>目次</summary>
      <OutlineList items={items} onJump={jump} />
    </details>
  );
}
