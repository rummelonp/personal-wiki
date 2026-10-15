import type { ProcessedLinkRewrite } from "./editor-session";
import { type StepResult, stepLinkRewrites } from "./link-rewrites-api";
import type { Visibility } from "./pages-api";

/*
 * title の変更で Worker が積んだリンクの書き換えを、step を繰り返して最後まで進める。
 * step は 1 回でリンク元 1 ページを処理する。同時に呼ぶと同じリンク元を取り合って失敗が増えるので、
 * タブの中では 1 本のループだけが呼ぶ。
 */

export interface RewrittenPage {
  id: string;
  title: string;
  visibility: Visibility;
}

export interface LinkRewriteState {
  /** idle は何も見せない。done と stopped は閉じるまで結果を見せる */
  status: "idle" | "running" | "done" | "stopped";
  /** このループで処理を終えたリンク元の数 */
  done: number;
  /** done と、Worker が最後に知らせた残りの数の和 */
  total: number;
  rewritten: RewrittenPage[];
  /** 書き換えられなかったリンク元の id（意図しない変化が出る、本文の上限を超える、試行の上限に達した） */
  failed: string[];
  /** auth はログインが切れたか書き込めない、error は通信や衝突が続いて諦めた */
  stopReason: "auth" | "error" | null;
}

/** 開いているエディタ。step が書き換えたページが自分なら、その版を取り込む（EditorSession.linkRewritten）。 */
export interface LinkRewriteParticipant {
  linkRewritten(processed: ProcessedLinkRewrite): Promise<void>;
}

export interface LinkRewriteRunnerDeps {
  step: () => Promise<StepResult>;
  sleep: (ms: number) => Promise<void>;
}

/** conflict は他の保存と重なっただけなので待って呼び直す。続くなら他で書き続けているので諦める */
export const CONFLICT_WAIT_MS = 1_000;
export const MAX_CONFLICTS = 20;
/** 通信の失敗は間を広げて呼び直す。この回数を超えたら止め、手動の再試行に任せる */
export const ERROR_WAITS_MS = [1_000, 2_000, 4_000];

const IDLE: LinkRewriteState = {
  status: "idle",
  done: 0,
  total: 0,
  rewritten: [],
  failed: [],
  stopReason: null,
};

export class LinkRewriteRunner {
  private state: LinkRewriteState = IDLE;
  private readonly listeners = new Set<() => void>();
  private readonly participants = new Set<{ participant: LinkRewriteParticipant }>();
  /** ループを捨てるたびに進める。古いループは結果を書かずに抜ける */
  private generation = 0;
  /** ループが走っている。status は何も見せない間（起動時の再開）も idle なので、別に持つ */
  private active = false;
  /** 走っている間に start が来た。残りが 0 になっても、もう一度呼んで確かめる */
  private rerun = false;
  /** suspend から resume までの間。この間は新しい step を送らない */
  private suspended = false;
  /** suspend の間、ループが次の step を送る前に待っている。resume と stop が起こす */
  private readonly wakers = new Set<() => void>();
  /** ループが無い間の suspend に来た start の queued の和。resume で送る */
  private deferred = 0;

  constructor(private readonly deps: LinkRewriteRunnerDeps) {}

  getState = (): LinkRewriteState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * 登録ごとに別の枠を作る。同じエディタを外す前に登録し直しても（StrictMode の effect の再実行で、
   * 離脱の保存を待ってから外すとき）、古い登録を外したときに新しい登録まで消さない。
   */
  register(participant: LinkRewriteParticipant): () => void {
    const entry = { participant };
    this.participants.add(entry);
    return () => {
      this.participants.delete(entry);
    };
  }

  /**
   * 積んだ書き換えを進める。queued は保存の応答が知らせた数で、最初の応答を待たずに進み具合を出す。
   * 何も積まれていなければ 1 回呼ぶだけで、何も見せずに終わる（起動時の再開）。
   */
  start(queued = 0): void {
    if (this.active) {
      // 新しく積まれていなければ、走っているループが同じ残りを処理する（StrictMode で起動時の再開が
      // 2 回来ても、step を余分に呼ばない）
      if (queued === 0) return;
      this.rerun = true;
      if (this.state.status !== "running") {
        this.set({ ...this.state, status: "running", total: this.state.done + queued });
      }
      return;
    }
    if (this.suspended) {
      // ログアウトの間に届いた保存の応答でも step は送らない。ログアウトに失敗して owner のままなら、
      // resume で送る
      this.deferred += queued;
      return;
    }
    this.run({ ...IDLE, status: queued > 0 ? "running" : "idle", total: queued });
  }

  /** 止まった書き換えを手で再開する。それまでに書き換えたページと失敗したページの一覧は残す。 */
  retry(): void {
    if (this.active || this.suspended) return;
    this.run({ ...this.state, status: "running", stopReason: null });
  }

  private run(initial: LinkRewriteState): void {
    const generation = ++this.generation;
    this.active = true;
    this.rerun = false;
    this.set(initial);
    this.loop(generation).catch(() => {
      if (generation === this.generation) {
        this.finish({ ...this.state, status: "stopped", stopReason: "error" });
      }
    });
  }

