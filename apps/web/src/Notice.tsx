import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { focusAfterInput, trackInputModality } from "./input-modality";
import { bindNoticeDock } from "./notice-dock";

/**
 * 通知を重ねて出すドック。undefined はドックが無い（コンポーネントだけを描画する）ので通知をその場に出し、
 * null はドックの要素を作っている最中なので出さない。
 */
const DockContext = createContext<HTMLElement | null | undefined>(undefined);

/** アプリの骨格に 1 つ置く。通知（Notice）は画面の下端に固定したこのドックへ出て、本文の流れを動かさない。 */
export function NoticeDockProvider({ children }: { children: ReactNode }) {
  const [dock, setDock] = useState<HTMLElement | null>(null);
  useEffect(() => (dock === null ? undefined : bindNoticeDock(dock)), [dock]);
  useEffect(() => trackInputModality(), []);
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
  /**
   * alert は気づかせて操作を求めるもの、status は結果の報告。
   * 読み上げの範囲は見出し、本文、操作までで、details は含めない。
   */
  role?: "alert" | "status";
  /**
   * 通知自体を読み上げない。進み具合のように値が刻々と変わる通知は、変わるたびに読み直されるので、
   * 別に短い読み上げを置く。
   */
  silent?: boolean;
  /** 本文の流れの中にそのまま置く（画面全体の読み込みの失敗など、押し下げる相手がいない場所）。 */
  inline?: boolean;
  /** 操作の下に続けて置く内容（衝突の差分など）。読み上げには含めない。 */
  details?: ReactNode;
  /**
   * 通知が出たとき、見出しへ focus を移す。ドックは main の外にあり、操作を求める通知へ Tab で届くまでが遠いため。
   * 本文や title を打っている最中は奪わない（入力を止め、IME の変換を切るので）。その場合は
   * alert の読み上げだけで知らせる。
   */
  claimFocus?: boolean;
  /**
   * 通知の要素が受け取る focus と pointer の handler。時間で下げる通知が、読んでいる間や操作している間は
   * 下げないために使う。ドックに出る通知も、React の木の上では呼び出し元の中なので、ドックの外から指定できる。
   */
  interaction?: NoticeInteraction;
}

export type NoticeInteraction = Pick<
  HTMLAttributes<HTMLElement>,
  "onFocus" | "onBlur" | "onPointerEnter" | "onPointerLeave"
>;

/** 文字を打っている最中の要素か。 */
function isTyping(element: Element | null): boolean {
  if (element === null) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * 通知のコンポーネント。見出し（何が起きたか）、本文（理由と次の手）、操作の順に並べ、色は tone で分ける。
 * 既定ではドックに重ねて出し、title と本文の位置を動かさない。
 */
export function Notice({
  tone,
  title,
  children,
  actions,
  role = "alert",
  silent = false,
  inline = false,
  details,
  claimFocus = false,
  interaction,
}: NoticeProps) {
  const dock = useContext(DockContext);
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // dock が undefined（ドックが無い）なら null でないので、null の間（ドックの要素を作っている最中）だけ置かない
  const placed = inline || dock !== null;
  useEffect(() => {
    if (!claimFocus || !placed) return;
    if (isTyping(document.activeElement)) return;
    if (heading.current !== null) focusAfterInput(heading.current, { preventScroll: true });
  }, [claimFocus, placed]);
  const notice = (
    <section className={`notice notice-${tone}`} {...interaction}>
      <div className="notice-main" {...(silent ? {} : { role, "aria-labelledby": headingId })}>
        <h2
          id={headingId}
          className="notice-title"
          ref={heading}
          tabIndex={claimFocus ? -1 : undefined}
        >
          <span className="dot" aria-hidden="true" />
          {title}
        </h2>
        {children !== undefined && <div className="notice-text">{children}</div>}
        {actions !== undefined && <div className="actions">{actions}</div>}
      </div>
      {details}
    </section>
  );
  if (inline || dock === undefined) return notice;
  return dock === null ? null : createPortal(notice, dock);
}
