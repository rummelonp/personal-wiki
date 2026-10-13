import { type Ref, useImperativeHandle, useRef } from "react";

export interface BodyEditorHandle {
  /** 本文の `offset` の位置にカーソルを置き、見える位置までスクロールする。 */
  jumpTo: (offset: number) => void;
}

export interface BodyEditorProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  readOnly?: boolean;
  ref?: Ref<BodyEditorHandle>;
}

/**
 * 本文の編集部品。いまは textarea で、CodeMirror の Editor に置き換えるときは
 * この props（value / onChange / onBlur / readOnly / ref）を保ったまま中身だけ差し替える。
 */
export function BodyEditor({ value, onChange, onBlur, readOnly = false, ref }: BodyEditorProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    jumpTo(offset) {
      const element = textarea.current;
      if (element === null) return;
      // textarea は setSelectionRange だけではスクロールしない。blur してから focus し直すと、
      // ブラウザがカーソルの位置を見える所まで動かす
      element.blur();
      element.setSelectionRange(offset, offset);
      element.focus();
    },
  }));

  return (
    <textarea
      ref={textarea}
      className="body-editor"
      aria-label="本文"
      value={value}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
    />
  );
}
