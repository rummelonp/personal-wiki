import { formatCount } from "./input-messages";

/**
 * 長さをこの割合から出す。短い入力が大半なので、常に出すと数が入力欄の下で目に付くだけになる。
 * title と本文のメーターで共通にする。
 */
export const METER_SHOW_RATIO = 0.8;

/** この割合から、上限が近いことを強めて見せる */
const NEAR_RATIO = 0.9;

interface InputMeterProps {
  /** 読み上げで数の前に添える、何の長さか（「本文の長さ」など） */
  label: string;
  bytes: number;
  max: number;
}

/**
 * 入力の長さを「12,345 / 65,536バイト」と出す。上限がバイトで決まっているので、文字数に直さない。
 * 打つたびに数が変わるので live region にしない。上限を超えたことは、入力の問題の通知が見た目で、
 * 見えない status が読み上げで伝える（PageEditor）。
 */
export function InputMeter({ label, bytes, max }: InputMeterProps) {
  const level = bytes > max ? "over" : bytes >= max * NEAR_RATIO ? "near" : "normal";
  return (
    <span className={`input-meter input-meter-${level}`}>
      {level !== "normal" && <span className="dot" aria-hidden="true" />}
      <span className="visually-hidden">{`${label} `}</span>
      {`${formatCount(bytes)} / ${formatCount(max)}バイト`}
    </span>
  );
}
