import type { ProcessedLinkRewrite } from "./editor-session";
import {
  type FailedLinkRewrite,
  type LinkRewriteStepResult,
  type StepFailureKind,
  type StepResult,
  stepLinkRewrites,
} from "./link-rewrites-api";
import { getPage, type Visibility } from "./pages-api";

/*
 * title の変更で Worker がキューに入れたリンクの書き換えを、step を繰り返して最後まで進める。
 * step は 1 回でリンク元 1 ページを処理する。同時に呼ぶと同じリンク元を取り合って失敗が増えるので、
 * タブの中では 1 本のループだけが呼ぶ。
 */

export interface RewrittenPage {
  id: string;
  title: string;
  visibility: Visibility;
}

/** 書き換えられなかったリンク元。title は、Worker も引き直しも title を得られなかったとき null */
export interface FailedPage {
  id: string;
  title: string | null;
}

export interface LinkRewriteState {
  /** idle は何も見せない。done と stopped は閉じるまで結果を見せる */
  status: "idle" | "running" | "done" | "stopped";
  /** このループで処理を終えたリンク元の数 */
  done: number;
  /** done と、Worker が最後に知らせた残りの数の和 */
  total: number;
  rewritten: RewrittenPage[];
  /** 書き換えられなかったリンク元（意図しない変化が出る、本文の上限を超える、試行の上限に達した） */
  failed: FailedPage[];
  /** auth はログインが切れたか書き込めない、error は通信や衝突が続いて諦めた */
  stopReason: "auth" | "error" | null;
}

/** 開いているエディタ。step が書き換えたページが自分なら、その版を取り込む（EditorSession.linkRewritten）。 */
export interface LinkRewriteParticipant {
  linkRewritten(processed: ProcessedLinkRewrite): Promise<void>;
}

export interface LinkRewriteRunnerDeps {
  step: () => Promise<StepResult>;
  /** ページの現在の title。引けなければ null */
  pageTitle: (id: string) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
}

/** conflict は他の保存と重なっただけなので待って呼び直す。続くなら他で書き続けているので諦める */
export const CONFLICT_WAIT_MS = 1_000;
export const MAX_CONFLICTS = 20;
/** 通信の失敗は間を広げて呼び直す。この回数を超えたら止め、手動の再試行に任せる */
export const ERROR_WAITS_MS = [1_000, 2_000, 4_000];

/**
 * 同じリンク元がキューに入れ直されてまた失敗しても、一覧には 1 回だけ出す。試行の上限で諦めたときは title が
 * 無いので、前に分かった title を残す。
 */
function mergeFailed(current: FailedPage[], added: FailedPage[]): FailedPage[] {
  const byId = new Map(current.map((page) => [page.id, page]));
  for (const page of added) {
    const known = byId.get(page.id)?.title;
    byId.set(page.id, { id: page.id, title: page.title ?? known ?? page.title });
  }
  return [...byId.values()];
}

const IDLE: LinkRewriteState = {
  status: "idle",
  done: 0,
  total: 0,
  rewritten: [],
  failed: [],
  stopReason: null,
};

/** 続けて起きた conflict と通信の失敗の数 */
export interface RetryCounts {
  conflicts: number;
  errors: number;
}

/**
 * step の結果を受けてループが次にすること。proceed は結果を一覧に取り込む、wait は待って step を送り直す、
 * finish はその状態でループを終える。
 */
export type StepOutcome =
  | { kind: "proceed"; value: LinkRewriteStepResult }
  | { kind: "wait"; ms: number; counts: RetryCounts }
  | { kind: "finish"; state: LinkRewriteState };

const stopped = (state: LinkRewriteState, stopReason: "auth" | "error"): StepOutcome => ({
  kind: "finish",
  state: { ...state, status: "stopped", stopReason },
});

function failureOutcome(
  kind: StepFailureKind,
  counts: RetryCounts,
  state: LinkRewriteState,
): StepOutcome {
  // step の無い Worker（前の版に戻したときなど）では、書き換えの機能が無いものとして黙って止める
  if (kind === "not_found") return { kind: "finish", state: IDLE };
  if (kind === "unauthorized" || kind === "forbidden") return stopped(state, "auth");
  const ms = ERROR_WAITS_MS[counts.errors];
  if (ms === undefined) return stopped(state, "error");
  return { kind: "wait", ms, counts: { ...counts, errors: counts.errors + 1 } };
}

/**
 * 1 回の step の応答を、取り込む、待って送り直す、終えるのどれかに分ける。待つときは数を進めた counts を返す。
 * conflict の応答は通信の失敗の数を 0 に戻し、通信の失敗は conflict の数を戻さない。取り込むときの数え直しは
 * 呼び出し側が行う。state は止めるときに結果として残す状態。
 */
export function outcomeOf(
  result: StepResult,
  counts: RetryCounts,
  state: LinkRewriteState,
): StepOutcome {
  if (!result.ok) return failureOutcome(result.kind, counts, state);
  if (!result.value.conflict) return { kind: "proceed", value: result.value };
  const conflicts = counts.conflicts + 1;
  if (conflicts > MAX_CONFLICTS) return stopped(state, "error");
  return { kind: "wait", ms: CONFLICT_WAIT_MS, counts: { conflicts, errors: 0 } };
}

