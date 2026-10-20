import type { Locator, Page } from "@playwright/test";
import type { OwnerApi } from "./support/api";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";

/*
 * 通知の操作（.actions の中のボタン）の広がり方。
 * 通知の幅は本文の列にそろうので、衝突の通知の 2 つの操作は 641px 以上でも 1 行に収まらない幅がある。
 * 折り返す幅では、640px 以下と同じく行いっぱいに広げ、2 つ目が自然な幅のまま左に寄らないようにする。
 * 1 行に並ぶ幅では、操作は自然な幅のままにする。測るのは座標なので、デスクトップの Chromium だけで走らせる（@widths）。
 */

const BODY = Array.from({ length: 30 }, (_, index) => `${index + 1} 行目の本文`).join("\n");

/** 保存の間に別の場所で本文を書き換えて、衝突の通知を出す。 */
async function provokeConflict(page: Page, api: OwnerApi, title: string): Promise<Locator> {
  const created = await api.createPage({ title, body: BODY });
  await page.goto(`/p/${created.id}`);
  await expect(bodyEditor(page)).toContainText("1 行目の本文");
  await expect(saveState(page)).toHaveText("保存済み");
  let external: Promise<unknown> | undefined;
  await page.route(`**/api/pages/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    external ??= api.updatePage(created, { body: `${BODY}\n別の場所で足した行` });
    const updated = await external.then(
      () => true,
      () => false,
    );
    return updated ? route.fallback() : route.abort();
  });
  await bodyEditor(page).locator(".cm-line").nth(0).click();
  await page.keyboard.press("End");
  await page.keyboard.type("、手元の変更");
  const conflict = page.getByRole("alert").filter({
    has: page.getByRole("heading", { name: "別の場所でも更新されています" }),
  });
  await expect(conflict).toBeVisible();
  return conflict;
}

interface ActionsBox {
  /** 操作の欄の左右の端。 */
  left: number;
  right: number;
  buttons: { left: number; right: number; top: number }[];
}

async function measureActions(conflict: Locator): Promise<ActionsBox> {
  return conflict.evaluate((element) => {
    const actions = element.querySelector(".actions");
    if (actions === null) throw new Error("操作の欄が無い");
    const box = actions.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      buttons: [...actions.querySelectorAll(".button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top };
      }),
    };
  });
}

// 2 つの操作が 1 行に収まる最小の幅が 744px。境目の両側（743px と 744px）も測る
const STACKED = [641, 700, 743] as const;
const SINGLE_ROW = [744, 768, 1280] as const;

test("衝突の通知の操作は、折り返す幅では行いっぱいに広がり、1 行に並ぶ幅では自然な幅のまま @widths", async ({
  page,
  api,
}, testInfo) => {
  const conflict = await provokeConflict(page, api, uniqueTitle(testInfo, "操作の幅"));

  for (const width of STACKED) {
    await page.setViewportSize({ width, height: 700 });
    const { left, right, buttons } = await measureActions(conflict);
    expect(buttons, `${width}px の操作の数`).toHaveLength(2);
    expect(buttons[1]?.top, `${width}px で 2 つ目が次の行に回っている`).toBeGreaterThan(
      buttons[0]?.top ?? Number.POSITIVE_INFINITY,
    );
    for (const [index, button] of buttons.entries()) {
      expect(button.left, `${width}px の ${index + 1} つ目の左端`).toBeCloseTo(left, 0);
      expect(button.right, `${width}px の ${index + 1} つ目の右端`).toBeCloseTo(right, 0);
    }
  }

  for (const width of SINGLE_ROW) {
    await page.setViewportSize({ width, height: 700 });
    const { right, buttons } = await measureActions(conflict);
    expect(buttons[1]?.top, `${width}px で 2 つが 1 行に並ぶ`).toBe(buttons[0]?.top);
    // 境目の 744px は余りが 1px 未満で、広げているかどうかを座標で分けられない
    if (width === 744) continue;
    // 行いっぱいに広げると、2 つ目の右端が欄の右端に届く
    expect(right - (buttons[1]?.right ?? 0), `${width}px の 2 つ目の右の空き`).toBeGreaterThan(8);
  }
});
