import { singleLineTitle } from "@personal-wiki/domain/title";
import type { Backup, BackupStore } from "./draft-backup";
import { rebaseOnLinkRewrite, savedBeforeLeaving } from "./link-rewrite-body";
import {
  type ApiFailure,
  type ApiResult,
  failureMessage,
  type Page,
  type UpdateOptions,
  type Visibility,
} from "./pages-api";

export interface Draft {
  title: string;
  body: string;
}

export interface EditorApi {
  createPage(input: Draft): Promise<ApiResult<Page>>;
  getPage(id: string): Promise<ApiResult<Page>>;
  updatePage(
    id: string,
    version: number,
    input: Draft,
    options?: UpdateOptions,
  ): Promise<ApiResult<Page>>;
  setVisibility(id: string, version: number, visibility: Visibility): Promise<ApiResult<Page>>;
  deletePage(id: string, version: number): Promise<ApiResult<null>>;
}

export interface EditorDeps {
  api: EditorApi;
  backup: BackupStore;
  now?: () => number;
  /** 入力が止まってから保存するまでの待ち。D1 の書き込み枠を節約するため、短くしすぎない。 */
  autosaveMs?: number;
  /** フォーカス復帰の確認の最小間隔。visibilitychange と focus が続けて来ても 1 回にする。 */
  minCheckIntervalMs?: number;
  /** ログイン切れの間の入力を localStorage へ書くまでの待ち。入力のたびに書かず、まとめる。 */
  stashMs?: number;
  /**
   * title と本文のエディタの IME の変換が落ち着くまで待つ。サーバーの版を手元に入れる（重ねる、
   * そのまま取り込む）直前に呼ぶ。変換中に差し替えると、確定前の文字を含む入力が差し替えを
   * 上書きして、取り込んだ変化が戻るため。title では、他で行われた改名を打ちかけの title が上書きする。
   * エディタが無くなったときも resolve すること（書き込みの列がそこで止まる）。
   */
  whenSettled?: () => Promise<void>;
}

/** リンクの書き換えの step（`POST /api/link-rewrites/step`）が書き換えたページのうち、セッションが見る部分。 */
export interface ProcessedLinkRewrite {
  sourcePageId: string;
  version: number;
}

export type FailedOp =
  /** title は作成に送った title。重複の案内は、その後に title 欄を打ち直しても送った title で引く */
  | { kind: "create"; titleTaken: boolean; title: string }
  | { kind: "save" }
  | { kind: "visibility"; to: Visibility }
  | { kind: "delete" };

const NO_ERROR = { error: null, failedOp: null } as const;

/**
 * まだ作っていないページの退避の key の頭。画面ごとに後ろへ別の文字列を付ける。page id は英数字と
 * `-` `_` の 22 文字で `:` を含まないので重ならない。
 */
export const NEW_PAGE_BACKUP_PREFIX = "new:";

/**
 * このタブのセッションが持つ、作る前の退避の key。次の新規作成の画面は、これを復元の案内に出さない。
 * 生きている画面や作成の応答を待つ画面の内容を、別の画面で復元してもう 1 つ作らないため。
 *
 * 画面を閉じたら外し、その内容は次の新規作成の画面で復元を選ばせる。ただし作成の応答を待つ間は
 * 持ち続け、応答が失敗だったときに外す。待つ間に外すと、作れる内容を次の画面でもう 1 つ作れてしまう。
 * 別のタブの生きている画面の key はここに無いので、そちらの内容は案内に出る。
 */
const heldNewKeys = new Set<string>();
let newKeyCount = 0;

function issueNewBackupKey(): string {
  newKeyCount += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `${NEW_PAGE_BACKUP_PREFIX}${Date.now().toString(36)}-${newKeyCount}-${random}`;
}

export interface EditorState {
  /**
   * サーバーで最後に確認した内容。保存済みかどうかはこれと draft の比較で決まる。
   * 作る前は、空の title と本文の仮の版（id は空文字列、version は 0）。
   */
  base: Page;
  /** まだサーバーに無いページ。title の確定（commitTitle）で作る。 */
  uncreated: boolean;
  draft: Draft;
  /** 書き込み中の操作。作成・保存・visibility・削除は直列に走るので 1 つだけ。 */
  busy: "creating" | "saving" | "visibility" | "deleting" | null;
  /** 直近の失敗の説明。次の編集か再試行で消える。どの操作の失敗かは failedOp が持つ。 */
  error: string | null;
  /** error を起こした操作。保存の失敗だけが保存の状態（SaveStatus）になる。 */
  failedOp: FailedOp | null;
  /** 手元とサーバーが食い違っているとき、サーバーの最新。解決するまで自動保存を止める。 */
  conflict: Page | null;
  /** 401 を受けた。再ログインまで保存できない。 */
  authLost: boolean;
  /** サーバーから消えた（他で削除された、または自分で削除した）。 */
  gone: boolean;
  /** 前回退避した内容。復元か破棄を選ばせる。 */
  pendingBackup: Backup | null;
  /**
   * title 欄に打っている途中の、まだ確定していない title。null なら draft.title を表示する。
   * 確定（commitTitle、離脱）するまで draft に入れず、保存にも退避にも含めない。title の変更は
   * 他のページのリンクの書き換えを積むので、打っている途中の title で改名を繰り返さない。
   */
  titleInput: string | null;
  /**
   * 自分の保存以外で base が進んだ回数（他から入った版の取り込み、衝突の解決）。自分の保存でも
   * base.version は進むので、画面が「他で内容が変わった」を version の変化から読めない
   */
  externalBases: number;
}

