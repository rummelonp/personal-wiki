import type { Backup, BackupStore } from "./draft-backup";
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
}

export interface EditorState {
  /** サーバーで最後に確認した内容。保存済みかどうかはこれと draft の比較で決まる。 */
  base: Page;
  draft: Draft;
  /** 書き込み中の操作。保存・visibility・削除は直列に走るので 1 つだけ。 */
  busy: "saving" | "visibility" | "deleting" | null;
  /** 直近の保存や操作の失敗。次の編集か再試行で消える。 */
  error: string | null;
  /** 手元とサーバーが食い違っているとき、サーバーの最新。解決するまで自動保存を止める。 */
  conflict: Page | null;
  /** 401 を受けた。再ログインまで保存できない。 */
  authLost: boolean;
  /** サーバーから消えた（他で削除された、または自分で削除した）。 */
  gone: boolean;
  /** 前回退避した内容。復元か破棄を選ばせる。 */
  pendingBackup: Backup | null;
}

export type SaveStatus = "saved" | "unsaved" | "saving" | "error" | "conflict" | "auth" | "gone";

export const isDirty = (state: Pick<EditorState, "base" | "draft">): boolean =>
  state.draft.title !== state.base.title || state.draft.body !== state.base.body;

/**
 * 手元の内容を動かしてはいけない状態。画面は入力欄を読み取り専用にし、セッションも編集を受け付けない。
 * 退避が未決の間を含めるのは、入力すると localStorage の退避を上書きし、復元か破棄を選ぶ前に
 * 前回の内容を失うため。
 */
export const isReadOnly = (
  state: Pick<EditorState, "conflict" | "gone" | "pendingBackup">,
): boolean => state.conflict !== null || state.gone || state.pendingBackup !== null;

export function saveStatusOf(state: EditorState): SaveStatus {
  if (state.gone) return "gone";
  if (state.authLost) return "auth";
  if (state.conflict !== null) return "conflict";
  if (state.busy === "saving") return "saving";
  if (state.error !== null) return "error";
  return isDirty(state) ? "unsaved" : "saved";
}

