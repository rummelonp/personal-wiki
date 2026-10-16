import { formatCount } from "./input-messages";

/** この割合から、上限が近いことを強めて見せる */
const NEAR_RATIO = 0.9;

interface InputMeterProps {
  /** 読み上げで数の前に添える、何の長さか（「本文の長さ」など） */
  label: string;
  bytes: number;
  max: number;
}

/**
 * 入力の長さを「12,345 / 65,536 バイト」と出す。上限がバイトで決まっているので、文字数に直さない。
 * 打つたびに数が変わるので live region にしない。上限を超えたことは保存の状態と通知が伝える。
 */
export function InputMeter({ label, bytes, max }: InputMeterProps) {
  const level = bytes > max ? "over" : bytes >= max * NEAR_RATIO ? "near" : "normal";
  return (
    <span className={`input-meter input-meter-${level}`}>
      {level !== "normal" && <span className="dot" aria-hidden="true" />}
      <span className="visually-hidden">{`${label} `}</span>
      {`${formatCount(bytes)} / ${formatCount(max)} バイト`}
    </span>
  );
}
