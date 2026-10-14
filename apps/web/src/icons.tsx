import type { ReactNode } from "react";

// 装飾なので読み上げ対象から外す。名前はボタンや行の文言（aria-label）が持つ
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      {children}
    </svg>
  );
}

export function SearchIcon() {
  return (
    <Icon>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M8 3v10M3 8h10" />
    </Icon>
  );
}
