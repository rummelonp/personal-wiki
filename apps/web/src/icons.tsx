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
      strokeLinejoin="round"
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

export function LogoutIcon() {
  return (
    <Icon>
      <path d="M6.5 2.5h-3v11h3M10 5l3 3-3 3M13 8H6.5" />
    </Icon>
  );
}

export function ConnectionIcon() {
  return (
    <Icon>
      <path d="M6.75 9.25a2.5 2.5 0 0 0 3.5 0l2.25-2.25a2.5 2.5 0 0 0-3.5-3.5l-.75.75M9.25 6.75a2.5 2.5 0 0 0-3.5 0L3.5 9a2.5 2.5 0 0 0 3.5 3.5l.75-.75" />
    </Icon>
  );
}

export function ChevronDownIcon() {
  return (
    <Icon>
      <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Icon>
  );
}
