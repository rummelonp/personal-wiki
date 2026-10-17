import type { Bindings } from "./env";
import { logWriteMetric, stepLinkRewritesRecorded, type WriteMetric } from "./pages/operations";

export interface ScheduledOptions {
  /** UNIX エポックのミリ秒を返す時計。テストだけが差し替える。 */
  now?: () => number;
  recordWrite?: (metric: WriteMetric) => void;
}

/**
 * Cron でキューに入れたリンクの書き換えを進める（deploy.env の LINK_REWRITE_CRON）。MCP 経由の rename は
 * web を開かないので、書き換えがキューに入ったまま残るのを防ぐ。
 *
 * 1 回の発火で進めるのは 1 リンク元だけ。Workers Free の scheduled は CPU が 10ms で、1 リンク元の
 * 書き換えがその大半を使うため、2 回目は呼ばない。残りは次の発火が進める。
 * revision の actor は、キューに入れた rename の呼び出し元（link_rewrites.actor）になる。REST の step と同じ。
 * 例外は発火を失敗として記録させるため、ログに出したあとで投げ直す。
 */
export function createScheduledHandler({
  now = Date.now,
  recordWrite = logWriteMetric,
}: ScheduledOptions = {}) {
  return async (_controller: ScheduledController, env: Bindings): Promise<void> => {
    // 例外のとき、その発火で選んだリンク元をログに残す。選ぶ前の失敗では null のまま。
    // 本文の書き換えが確定した後の失敗でも入るので、この id のページが書き換わっていないとは限らない
    let sourcePageId: string | null = null;
    try {
      const result = await stepLinkRewritesRecorded(
        { db: env.DB, now, recordWrite },
        {
          targetPageId: null,
          onPicked: (id) => {
            sourcePageId = id;
          },
        },
        () => "cron",
      );
      // 本文と title は出さない。リンク元は id だけ
      console.log(
        JSON.stringify({
          event: "link_rewrites.scheduled",
          processed: result.processed?.sourcePageId ?? null,
          rewritten: result.processed?.rewritten ?? 0,
          conflict: result.conflict,
          failed: result.failed,
          remaining: result.remaining,
          rowsWritten: result.rowsWritten,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "link_rewrites.scheduled_error",
          sourcePageId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  };
}