/** step が処理したリンク元を進み具合と一覧に足す。 */
export function advance(
  state: LinkRewriteState,
  { processed, failed, remaining }: LinkRewriteStepResult,
  failedPages: FailedPage[],
): LinkRewriteState {
  // 何もキューに入っていないときのレスポンス（processed も failed も無く残りも 0）は処理に数えない
  const handled = processed !== null || failed.length > 0 || state.total > state.done;
  const done = state.done + (handled ? 1 : 0);
  const rewritten =
    processed === null
      ? state.rewritten
      : [
          ...state.rewritten.filter((page) => page.id !== processed.sourcePageId),
          { id: processed.sourcePageId, title: processed.title, visibility: processed.visibility },
        ];
  return {
    ...state,
    done,
    total: done + remaining,
    rewritten,
    failed: mergeFailed(state.failed, failedPages),
  };
}

/**
 * 取り込んだあとにループを続けるか。running は残りがあるので続ける、rerun は走っている間に来た start の分を
 * もう一度確かめる、finish は終える。見せる結果が無ければ何も見せずに終える。
 */
export function continuationOf(
  next: LinkRewriteState,
  remaining: number,
  rerun: boolean,
): { kind: "running" | "rerun" | "finish"; state: LinkRewriteState } {
  if (remaining > 0) return { kind: "running", state: { ...next, status: "running" } };
  if (rerun) return { kind: "rerun", state: next };
  const shown = next.rewritten.length > 0 || next.failed.length > 0;
  return { kind: "finish", state: shown ? { ...next, status: "done" } : IDLE };
}

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
   * キューに入れた書き換えを進める。queued は保存のレスポンスが知らせた数で、最初のレスポンスを待たずに進み具合を出す。
   * 何もキューに入っていなければ 1 回呼ぶだけで、何も見せずに終わる（起動時の再開）。
   */
  start(queued = 0): void {
    if (this.active) {
      // 新しくキューに入っていなければ、走っているループが同じ残りを処理する（StrictMode で起動時の再開が
      // 2 回来ても、step を余分に呼ばない）
      if (queued === 0) return;
      this.rerun = true;
      if (this.state.status !== "running") {
        this.set({ ...this.state, status: "running", total: this.state.done + queued });
      }
      return;
    }
    if (this.suspended) {
      // ログアウトの間に届いた保存のレスポンスでも step は送らない。ログアウトに失敗して owner のままなら、
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
   * ログアウトの結果が分かるまで、新しい step を送らずに待つ。通信中の step は捨てずにレスポンスを取り込む
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

  /**
   * title を返さない前の版の Worker の failed には title が無いので、リンク元のページを読んで補う。
   * 同じリンク元が失敗として返り直すたびには読まないよう、すでに title が分かっている id は読まない。
   */
  private async nameFailed(failed: FailedLinkRewrite[]): Promise<FailedPage[]> {
    return Promise.all(
      failed.map(async ({ id, title }) => {
        if (title !== undefined) return { id, title };
        const known = this.state.failed.find((page) => page.id === id)?.title;
        if (known !== undefined && known !== null) return { id, title: known };
        return { id, title: await this.deps.pageTitle(id) };
      }),
    );
  }

  private async loop(generation: number): Promise<void> {
    const current = () => generation === this.generation;
    for (;;) {
      const value = await this.stepUntilProgress(generation);
      if (value === null || !current()) return;
      const failedPages = await this.nameFailed(value.failed);
      if (!current()) return;
      const continuation = continuationOf(
        advance(this.state, value, failedPages),
        value.remaining,
        this.rerun,
      );
      if (continuation.kind === "finish") return this.finish(continuation.state);
      if (continuation.kind === "rerun") this.rerun = false;
      this.set(continuation.state);
    }
  }

  /**
   * 待って送り直す結果（conflict と通信の失敗）を繰り返し、取り込む結果を返す。null を返すのは、finish で
   * ループを終えた後か、世代が変わったときだけにする（finish を呼ばずに返すと active が立ったまま残る）。
   * 取り込む結果を返すときは数え直すので、数は呼ぶたびに 0 から始める。
   */
  private async stepUntilProgress(generation: number): Promise<LinkRewriteStepResult | null> {
    const current = () => generation === this.generation;
    let counts: RetryCounts = { conflicts: 0, errors: 0 };
    for (;;) {
      // 待たないときは await を挟まない（start の同じ同期区間で最初の step を送る）
      if (this.suspended) {
        await this.untilResumed(generation);
        if (!current()) return null;
      }
      const result = await this.runStep();
      if (!current()) return null;
      // 止めた状態は、この同期区間の state から作って finish する。await を挟むと、その間の start が
      // 終わるループの rerun に入って取りこぼされるか、start の変更が落ちる
      const outcome = outcomeOf(result, counts, this.state);
      if (outcome.kind === "proceed") return outcome.value;
      if (outcome.kind === "finish") {
        this.finish(outcome.state);
        return null;
      }
      counts = outcome.counts;
      await this.deps.sleep(outcome.ms);
      if (!current()) return null;
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** アプリ全体で 1 つ。ページを移っても書き換えを続ける。 */
export const linkRewrites = new LinkRewriteRunner({
  step: () => stepLinkRewrites(),
  pageTitle: async (id) => {
    const result = await getPage(id);
    return result.ok ? result.value.title : null;
  },
  sleep,
});
