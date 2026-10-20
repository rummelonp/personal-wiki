import type { Page } from "@playwright/test";
import {
  bodyEditor,
  expect,
  expectNoHorizontalScroll,
  test,
  uniqueTitle,
} from "./support/fixtures";

/*
 * 通知のドック（.notice-dock）は overflow-y: auto で内側を切るので、通知の影がドックの縁より遠くまで
 * 届くと、縁で縦の線に切れる。明るい配色では影が見え、暗い配色では見えない。
 * 切れるかどうかは描画の画素でなく、通知の縁からドックの縁までの距離と、影のぼかし半径で測る。
 * 右の縁は、右の欄が本文の右に並ぶ幅（40rem を超える幅）で、欄の線を越えないことも測る。
 */

const WIDTHS = [641, 768, 900, 1022, 1280] as const;

interface Geometry {
  blur: number;
  noticeLeft: number;
  noticeRight: number;
  dockLeft: number;
  dockRight: number;
  railLeft: number;
}

async function geometry(page: Page): Promise<Geometry> {
  // 幅を変えた直後でも、変えた後の配置で測る
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const dock = document.querySelector(".notice-dock") as HTMLElement;
    const notice = dock.querySelector(":scope > .notice") as HTMLElement;
    const dockRect = dock.getBoundingClientRect();
    const noticeRect = notice.getBoundingClientRect();
    // 計算値は "rgba(0, 0, 0, 0.16) 0px 8px 24px 0px" の形で、色の後ろが x、y、ぼかし、広がり
    const lengths = getComputedStyle(notice).boxShadow.match(/-?[\d.]+px/g) ?? [];
    const [x = 0, , blur = 0, spread = 0] = lengths.map((length) => Number.parseFloat(length));
    const rail = (document.querySelector(".rail") as HTMLElement).getBoundingClientRect();
    return {
      // 影が横へ届く距離。ぼかしの半径と広がりに x のずれを足し、最も届く側で測る
      blur: blur + spread + Math.abs(x),
      noticeLeft: noticeRect.left,
      noticeRight: noticeRect.right,
      dockLeft: dockRect.left + dock.clientLeft,
      // スクロールバーが出ていれば、それより内側が切れる縁になる。client 系は整数に丸まるので、幅は差だけを使う
      dockRight: dockRect.right - dock.clientLeft - (dock.offsetWidth - dock.clientWidth),
      railLeft: rail.left,
    };
  });
}

for (const width of WIDTHS) {
  test(`通知の影は、ドックの縁で切れず、右の縁は欄の線を越えない（明るい配色、${width}px） @widths`, async ({
    page,
    api,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width, height: 800 });
    const created = await api.createPage({
      title: uniqueTitle(testInfo, "影の縁"),
      body: "短い本文",
    });
    await page.goto(`/p/${created.id}`);
    await expect(bodyEditor(page)).toHaveText("短い本文");
    await page.route(`**/api/pages/${created.id}`, (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "internal" }),
          })
        : route.fallback(),
    );
    await bodyEditor(page).locator(".cm-line").last().click();
    await page.keyboard.press("End");
    await page.keyboard.type("、打った");
    await expect(page.locator(".notice-dock").getByRole("alert")).toBeVisible();

    const g = await geometry(page);
    expect(g.blur, "影を読み取れていない").toBeGreaterThan(0);
    expect(g.noticeLeft - g.dockLeft, "左の縁で影が切れる").toBeGreaterThanOrEqual(g.blur);
    expect(g.dockRight - g.noticeRight, "右の縁で影が切れる").toBeGreaterThanOrEqual(g.blur);
    expect(g.dockRight, "ドックの右端が欄の線を越えている").toBeLessThanOrEqual(g.railLeft);
    await expectNoHorizontalScroll(page);
  });
}