export type SaveStatus =
  | "new"
  | "creating"
  | "create-error"
  | "saved"
  | "unsaved"
  | "saving"
  | "error"
  | "conflict"
  | "auth"
  | "gone";

export const isDirty = (state: Pick<EditorState, "base" | "draft">): boolean =>
  state.draft.title !== state.base.title || state.draft.body !== state.base.body;

/**
 * 手元の内容を動かしてはいけない状態。画面は入力欄を読み取り専用にし、セッションも編集を受け付けない。
 * 退避が未決の間を含めるのは、入力すると localStorage の退避を上書きし、復元か破棄を選ぶ前に
 * 前回の内容を失うため。
 */
/** title 欄に、確定していない変更がある。 */
export const hasPendingTitle = (state: Pick<EditorState, "draft" | "titleInput">): boolean =>
  state.titleInput !== null && state.titleInput !== state.draft.title;

export const isReadOnly = (
  state: Pick<EditorState, "conflict" | "gone" | "pendingBackup">,
): boolean => state.conflict !== null || state.gone || state.pendingBackup !== null;

export function saveStatusOf(state: EditorState): SaveStatus {
  if (state.gone) return "gone";
  if (state.authLost) return "auth";
  if (state.conflict !== null) return "conflict";
  if (state.busy === "creating") return "creating";
  if (state.busy === "saving") return "saving";
  if (state.error !== null && state.failedOp?.kind === "create") return "create-error";
  if (state.error !== null && state.failedOp?.kind === "save") return "error";
  if (state.uncreated) return "new";
  return isDirty(state) || hasPendingTitle(state) ? "unsaved" : "saved";
}

const placeholderPage = (now: number): Page => ({
  id: "",
  title: "",
  body: "",
  visibility: "draft",
  version: 0,
  createdAt: now,
  updatedAt: now,
});

const DEFAULT_AUTOSAVE_MS = 2000;
const DEFAULT_MIN_CHECK_MS = 3000;
const DEFAULT_STASH_MS = 1000;

/**
 * ページ 1 件の編集状態。React から切り離してあり、タイマーと API は注入できる。
 *
 * 書き込みを伴う操作（保存・visibility・削除・フォーカス復帰の確認）は 1 本の列に並べて直列に
 * 実行する。保存中に版が進むと次の If-Match が古くなるので、並行させると自分自身と衝突する。
 */
export class EditorSession {
  private state: EditorState;
  private readonly listeners = new Set<() => void>();
  private readonly api: EditorApi;
  private readonly backup: BackupStore;
  private readonly now: () => number;
  private readonly autosaveMs: number;
  private readonly minCheckMs: number;
  private readonly stashMs: number;
  private readonly whenSettled: () => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stashTimer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private lastCheckAt = Number.NEGATIVE_INFINITY;
  /**
   * leave() の後、画面が戻る（編集、フォーカス復帰）までの間 true。この間は自動保存のタイマーを立てず、
   * 手元の内容を退避に写すだけにする。画面が無いセッションのタイマーが、離脱の保存の後から
   * keepalive でない保存を 1 本出さないため。leave() は unmount のほか、タブが hidden になったときや
   * pagehide でも呼ばれ、同じセッションが戻ってくるので、leave() で止めきらず戻ったら再開する。
   * dev の StrictMode では mount の直後にも立ち、mount し直す attach で戻る。
   *
   * hidden になっただけの生きたタブも止まる。その間に重ねた取り込みや送り直しは退避に写すだけで、
   * 表に戻るまで保存しない（内容は退避に残る）。hidden と unmount を区別するより単純なのでこうしている。
   * unmount の区別が要る所（作る前のページの退避の持ち主）は closed で見る。
   */
  private left = false;
  /** 画面が unmount された（detach）。dev の StrictMode で mount し直したときは attach で戻る */
  private closed = false;
  /** 応答を待っている作成。title の Enter に続く blur が、同じページをもう 1 つ作らないようにまとめる */
  private creating: Promise<void> | null = null;
  /** まだ作っていないページの退避の key。画面ごとに別にし、作れたら消す */
  private newKey = "";
  /** pendingBackup に出している、別の画面が残した作る前の退避の key */
  private adoptedKey: string | null = null;

