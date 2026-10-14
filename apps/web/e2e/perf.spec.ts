import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import {
  bodyEditor,
  expect,
  saveState,
  test,
  typeAtBodyEnd,
  uniqueTitle,
} from "./support/fixtures";
import { longPageBody } from "./support/seed";

/*
 * 1 万字ほどの長いページで、開いてから書けるまで、打鍵から表示まで、保存の要求から「保存済み」の
 * 表示までを測り、e2e-output/perf-<project>.json に書く。中央値が perf-budget.json の上限を超えたら落とす。
 * 上限は、手元で 2 回測った中央値の大きい方（measured）の 2 倍を 10ms 単位で切り上げた値。打鍵から
 * 表示まではフレーム（約 16ms）の刻みで揺れるので、50ms を下限にする。端末が変わって外れるなら測り直す。
 *
 * 時刻はすべてページの中の performance.now() で取る（Playwright の側の時計と混ぜない）。
 */

const SAMPLES = 5;
const KEYSTROKES = 20;

type Metric = "openToEditableMs" | "keystrokeToDisplayMs" | "saveToIndicatorMs";
type Budget = Partial<Record<Metric, { measured: number; budget: number }>>;

const budgets: Record<string, Budget> = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "perf-budget.json"), "utf8"),
);

interface PerfProbe {
  editableAt: number | null;
  keyDown: number | null;
  keyLatencies: number[];
  putStarts: number[];
  savedAt: number[];
}

declare global {
  interface Window {
    __perf: PerfProbe;
  }
}

/**
 * 計測用の観測をページの読み込み前に仕込む。
 * - 書ける: 本文の editor に文字が入り、保存の状態の表示（owner の編集画面にだけある）が出た時点。
 * - 打鍵から表示: keydown から、本文の DOM が変わった後の最初のフレームの開始まで。
 * - 保存: アプリが PUT を送り始めた時点（fetch を包んで取る）から、表示が「保存済み」に変わった時点まで。
 *   自動保存の待ち（入力が止まってから 2 秒）は含めない。
 */
function installProbe(): void {
  const probe: PerfProbe = {
    editableAt: null,
    keyDown: null,
    keyLatencies: [],
    putStarts: [],
    savedAt: [],
  };
  window.__perf = probe;
  const originalFetch = window.fetch;
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    if ((args[1]?.method ?? "GET").toUpperCase() === "PUT") probe.putStarts.push(performance.now());
    return originalFetch.apply(this, args);
  } as typeof fetch;
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.target instanceof Element && event.target.closest('[aria-label="本文"]')) {
        probe.keyDown = event.timeStamp;
      }
    },
    true,
  );
  let lastState = "";
  new MutationObserver((records) => {
    const body = document.querySelector('.cm-content[aria-label="本文"]');
    const state = document.querySelector(".save-state")?.textContent ?? "";
    if (probe.editableAt === null && body?.querySelector(".cm-line")?.textContent && state !== "") {
      probe.editableAt = performance.now();
    }
    if (state === "保存済み" && lastState !== "保存済み" && lastState !== "") {
      probe.savedAt.push(performance.now());
    }
    lastState = state;
    const downAt = probe.keyDown;
    if (downAt !== null && body !== null && records.some((r) => body.contains(r.target))) {
      probe.keyDown = null;
      requestAnimationFrame((frameAt) => probe.keyLatencies.push(frameAt - downAt));
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};
const round = (value: number) => Math.round(value * 10) / 10;
const summarize = (values: number[]) => ({
  median: round(median(values)),
  max: round(Math.max(...values)),
  samples: values.map(round),
});

const probe = (page: Page) => page.evaluate(() => window.__perf);

test("長いページの速さ @perf", async ({ page, api }, testInfo) => {
  const created = await api.createPage({
    title: uniqueTitle(testInfo, "速さの計測"),
    body: longPageBody(),
  });
  await page.addInitScript(installProbe);

  const openSamples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    await page.goto(`/p/${created.id}`);
    await expect(saveState(page)).toHaveText("保存済み");
    const at = (await probe(page)).editableAt;
    expect(at, "書ける状態を観測できなかった").not.toBeNull();
    openSamples.push(at ?? 0);
  }

  // 1 打ずつ、表示を観測し終えてから次を打つ（打鍵どうしの計測を重ねない）
  await typeAtBodyEnd(page, " ");
  await expect(saveState(page)).toHaveText("保存済み");
  await page.evaluate(() => {
    window.__perf.keyLatencies = [];
  });
  for (let i = 1; i <= KEYSTROKES; i++) {
    await page.keyboard.press("a");
    await page.waitForFunction((n) => window.__perf.keyLatencies.length >= n, i);
  }
  const keySamples = (await probe(page)).keyLatencies.slice(0, KEYSTROKES);

  const saveSamples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    await expect(saveState(page)).toHaveText("保存済み");
    const before = await probe(page);
    await page.keyboard.press("b");
    await expect(saveState(page)).not.toHaveText("保存済み");
    await expect(saveState(page)).toHaveText("保存済み");
    const after = await probe(page);
    const putAt = after.putStarts[before.putStarts.length];
    const savedAt = after.savedAt[before.savedAt.length];
    expect(putAt, "保存の要求を観測できなかった").toBeDefined();
    expect(savedAt, "「保存済み」への変化を観測できなかった").toBeDefined();
    saveSamples.push((savedAt ?? 0) - (putAt ?? 0));
  }
  await expect(bodyEditor(page)).toContainText(`${"a".repeat(KEYSTROKES)}${"b".repeat(SAMPLES)}`);

  const results: Record<Metric, ReturnType<typeof summarize>> = {
    openToEditableMs: summarize(openSamples),
    keystrokeToDisplayMs: summarize(keySamples),
    saveToIndicatorMs: summarize(saveSamples),
  };
  const outDir = resolve(import.meta.dirname, "../e2e-output");
  await mkdir(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, `perf-${testInfo.project.name}.json`),
    `${JSON.stringify({ project: testInfo.project.name, bodyLength: created.body.length, results }, null, 2)}\n`,
  );
  await testInfo.attach("perf", {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });

  const budget = budgets[testInfo.project.name] ?? {};
  for (const metric of Object.keys(results) as Metric[]) {
    const limit = budget[metric]?.budget;
    expect(limit, `perf-budget.json に ${testInfo.project.name} の ${metric} が無い`).toBeDefined();
    expect.soft(results[metric].median, metric).toBeLessThanOrEqual(limit ?? 0);
  }
});