  /**
   * ループを終える。active は結果を知らせる前に下ろす。listener（画面の更新）が同じ同期区間で
   * start を呼んだとき、終わったループの rerun に入って取りこぼされないようにする。
   */
  private finish(state: LinkRewriteState): void {
    this.active = false;
    this.set(state);
  }

  /**
   * ログアウトの結果が分かるまで、新しい step を送らずに待つ。通信中の step は捨てずに応答を取り込む
   * （サーバーでは処理済みで、failed や公開ページの件数が二度と戻らなくなる）。結果は消さず、
   * ループは次の step の前で待つ。ログアウトに失敗して owner のままなら、止まった理由の通知の根拠
   * （failed と stopReason）が要る。
   */
  suspend(): void {
    this.suspended = true;
  }

  /** owner のまま書き込める状態に戻ったとき、待っていたループを起こし、待たせていた start を送る。 */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.wake();
    const deferred = this.deferred;
    this.deferred = 0;
    if (deferred > 0) this.start(deferred);
  }

  /**
   * ログアウトが済んだことが分かったとき、書き換えを止めて結果も消す。step を送らない状態は
   * suspend が作るので、ログアウトの前に suspend を呼んでおく（stop だけでは start を止めない）。
   */
  stop(): void {
    this.generation++;
    this.active = false;
    this.rerun = false;
    this.deferred = 0;
    this.set(IDLE);
    this.wake();
  }

  private wake(): void {
    const wakers = [...this.wakers];
    this.wakers.clear();
    for (const wake of wakers) wake();
  }

  private async untilResumed(generation: number): Promise<void> {
    while (this.suspended && generation === this.generation) {
      await new Promise<void>((resolve) => this.wakers.add(resolve));
    }
  }

  /** 終わった結果を閉じる。 */
  dismiss(): void {
    if (this.state.status === "done" || this.state.status === "stopped") this.set(IDLE);
  }

  private set(state: LinkRewriteState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /**
   * 取り込みの完了は待たない。エディタは取り込みを保存の後ろに並べるので、待つとループの進みが
   * 保存（離脱の保存を含む）の進み具合に縛られる。
   */
  private async runStep(): Promise<StepResult> {
    const result = await this.deps.step();
    const processed = result.ok ? result.value.processed : null;
    if (processed !== null) {
      for (const { participant } of this.participants) {
        participant.linkRewritten(processed).catch(() => undefined);
      }
    }
    return result;
  }

  private async loop(generation: number): Promise<void> {
    let conflicts = 0;
    let errors = 0;
    const current = () => generation === this.generation;
    const stopWith = (stopReason: "auth" | "error") =>
      this.finish({ ...this.state, status: "stopped", stopReason });
    for (;;) {
      // 待たないときは await を挟まない（start の同じ同期区間で最初の step を送る）
      if (this.suspended) {
        await this.untilResumed(generation);
        if (!current()) return;
      }
      const result = await this.runStep();
      if (!current()) return;
      if (!result.ok) {
        // step の無い Worker（前の版に戻したときなど）では、書き換えの機能が無いものとして黙って止める
        if (result.kind === "not_found") return this.finish(IDLE);
        if (result.kind === "unauthorized" || result.kind === "forbidden") return stopWith("auth");
        const wait = ERROR_WAITS_MS[errors++];
        if (wait === undefined) return stopWith("error");
        await this.deps.sleep(wait);
        if (!current()) return;
        continue;
      }
      errors = 0;
      const { processed, conflict, failed, remaining } = result.value;
      if (conflict) {
        if (++conflicts > MAX_CONFLICTS) return stopWith("error");
        await this.deps.sleep(CONFLICT_WAIT_MS);
        if (!current()) return;
        continue;
      }
      conflicts = 0;
      // 何も積まれていないときの応答（processed も failed も無く残りも 0）は処理に数えない
      const handled = processed !== null || failed.length > 0 || this.state.total > this.state.done;
      const done = this.state.done + (handled ? 1 : 0);
      const rewritten =
        processed === null
          ? this.state.rewritten
          : [
              ...this.state.rewritten.filter((page) => page.id !== processed.sourcePageId),
              {
                id: processed.sourcePageId,
                title: processed.title,
                visibility: processed.visibility,
              },
            ];
      const next = {
        ...this.state,
        done,
        total: done + remaining,
        rewritten,
        // 同じリンク元が積み直されてまた失敗しても、一覧には 1 回だけ出す
        failed: [...new Set([...this.state.failed, ...failed])],
      };
      if (remaining > 0) {
        this.set({ ...next, status: "running" });
        continue;
      }
      if (this.rerun) {
        this.rerun = false;
        this.set(next);
        continue;
      }
      const shown = next.rewritten.length > 0 || next.failed.length > 0;
      return this.finish(shown ? { ...next, status: "done" } : IDLE);
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** アプリ全体で 1 つ。ページを移っても書き換えを続ける。 */
export const linkRewrites = new LinkRewriteRunner({ step: () => stepLinkRewrites(), sleep });