  /**
   * page に null を渡すと、まだ作っていないページ（新規作成の画面）として始める。title は
   * そのときの title 欄の初期値で、作成は始めない（呼び出し側が commitTitle で始める）。
   * 前の画面が残した退避は、ここではなく mount の後の adoptPendingBackup で読む。
   */
  constructor(page: Page | null, deps: EditorDeps, title = "") {
    this.api = deps.api;
    this.backup = deps.backup;
    this.now = deps.now ?? Date.now;
    this.autosaveMs = deps.autosaveMs ?? DEFAULT_AUTOSAVE_MS;
    this.minCheckMs = deps.minCheckIntervalMs ?? DEFAULT_MIN_CHECK_MS;
    this.stashMs = deps.stashMs ?? DEFAULT_STASH_MS;
    this.whenSettled = deps.whenSettled ?? (() => Promise.resolve());
    if (page === null) {
      this.newKey = issueNewBackupKey();
      heldNewKeys.add(this.newKey);
      this.state = {
        base: placeholderPage(this.now()),
        uncreated: true,
        draft: { title: singleLineTitle(title), body: "" },
        busy: null,
        ...NO_ERROR,
        conflict: null,
        authLost: false,
        gone: false,
        pendingBackup: null,
        titleInput: null,
        externalBases: 0,
      };
      return;
    }
    const saved = this.backup.load(page.id);
    // 離脱の保存が成立し、その後に step が本文を書き換えた退避は、サーバーと同じ内容として消す
    const differs =
      saved !== null &&
      (saved.title !== page.title || saved.body !== page.body) &&
      !savedBeforeLeaving(saved, page);
    if (saved !== null && !differs) this.backup.remove(page.id);
    this.state = {
      base: page,
      uncreated: false,
      draft: { title: page.title, body: page.body },
      busy: null,
      ...NO_ERROR,
      conflict: null,
      authLost: false,
      gone: false,
      pendingBackup: differs ? saved : null,
      titleInput: null,
      externalBases: 0,
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): EditorState => this.state;

  private set(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private clearStashTimer(): void {
    if (this.stashTimer !== null) clearTimeout(this.stashTimer);
    this.stashTimer = null;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** 保存を試みてよい状態か。衝突、ログイン切れ、削除済みでは手元の内容をサーバーに送らない。 */
  private canWrite(): boolean {
    const { conflict, authLost, gone } = this.state;
    return conflict === null && !authLost && !gone;
  }

  /**
   * 退避が未決の間は、localStorage の内容が前回の唯一の写しなので消さない。
   * 復元か破棄の操作（restoreBackup、discardBackup）だけが未決を解く。
   */
  private removeBackup(pageId: string): void {
    if (this.state.pendingBackup === null) this.backup.remove(pageId);
  }

  private backupKey(): string {
    return this.state.uncreated ? this.newKey : this.state.base.id;
  }

  private stash(): void {
    // 未決の間は上書きしない。手元は退避と同じ内容か、まだ復元していない
    if (this.state.pendingBackup !== null) return;
    const { base, draft, uncreated, failedOp, authLost } = this.state;
    const createFailed = uncreated && (failedOp?.kind === "create" || authLost);
    this.backup.save(this.backupKey(), {
      title: draft.title,
      body: draft.body,
      baseVersion: base.version,
      baseTitle: base.title,
      baseBody: base.body,
      savedAt: this.now(),
      ...(createFailed ? { createFailed } : {}),
    });
  }

  /** 保存できなかった手元の内容を localStorage に残す。 */
  private stashIfDirty(): void {
    if (isDirty(this.state)) this.stash();
  }

  edit(draft: Draft): void {
    // 画面側でも読み取り専用にするが、遅れて届いた入力でも手元の内容を動かさない
    if (isReadOnly(this.state)) return;
    this.markActive();
    // 作成の失敗は title を直すまで案内を残す。本文を打っても直らないので消さない
    const keepError =
      this.state.failedOp?.kind === "create" && draft.title === this.state.draft.title;
    this.set(keepError ? { draft } : { draft, ...NO_ERROR });
    this.rearm();
  }

  /**
   * 画面の操作（入力、ボタン）が届いたので、離脱で止めていた自動保存を戻す。操作の起点ごとに呼ぶ。
   * blur から来る commitTitle では呼ばない。hidden にしたときの blur が leave() の後に届くことがある。
   */
  private markActive(): void {
    this.left = false;
  }

  /**
   * 手元の内容に合わせて、保存か退避のタイマーを掛け直す。入力のほか、base を進めたあと
   * （保存中の入力、取り込み、送り直しの打ち切り）にも呼ぶ。
   */
  private rearm(): void {
    if (isReadOnly(this.state)) return;
    if (!this.state.uncreated && !isDirty(this.state)) {
      // 失敗で残した退避は、base に戻した手元と同じ内容になる。残すと次に開いたとき、
      // 保存済みの内容を復元するか尋ねてしまう（resumeOnNewBase と同じ規則）
      this.clearTimer();
      this.clearStashTimer();
      this.removeBackup(this.state.base.id);
      return;
    }
    if (this.left) {
      // 離脱の退避は古い base のままなので、重ね直した内容と新しい base で書き直す
      this.clearTimer();
      this.clearStashTimer();
      this.stashIfDirty();
      return;
    }
    if (this.state.authLost || this.state.uncreated) {
      // 保存はできないので、入力のたびに localStorage へ書かず、止まってからまとめて書く。
      // 離脱（leave）では待たずに書く
      this.clearStashTimer();
      this.stashTimer = setTimeout(() => {
        this.stashTimer = null;
        this.stashIfDirty();
      }, this.stashMs);
      return;
    }
    this.clearTimer();
    if (isDirty(this.state)) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.autosaveMs);
    }
  }

  /** title 欄の入力。確定するまで保存しない。 */
  editTitle(title: string): void {
    if (isReadOnly(this.state)) return;
    this.markActive();
    this.set({ titleInput: title });
  }

  /**
   * title 欄の確定（blur、Enter）。打っていた title を draft に入れて、すぐに保存する。
   * まだ作っていないページなら、ここで作る。アプリ内の移動（リンク、⌘K、ログアウト）で title 欄から
   * フォーカスが外れたときも作る。
   *
   * ただし離脱（leave）の後は作らず、退避だけを残す。タブを隠したときの blur は leave の後に届き、
   * 打ちかけの title でページを作ってしまうため。画面が戻れば、次の確定で作る。
   */
  commitTitle(): Promise<void> {
    this.applyPendingTitle();
    if (!this.state.uncreated) return this.flush();
    if (this.left) {
      this.stashIfDirty();
      return this.creating ?? Promise.resolve();
    }
    return this.create();
  }

  /**
   * まだ作っていないページを、手元の title と本文で作る。title が空なら作らない。
   * 応答を待つ間の入力は、作れた後に自動保存で送る。
   */
  private create(): Promise<void> {
    if (this.creating !== null) return this.creating;
    // 空の title の確定（本文へ移るときの blur など）を、作成の応答待ちにしない。待ちにすると、
    // その間の + が内容のある画面を閉じてしまう
    if (this.state.draft.title === "") return Promise.resolve();
    const run = this.enqueue(() => this.createNow()).finally(() => {
      this.creating = null;
      // 待つ間に閉じた画面で作れなかった内容は、次の新規作成の画面で復元を選ばせる
      if (this.closed && this.state.uncreated) heldNewKeys.delete(this.newKey);
    });
    this.creating = run;
    return run;
  }

  private async createNow(): Promise<void> {
    const { uncreated, draft } = this.state;
    if (!uncreated || !this.canWrite() || isReadOnly(this.state) || draft.title === "") return;
    const sent: Draft = { ...draft };
    this.clearStashTimer();
    this.set({ busy: "creating", ...NO_ERROR });
    const res = await this.api.createPage(sent);
    if (res.ok) {
      this.set({ base: res.value, uncreated: false, busy: null });
      this.backup.remove(this.newKey);
      heldNewKeys.delete(this.newKey);
      // 応答を待つ間に離れていれば rearm は退避を作ったページの key へ写すだけで、保存はしない
      if (isDirty(this.state)) this.rearm();
      return;
    }
    this.set({ busy: null });
    if (res.reason === "unauthorized") {
      this.set({ authLost: true });
    } else {
      this.set({
        error: failureMessage(res, "ページを作れませんでした。"),
        failedOp: {
          kind: "create",
          titleTaken: res.reason === "title_conflict",
          title: sent.title,
        },
      });
    }
    this.stashIfDirty();
  }

  /**
   * 前の画面が残した作る前の退避を、復元か破棄を選ばせる案内に出す。mount の後に呼ぶ。
   * 描画の中（constructor）で読むと、前の画面が unmount で書く退避より先に読んでしまう。
   *
   * 出すのは、このタブが持っていない key のもの（閉じた画面と前のタブが残したもの。heldNewKeys を
   * 参照）。いくつもあれば新しいものから 1 つずつ出す。title を渡して
   * 開いた画面と、打ち始めた画面では出さない。その退避は次の素の新規作成の画面まで残る。
   */
  adoptPendingBackup(): void {
    const { uncreated, pendingBackup, draft, titleInput } = this.state;
    if (!uncreated || pendingBackup !== null || titleInput !== null) return;
    if (draft.title !== "" || draft.body !== "") return;
    let newest: { key: string; backup: Backup } | null = null;
    for (const key of this.backup.list(NEW_PAGE_BACKUP_PREFIX)) {
      if (heldNewKeys.has(key)) continue;
      const saved = this.backup.load(key);
      if (saved === null || (saved.title === "" && saved.body === "")) continue;
      if (newest === null || saved.savedAt > newest.backup.savedAt) newest = { key, backup: saved };
    }
    if (newest === null) return;
    this.adoptedKey = newest.key;
    this.set({ pendingBackup: newest.backup });
  }

  /** 画面の mount。dev の StrictMode で unmount の後にもう一度 mount されたときも、止めた状態を戻す。 */
  attach(): void {
    this.closed = false;
    this.left = false;
    if (this.state.uncreated) heldNewKeys.add(this.newKey);
  }

  /**
   * 画面の unmount。離脱（leave）に加えて、作る前のページの退避を手放し、次の新規作成の画面で
   * 復元を選ばせる。作成の応答を待つ間は手放さず、作れなかったら応答の後に手放す。
   */
  detach(): Promise<void> {
    this.closed = true;
    const left = this.leave();
    if (this.state.uncreated && this.creating === null) heldNewKeys.delete(this.newKey);
    return left;
  }

  /** 作る前の画面で、作成の応答を待っておらず、title か本文に内容がある。 */
  holdsUncreatedContent(): boolean {
    const { uncreated, draft, titleInput } = this.state;
    if (!uncreated || this.creating !== null) return false;
    return draft.title !== "" || draft.body !== "" || (titleInput ?? "") !== "";
  }

  /**
   * 打っていた title を draft に入れる。読み取り専用の間は入れずに残す（表示は残るので、解決したあとの
   * 確定か離脱で入る）。
   *
   * 本文の自分への `[[旧 title]]` は手元では書き換えない。改名を受け入れた保存で Worker が自分も
   * リンク元として積むので、step の書き換えを取り込む。手元で先に書き換えると、title の保存が
   * 失敗したとき（title_conflict など）に受け入れられていない title が次の書き換えの基準になり、
   * 他のページへの本物のリンクまで書き換える。
   */
  private applyPendingTitle(): void {
    const { titleInput, draft } = this.state;
    if (titleInput === null || isReadOnly(this.state)) return;
    // サーバーは前後の空白を落として保存する。手元も揃えないと、保存のたびに draft と base が食い違う
    const title = singleLineTitle(titleInput);
    // 空の title は保存できない。打ったものは欄に残し、未保存として見せる
    if (title === "") return;
    this.set({ titleInput: null });
    if (title === draft.title) return;
    this.edit({ ...draft, title });
  }

  /** 変更が無ければ何も送らない。blur と離脱でも呼ぶ。 */
  flush(options: UpdateOptions = {}): Promise<void> {
    this.clearTimer();
    return this.enqueue(() => this.saveIfDirty(options));
  }

  /**
   * retried は、409 のあとにリンクの書き換えを重ねて送り直した保存。その保存がまた 409 になっても
   * すぐには送り直さず、自動保存に任せる（書き換えが続く間に送り直しを重ねない）。
   */
  private async saveIfDirty(options: UpdateOptions = {}, retried = false): Promise<void> {
    // 作る前のページは本文の blur や離脱では作らない。作るのは title の確定だけ
    if (this.state.uncreated || !this.canWrite() || !isDirty(this.state)) return;
    const { base } = this.state;
    const snapshot: Draft = { ...this.state.draft };
    this.set({ busy: "saving", ...NO_ERROR });
    const res = await this.api.updatePage(base.id, base.version, snapshot, options);
    if (res.ok) {
      this.set({ base: res.value, busy: null });
      if (isDirty(this.state)) {
        // 保存中にさらに入力があった
        this.rearm();
      } else {
        this.removeBackup(base.id);
      }
      return;
    }
    this.set({ busy: null });
    await this.handleFailure(
      res,
      { kind: "save" },
      {
        sent: snapshot,
        // 離脱の保存（keepalive）も、同じ要求の形で送り直す
        ...(retried ? {} : { resend: () => this.saveIfDirty(options, true) }),
      },
    );
  }

  /** base を進めたあと。未保存の変更が残っていれば新しい版に対して自動保存し、無ければ退避を消す。 */
  private resumeOnNewBase(): void {
    if (isDirty(this.state)) {
      this.rearm();
    } else {
      this.clearTimer();
      this.removeBackup(this.state.base.id);
    }
  }

  /**
   * server が base にリンクの書き換えだけを加えた版なら、手元の未保存の編集を重ねて base を server に
   * 進め、true を返す。自分のタブの外で走った step（起動時の再開、Cron、別のタブ）が開いているページを
   * 書き換えても、衝突の画面にしない。衝突の画面で上書きを選ぶと、その書き換えが消えるため。
   *
   * 手元の本文が base のまま（title だけの変更）なら、server の本文はリンクの書き換え以外の変更でも
   * 取り込む。server の本文が base のまま（版だけ進んだ）なら、手元の本文をそのまま残す。どちらも
   * 片方に重ねる編集が無く、title は server と base が同じことを先に確かめているので、変更を失わない。
   */
  private async rebaseOnServer(server: Page): Promise<boolean> {
    // 変換中の本文に重ねると、確定前の文字を含む入力が重ねた本文を上書きする。title が違って
    // 重ねないときも待つのは、false を受けた takeIn がサーバーの版をそのまま取り込むことがあるため
    await this.whenSettled();
    const { base, draft, pendingBackup } = this.state;
    // 退避が未決の間は、復元か破棄を選ぶまで手元を動かさない
    if (!this.canWrite() || pendingBackup !== null || server.title !== base.title) return false;
    // step は title を変えない。手元の確定済みで未保存の title はそのまま残す
    const body = rebaseOnLinkRewrite(base.body, server.body, draft.body);
    if (body === null) return false;
    this.set({
      base: server,
      draft: { title: draft.title, body },
      externalBases: this.state.externalBases + 1,
      ...NO_ERROR,
    });
    return true;
  }

  /**
   * サーバーで進んだ版を手元に入れる。重ねられる差分（rebaseOnServer）なら手元の編集に重ね、そうでなければ、
   * 手元に未保存の変更が無いときだけそのまま取り込み、あれば衝突にする。
   */
  private async takeIn(server: Page): Promise<void> {
    if (await this.rebaseOnServer(server)) {
      this.resumeOnNewBase();
      return;
    }
    if (!this.canWrite()) return;
    this.clearTimer();
    if (!isDirty(this.state)) {
      this.adoptServer(server);
      return;
    }
    this.set({ conflict: server });
    this.stash();
  }

  /**
   * 手元に残す未保存の変更が無い（または手元がサーバーと同じ内容の）まま、サーバーの版を手元に入れる。
   *
   * 打っている途中の title（titleInput）は、サーバーの title が手元の既知の title（base か draft）の
   * ままなら残す。取り込むのは本文や公開設定の変化で、打ちかけの title に影響しないため。
   * サーバーの title が変わっていたら捨てる。残して確定すると、他で行われた改名を衝突の確認なしに
   * 上書きする。
   */
  private adoptServer(server: Page): void {
    const { base, draft, titleInput } = this.state;
    this.clearTimer();
    this.set({
      base: server,
      draft: { title: server.title, body: server.body },
      titleInput: server.title === base.title || server.title === draft.title ? titleInput : null,
      externalBases: this.state.externalBases + 1,
    });
    this.removeBackup(server.id);
  }

  /**
   * 書き込みの失敗を状態に反映する。version_conflict はサーバーの最新を取り直して衝突にする。
   * resend は保存の失敗にだけ渡す。リンクの書き換えを重ねられたら、その版に対して送り直す。
   */
  private async handleFailure(
    res: ApiFailure,
    op: FailedOp,
    options: { stash?: boolean; sent?: Draft; resend?: () => Promise<void> } = {},
  ): Promise<void> {
    const stash = options.stash ?? true;
    switch (res.reason) {
      case "unauthorized":
        this.set({ authLost: true });
        if (stash) this.stashIfDirty();
        return;
      case "not_found":
        this.set({ gone: true });
        if (stash) this.stashIfDirty();
        return;
      case "version_conflict": {
        const latest = await this.api.getPage(this.state.base.id);
        if (latest.ok) {
          const server = latest.value;
          const { sent } = options;
          // 別の場所で同じ内容が保存されていれば、見せる差分が無いので衝突にしない
          // （削除や visibility の変更は、版が変わったこと自体を知らせたいので対象外）。
          // 比べるのは送った内容。最新を取り直す間に入力が進んでも、それは別の編集であり衝突ではない
          if (sent !== undefined && server.title === sent.title && server.body === sent.body) {
            this.set({ base: server, ...NO_ERROR });
            // 取り直す間の入力は、新しい版に対して自動保存する
            this.resumeOnNewBase();
            return;
          }
          if (sent !== undefined && (await this.rebaseOnServer(server))) {
            if (options.resend !== undefined && isDirty(this.state)) {
              this.clearTimer();
              await options.resend();
            } else {
              this.resumeOnNewBase();
            }
            return;
          }
          this.set({ conflict: server });
        } else if (latest.reason === "unauthorized") this.set({ authLost: true });
        else if (latest.reason === "not_found") this.set({ gone: true });
        else
          this.set({
            error: `別の場所で更新されていますが、最新の内容を取得できませんでした。${failureMessage(latest, "通信に失敗しました。")}`,
            failedOp: op,
          });
        if (stash) this.stashIfDirty();
        return;
      }
      case "title_conflict":
      case "error":
        this.set({ error: res.message, failedOp: op });
        // 画面を閉じたり離れたりする前に、手元の内容を端末に残す。ログイン切れや衝突の失敗と同じ
        if (stash) this.stashIfDirty();
        return;
    }
  }

  /** フォーカス復帰で呼ぶ。手元に未保存の変更が無ければ最新を読み直し、あれば衝突にする。 */
  checkFreshness(): Promise<void> {
    if (this.left) {
      // 画面が戻った。離脱の間に止めていた自動保存を再開する
      this.markActive();
      if (isDirty(this.state)) this.rearm();
    }
    return this.enqueue(async () => {
      if (this.state.uncreated || !this.canWrite()) return;
      const at = this.now();
      if (at - this.lastCheckAt < this.minCheckMs) return;
      this.lastCheckAt = at;
      const { base } = this.state;
      const res = await this.api.getPage(base.id);
      if (!res.ok) {
        if (res.reason === "unauthorized") {
          this.set({ authLost: true });
          this.stashIfDirty();
        } else if (res.reason === "not_found") {
          this.set({ gone: true });
          this.stashIfDirty();
        }
        // 通信の失敗は次の復帰でまた確認する
        return;
      }
      const server = res.value;
      if (server.version === this.state.base.version) return;
      // 変換中の title や本文をサーバーの版で差し替えない（EditorDeps.whenSettled）。変換が始まった
      // だけで titleInput がまだ null のこともあるので、手元の状態によらず待つ
      await this.whenSettled();
      if (!this.canWrite()) return;
      // 確認の応答と変換を待つ間の入力も含めて、待ち終えた時点の手元で判断する
      const same = server.title === this.state.draft.title && server.body === this.state.draft.body;
      if (!isDirty(this.state) || same) {
        this.adoptServer(server);
        return;
      }
      await this.takeIn(server);
    });
  }

  /**
   * step が開いているこのページを書き換えたら、その版を取り込む。取り込みは保存と同じ列に並べる。
   *
   * step の要求そのものは列に並べない。並べると、離脱の保存（keepalive）が step の応答を待ち、
   * ページが閉じるまでに送られないことがある。保存と step が行き違っても、step は版の照合で
   * conflict を返して呼び直され、保存の 409 は書き換えを重ねて送り直すので、手元の編集は失わない。
   */
  linkRewritten(processed: ProcessedLinkRewrite): Promise<void> {
    if (this.state.uncreated || processed.sourcePageId !== this.state.base.id) {
      return Promise.resolve();
    }
    return this.enqueue(() => this.adoptLinkRewrite(processed.version));
  }

  /**
   * step が書き換えた版を取り込む。手元に未保存の編集があれば、サーバーの書き換えを重ねる。
   * 書き換えだけでは説明できない変化（別の場所の保存）が混ざっていれば、衝突にする。手元の本文が
   * base のまま（title だけの変更）なら、その変化も取り込む（rebaseOnServer の規則）。
   *
   * 取り直した版が step の書いた版より新しくても、重ねるかどうかは版の番号ではなく内容で決める。
   * 間に入ったのが別の step（Cron、別のタブ）の書き換えなら重ねてよく、別の保存なら内容の照合で
   * 衝突になる。
   */
  private async adoptLinkRewrite(version: number): Promise<void> {
    if (!this.canWrite() || this.state.base.version >= version) return;
    const res = await this.api.getPage(this.state.base.id);
    if (!res.ok) {
      if (res.reason === "unauthorized") {
        this.set({ authLost: true });
        this.stashIfDirty();
      } else if (res.reason === "not_found") {
        this.set({ gone: true });
        this.stashIfDirty();
      }
      // 通信の失敗では取り込まない。次の保存が 409 になったときに取り直して重ねる
      return;
    }
    const server = res.value;
    if (server.version <= this.state.base.version) return;
    await this.takeIn(server);
  }

  /** 衝突を手元の内容で解決する。サーバーの最新の版に重ねて保存する。 */
  overwrite(): Promise<void> {
    this.markActive();
    return this.enqueue(async () => {
      const { conflict } = this.state;
      if (conflict === null) return;
      this.set({
        base: conflict,
        conflict: null,
        externalBases: this.state.externalBases + 1,
      });
      await this.saveIfDirty();
    });
  }

  /** 衝突をサーバーの最新で解決する。手元の未保存の内容は捨てる。 */
  takeServer(): void {
    const { conflict } = this.state;
    if (conflict === null) return;
    this.clearTimer();
    this.set({
      base: conflict,
      draft: { title: conflict.title, body: conflict.body },
      conflict: null,
      titleInput: null,
      externalBases: this.state.externalBases + 1,
      ...NO_ERROR,
    });
    this.removeBackup(conflict.id);
  }

  /** ログイン切れの後、別のタブなどでログインし直したときの再試行。 */
  retry(): Promise<void> {
    this.markActive();
    this.set({ authLost: false, ...NO_ERROR });
    return this.state.uncreated ? this.create() : this.flush();
  }

  /** 作成の失敗の再試行。title を変えずに、もう一度作る。 */
  retryCreate(): Promise<void> {
    this.markActive();
    return this.create();
  }

  /**
   * 退避した内容を手元に戻す。退避した時点の版と今のサーバーの版が違えば、そのまま保存すると
   * 間の変更を上書きするので、衝突として扱い差分を確認させる。
   *
   * 退避した時点から title が変わらず、サーバーの本文の差分がリンクの書き換えだけなら（退避の本文が
   * base のまま、またはサーバーの本文が退避の base のままの場合を含む）、衝突にせず退避の編集を重ねる。
   * タブを閉じた場合は、離脱の保存の送り直しが成立せず、退避が古い版のまま残るため。
   *
   * 重ねるのは編集中の rebaseOnServer と同じ規則だが、こちらは whenSettled を待たず同期で行う。
   * 退避が未決の間も入力欄では変換を始められるが、読み取り専用の changeFilter が確定を落とし、
   * edit() も読み取り専用で弾き、本文の差し替え（replaceDoc）は変換が終わるまで保留されるので、
   * 確定前の文字が重ねた本文を上書きしない。この前提が崩れたら whenSettled を待つ形に戻す。
   */
  restoreBackup(): void {
    const saved = this.state.pendingBackup;
    if (saved === null) return;
    this.markActive();
    const draft = { title: saved.title, body: saved.body };
    this.set({ pendingBackup: null, titleInput: null });
    if (this.state.uncreated) {
      // 戻した退避の key をこの画面のものとして持ち、作れたときに消す。自分の key に写し直さないのは、
      // 作るまでの間に閉じても内容を残すため。title があれば、確定し直させずにそのまま作る
      if (this.adoptedKey !== null) {
        heldNewKeys.delete(this.newKey);
        this.backup.remove(this.newKey);
        this.newKey = this.adoptedKey;
        heldNewKeys.add(this.newKey);
        this.adoptedKey = null;
      }
      this.edit(draft);
      if (draft.title !== "") void this.create();
      return;
    }
    if (saved.baseVersion === this.state.base.version) {
      this.edit(draft);
      return;
    }
    const body = this.rebaseBackup(saved);
    if (body !== null) {
      this.set({ draft: { title: saved.title, body }, ...NO_ERROR });
      this.resumeOnNewBase();
      return;
    }
    this.set({ draft, conflict: this.state.base });
  }

  private rebaseBackup(saved: Backup): string | null {
    const { base } = this.state;
    if (saved.baseBody === undefined || saved.baseTitle !== base.title) return null;
    return rebaseOnLinkRewrite(saved.baseBody, base.body, saved.body);
  }

  discardBackup(): void {
    if (this.state.pendingBackup === null) return;
    this.backup.remove(this.adoptedKey ?? this.backupKey());
    this.adoptedKey = null;
    this.set({ pendingBackup: null });
  }

  /** 未保存の変更を先に保存してから変える。保存できなければ visibility は変えない。 */
  changeVisibility(visibility: Visibility): Promise<void> {
    this.markActive();
    return this.enqueue(async () => {
      if (this.state.uncreated) return;
      this.clearTimer();
      // 前回の失敗が残っていると、下の判定が保存の失敗と取り違える
      this.set(NO_ERROR);
      await this.saveIfDirty();
      // 保存できなかった（衝突、ログイン切れ、失敗）なら、画面の状態表示に任せて visibility は変えない
      if (!this.canWrite() || this.state.error !== null) return;
      if (this.state.base.visibility === visibility) return;
      const { base } = this.state;
      this.set({ busy: "visibility", ...NO_ERROR });
      const res = await this.api.setVisibility(base.id, base.version, visibility);
      this.set({ busy: null });
      if (!res.ok) {
        await this.handleFailure(res, { kind: "visibility", to: visibility });
        return;
      }
      const server = res.value;
      // If-Match を照合しない Worker でも、他の保存を踏み越えて版を進めないよう内容を確かめる
      if (server.title !== base.title || server.body !== base.body) {
        this.set({ conflict: server });
        this.stash();
        return;
      }
      this.set({ base: server });
      if (isDirty(this.state)) this.rearm();
    });
  }

  /** 成功したら true。呼び出し側が一覧へ戻る。 */
  remove(): Promise<boolean> {
    return this.enqueue(async () => {
      // 退避が未決のまま消すと、復元の機会を失う
      if (this.state.uncreated || !this.canWrite() || this.state.pendingBackup !== null) {
        return false;
      }
      this.clearTimer();
      const { base } = this.state;
      this.set({ busy: "deleting", ...NO_ERROR });
      const res = await this.api.deletePage(base.id, base.version);
      this.set({ busy: null });
      if (res.ok) {
        this.removeBackup(base.id);
        this.set({ gone: true });
        return true;
      }
      await this.handleFailure(res, { kind: "delete" }, { stash: false });
      return false;
    });
  }

  /**
   * ページを離れるとき。打っていた title を確定し、未保存の内容を退避してから保存を試みる。
   * まだ作っていないページは作らず、退避だけを残す。
   *
   * 作成の応答を待っている間に離れたら、作れた後も、待つ間に打った本文を送らない。アプリ内の移動でも
   * 同じにする。離れた後のセッションには画面が無く、その保存が衝突や失敗になっても見せられないため。
   * 本文は作れた時点で作ったページの id の退避に移す（rearm）ので、次にそのページを開くと復元を選べる。
   * タブを隠しただけ（画面は残る）なら、戻った後の自動保存で送る。
   */
  leave(): Promise<void> {
    this.applyPendingTitle();
    this.left = true;
    this.clearTimer();
    this.clearStashTimer();
    if (!this.state.gone) this.stashIfDirty();
    if (this.state.uncreated) return Promise.resolve();
    return this.flush({ keepalive: true });
  }
}
