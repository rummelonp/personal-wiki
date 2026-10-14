import { createContext, type ReactNode, useContext, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { bindNoticeDock } from "./notice-dock";

/**
 * 通知を重ねて出す台。undefined は台が無い（部品だけを描画する）ので通知をその場に出し、
 * null は台の要素を作っている最中なので出さない。
 */
const DockContext = createContext<HTMLElement | null | undefined>(undefined);

/** アプリの骨格に 1 つ置く。通知（Notice）は画面の下端に固定したこの台へ出て、本文の流れを動かさない。 */
export function NoticeDockProvider({ children }: { children: ReactNode }) {
  const [dock, setDock] = useState<HTMLElement | null>(null);
  useEffect(() => (dock === null ? undefined : bindNoticeDock(dock)), [dock]);
  return (
    <DockContext value={dock}>
      {children}
      {/* 空の間は :empty で畳む。子を足すのは Notice の portal だけなので、空白文字を置かない */}
      <div className="notice-dock" ref={setDock} />
    </DockContext>
  );
}

export type NoticeTone = "info" | "warn" | "error";

interface NoticeProps {
  /** 重大度。error は失敗、warn は手元の内容に関わる注意、info は報告や案内。 */
  tone: NoticeTone;
  /** 何が起きたか。1 文で言い切る。 */
  title: string;
  /** 理由とどうすればよいか。 */
  children?: ReactNode;
  /** 操作。主な操作は button-main、ほかは button にする。塗りの強調（button-primary）は画面の主操作に譲る。 */
  actions?: ReactNode;
  /** alert は気づかせて操作を求めるもの、status は進み具合や結果の報告。 */
  role?: "alert" | "status";
  /** 本文の流れの中にそのまま置く（画面全体の読み込みの失敗など、押し下げる相手がいない場所）。 */
  inline?: boolean;
  /** 操作の下に続けて置く内容（衝突の差分など）。 */
  details?: ReactNode;
}

/**
 * 通知の部品。見出し（何が起きたか）、本文（理由と次の手）、操作の順に並べ、色は tone で分ける。
 * 既定では台に重ねて出し、title と本文の位置を動かさない。
 */
export function Notice({
  tone,
  title,
  children,
  actions,
  role = "alert",
  inline = false,
  details,
}: NoticeProps) {
  const dock = useContext(DockContext);
  const headingId = useId();
  const notice = (
    <section className={`notice notice-${tone}`} role={role} aria-labelledby={headingId}>
      <h2 id={headingId} className="notice-title">
        <span className="dot" aria-hidden="true" />
        {title}
      </h2>
      {children !== undefined && <div className="notice-text">{children}</div>}
      {actions !== undefined && <div className="actions">{actions}</div>}
      {details}
    </section>
  );
  if (inline || dock === undefined) return notice;
  return dock === null ? null : createPortal(notice, dock);
}