const DEFAULT_AUTOSAVE_MS = 2000;
const DEFAULT_MIN_CHECK_MS = 3000;

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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private lastCheckAt = Number.NEGATIVE_INFINITY;

  constructor(page: Page, deps: EditorDeps) {
    this.api = deps.api;
    this.backup = deps.backup;
    this.now = deps.now ?? Date.now;
    this.autosaveMs = deps.autosaveMs ?? DEFAULT_AUTOSAVE_MS;
    this.minCheckMs = deps.minCheckIntervalMs ?? DEFAULT_MIN_CHECK_MS;
    const saved = this.backup.load(page.id);
    const differs = saved !== null && (saved.title !== page.title || saved.body !== page.body);
    if (saved !== null && !differs) this.backup.remove(page.id);
    this.state = {
      base: page,
      draft: { title: page.title, body: page.body },
      busy: null,
      error: null,
      conflict: null,
      authLost: false,
      gone: false,
      pendingBackup: differs ? saved : null,
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

  private stash(): void {
    // 未決の間は上書きしない。手元は退避と同じ内容か、まだ復元していない
    if (this.state.pendingBackup !== null) return;
    const { base, draft } = this.state;
    this.backup.save(base.id, {
      title: draft.title,
      body: draft.body,
      baseVersion: base.version,
      savedAt: this.now(),
    });
  }

  /** 保存できなかった手元の内容を localStorage に残す。 */
  private stashIfDirty(): void {
    if (isDirty(this.state)) this.stash();
  }

  edit(draft: Draft): void {
    // 画面側でも読み取り専用にするが、遅れて届いた入力でも手元の内容を動かさない
    if (isReadOnly(this.state)) return;
    const { authLost } = this.state;
    this.set({ draft, error: null });
    if (authLost) {
      this.stashIfDirty();
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

  /** 変更が無ければ何も送らない。blur と離脱でも呼ぶ。 */
  flush(options: UpdateOptions = {}): Promise<void> {
    this.clearTimer();
    return this.enqueue(() => this.saveIfDirty(options));
  }

  private async saveIfDirty(options: UpdateOptions = {}): Promise<void> {
    if (!this.canWrite() || !isDirty(this.state)) return;
    const { base } = this.state;
    const snapshot: Draft = { ...this.state.draft };
    this.set({ busy: "saving", error: null });
    const res = await this.api.updatePage(base.id, base.version, snapshot, options);
    if (res.ok) {
      this.set({ base: res.value, busy: null });
      if (isDirty(this.state)) {
        // 保存中にさらに入力があった
        this.edit(this.state.draft);
      } else {
        this.removeBackup(base.id);
      }
      return;
    }
    this.set({ busy: null });
    await this.handleFailure(res, { sent: snapshot });
  }

  /** 書き込みの失敗を状態に反映する。version_conflict はサーバーの最新を取り直して衝突にする。 */
  private async handleFailure(
    res: ApiFailure,
    options: { stash?: boolean; sent?: Draft } = {},
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
            this.set({ base: server, error: null });
            if (isDirty(this.state)) {
              // 取り直す間の入力を、新しい版に対して自動保存する
              this.edit(this.state.draft);
            } else {
              this.clearTimer();
              this.removeBackup(server.id);
            }
            return;
          }
          this.set({ conflict: server });
        } else if (latest.reason === "unauthorized") this.set({ authLost: true });
        else if (latest.reason === "not_found") this.set({ gone: true });
        else
          this.set({
            error: `版が合わず、最新を取得できなかった（${failureMessage(latest, "通信の失敗")}）`,
          });
        if (stash) this.stashIfDirty();
        return;
      }
      case "title_conflict":
      case "error":
        this.set({ error: res.message });
        return;
    }
  }

  /** フォーカス復帰で呼ぶ。手元に未保存の変更が無ければ最新を読み直し、あれば衝突にする。 */
  checkFreshness(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.canWrite() || this.state.busy !== null) return;
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
      // 確認の応答を待つ間の入力も含めて、返ってきた時点の手元で判断する
      const same = server.title === this.state.draft.title && server.body === this.state.draft.body;
      if (!isDirty(this.state) || same) {
        this.clearTimer();
        this.set({ base: server, draft: { title: server.title, body: server.body } });
        this.removeBackup(server.id);
        return;
      }
      this.clearTimer();
      this.set({ conflict: server });
      this.stash();
    });
  }

  /** 衝突を手元の内容で解決する。サーバーの最新の版に重ねて保存する。 */
  overwrite(): Promise<void> {
    return this.enqueue(async () => {
      const { conflict } = this.state;
      if (conflict === null) return;
      this.set({ base: conflict, conflict: null });
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
      error: null,
    });
    this.removeBackup(conflict.id);
  }

  /** ログイン切れの後、別のタブなどでログインし直したときの再試行。 */
  retry(): Promise<void> {
    this.set({ authLost: false, error: null });
    return this.flush();
  }

  /**
   * 退避した内容を手元に戻す。退避した時点の版と今のサーバーの版が違えば、そのまま保存すると
   * 間の変更を上書きするので、衝突として扱い差分を確認させる。
   */
  restoreBackup(): void {
    const saved = this.state.pendingBackup;
    if (saved === null) return;
    const draft = { title: saved.title, body: saved.body };
    this.set({ pendingBackup: null });
    if (saved.baseVersion !== this.state.base.version) {
      this.set({ draft, conflict: this.state.base });
      return;
    }
    this.edit(draft);
  }

  discardBackup(): void {
    if (this.state.pendingBackup === null) return;
    this.backup.remove(this.state.base.id);
    this.set({ pendingBackup: null });
  }

  /** 未保存の変更を先に保存してから変える。保存できなければ visibility は変えない。 */
  changeVisibility(visibility: Visibility): Promise<void> {
    return this.enqueue(async () => {
      this.clearTimer();
      await this.saveIfDirty();
      // 保存できなかった（衝突、ログイン切れ、失敗）なら、画面の状態表示に任せて visibility は変えない
      if (!this.canWrite() || this.state.error !== null) return;
      if (this.state.base.visibility === visibility) return;
      const { base } = this.state;
      this.set({ busy: "visibility", error: null });
      const res = await this.api.setVisibility(base.id, base.version, visibility);
      this.set({ busy: null });
      if (!res.ok) {
        await this.handleFailure(res);
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
      if (isDirty(this.state)) this.edit(this.state.draft);
    });
  }

  /** 成功したら true。呼び出し側が一覧へ戻る。 */
  remove(): Promise<boolean> {
    return this.enqueue(async () => {
      // 退避が未決のまま消すと、復元の機会を失う
      if (!this.canWrite() || this.state.pendingBackup !== null) return false;
      this.clearTimer();
      const { base } = this.state;
      this.set({ busy: "deleting", error: null });
      const res = await this.api.deletePage(base.id, base.version);
      this.set({ busy: null });
      if (res.ok) {
        this.removeBackup(base.id);
        this.set({ gone: true });
        return true;
      }
      await this.handleFailure(res, { stash: false });
      return false;
    });
  }

  /** ページを離れるとき。タイマーを止めて、未保存の内容を退避してから保存を試みる。 */
  leave(): Promise<void> {
    this.clearTimer();
    if (!this.state.gone) this.stashIfDirty();
    return this.flush({ keepalive: true });
  }
}
