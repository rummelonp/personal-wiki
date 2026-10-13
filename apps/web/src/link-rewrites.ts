import type { LinkRewriteStepLike } from "./editor-session";
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
  /** 書き換えると意図しない変化が出るので、書き換えなかったリンク元の id */
  failed: string[];
  /** auth はログインが切れたか書き込めない、error は通信や衝突が続いて諦めた */
  stopReason: "auth" | "error" | null;
}

/**
 * 開いているエディタ。step を保存と同じ列に並べ、開いているページが書き換えられたら取り込む
 * （EditorSession.runLinkRewriteStep）。
 */
export interface LinkRewriteParticipant {
  runLinkRewriteStep<T extends LinkRewriteStepLike>(step: () => Promise<T>): Promise<T>;
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
  private readonly participants = new Set<LinkRewriteParticipant>();
  /** ループを捨てるたびに進める。古いループは結果を書かずに抜ける */
  private generation = 0;
  /** ループが走っている。status は何も見せない間（起動時の再開）も idle なので、別に持つ */
  private active = false;
  /** 走っている間に start が来た。残りが 0 になっても、もう一度呼んで確かめる */
  private rerun = false;

  constructor(private readonly deps: LinkRewriteRunnerDeps) {}

  getState = (): LinkRewriteState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  register(participant: LinkRewriteParticipant): () => void {
    this.participants.add(participant);
    return () => this.participants.delete(participant);
  }

  /**
   * 積んだ書き換えを進める。queued は保存の応答が知らせた数で、最初の応答を待たずに進み具合を出す。
   * 何も積まれていなければ 1 回呼ぶだけで、何も見せずに終わる（起動時の再開）。
   */
  start(queued = 0): void {
    if (this.active) {
      this.rerun = true;
      if (queued > 0 && this.state.status !== "running") {
        this.set({ ...this.state, status: "running", total: this.state.done + queued });
      }
      return;
    }
    const generation = ++this.generation;
    this.active = true;
    this.rerun = false;
    this.set({ ...IDLE, status: queued > 0 ? "running" : "idle", total: queued });
    void this.loop(generation).finally(() => {
      if (generation === this.generation) this.active = false;
    });
  }

  /** ログアウトなどで書き換えを止め、結果も消す。 */
  stop(): void {
    this.generation++;
    this.active = false;
    this.rerun = false;
    this.set(IDLE);
  }

  /** 終わった結果を閉じる。 */
  dismiss(): void {
    if (this.state.status === "done" || this.state.status === "stopped") this.set(IDLE);
  }

  private set(state: LinkRewriteState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private runStep(): Promise<StepResult> {
    let run = async () => {
      const result = await this.deps.step();
      return { result, processed: result.ok ? result.value.processed : null };
    };
    for (const participant of this.participants) {
      const inner = run;
      run = () => participant.runLinkRewriteStep(inner);
    }
    return run().then(({ result }) => result);
  }

  private async loop(generation: number): Promise<void> {
    let conflicts = 0;
    let errors = 0;
    const current = () => generation === this.generation;
    const stopWith = (stopReason: "auth" | "error") =>
      this.set({ ...this.state, status: "stopped", stopReason });
    for (;;) {
      const result = await this.runStep();
      if (!current()) return;
      if (!result.ok) {
        // step の無い Worker（前の版に戻したときなど）では、書き換えの機能が無いものとして黙って止める
        if (result.kind === "not_found") return this.set(IDLE);
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
        failed: [...this.state.failed, ...failed],
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
      return this.set(shown ? { ...next, status: "done" } : IDLE);
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** アプリ全体で 1 つ。ページを移っても書き換えを続ける。 */
export const linkRewrites = new LinkRewriteRunner({ step: () => stepLinkRewrites(), sleep });
