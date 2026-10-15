import { describe, expect, it } from "vitest";
import { readBounded } from "./read-bounded";

/** chunk を順に流し、cancel されたかと、読まれた chunk の数を記録する stream */
function streamOf(chunks: number[][]) {
  const state = { cancelled: false, pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[state.pulled];
      if (next === undefined) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(new Uint8Array(next));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

describe("readBounded", () => {
  it("複数の chunk の合計がちょうど上限なら、つないだバイト列を返す", async () => {
    const { stream, state } = streamOf([[1, 2], [3], [4, 5]]);
    expect(await readBounded(stream, 5)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(state.cancelled).toBe(false);
  });

  it("合計が上限より 1 バイト多ければ null を返し、stream を cancel する", async () => {
    const { stream, state } = streamOf([[1, 2], [3], [4, 5, 6]]);
    expect(await readBounded(stream, 5)).toBeNull();
    expect(state.cancelled).toBe(true);
  });

  it("chunk の途中で上限を超えたら、残りの chunk を読まずに null を返す", async () => {
    const { stream, state } = streamOf([[1, 2], [3, 4, 5, 6, 7], [8], [9]]);
    expect(await readBounded(stream, 5)).toBeNull();
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(4);
  });

  it("本文が無ければ空のバイト列を返す", async () => {
    expect(await readBounded(null, 5)).toEqual(new Uint8Array(0));
  });
});
