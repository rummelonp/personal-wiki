export interface BodyEditorProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  readOnly?: boolean;
}

/**
 * 本文の編集部品。いまは textarea で、CodeMirror の Editor に置き換えるときは
 * この props（value / onChange / onBlur / readOnly）を保ったまま中身だけ差し替える。
 */
export function BodyEditor({ value, onChange, onBlur, readOnly = false }: BodyEditorProps) {
  return (
    <textarea
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
