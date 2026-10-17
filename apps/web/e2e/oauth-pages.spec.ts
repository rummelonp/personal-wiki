import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { connectOAuthClient } from "./support/principals";

/*
 * OAuth の画面（同意、エラー、接続の一覧）の折り返しと、タッチ端末での押せる範囲。
 * 画面は Worker が組む HTML で、SPA の styles.css は読まない。
 * 行の折れ目は座標で測る。`word-break: auto-phrase` は WebKit に無いので、測るのは Chromium だけにする（@widths）。
 */

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

// 文節の途中で切れないことを見る語。画面の警告文（.warn）に含まれる
const WORDS = ["許可", "ください", "リンク", "接続", "自分", "限りません", "始めた"];

async function openConsent(page: Page): Promise<void> {
  const origin = process.env.E2E_ORIGIN ?? "";
  const res = await fetch(`${origin}/_auth/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [CALLBACK],
      client_name: "Claude",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  const { client_id: clientId } = (await res.json()) as { client_id: string };
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "e2e",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    scope: "read",
    resource: `${origin}/mcp`,
  });
  await page.goto(`/_auth/oauth/authorize?${params}`);
  await expect(page.locator("h1")).toContainText("接続を許可しますか");
}

/** 1 つの text node の文字ごとに座標を測り、行ごとの文字列に分ける。 */
async function lines(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluate((el) => {
    const result: string[] = [];
    let current = "";
    let top: number | undefined;
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const value = node.nodeValue ?? "";
      for (let i = 0; i < value.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const charTop = range.getBoundingClientRect().top;
        if (top !== undefined && charTop > top + 1) {
          result.push(current);
          current = "";
        }
        top = charTop;
        current += value[i];
      }
    }
    result.push(current);
    return result;
  });
}

test.describe("OAuth の画面の折り返し @widths", () => {
  test("同意画面の文は、どの幅でも語の途中で折り返さない", async ({ page }) => {
    await openConsent(page);
    for (let width = 300; width <= 480; width += 4) {
      await page.setViewportSize({ width, height: 900 });
      const rows = await lines(page, ".warn");
      const text = rows.join("");
      const breaks: number[] = [];
      let offset = 0;
      for (const row of rows.slice(0, -1)) {
        offset += row.length;
        breaks.push(offset);
      }
      for (const word of WORDS) {
        for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
          const inside = breaks.filter((b) => b > at && b < at + word.length);
          expect(inside, `${width}px で「${word}」が折れる: ${rows.join(" | ")}`).toEqual([]);
        }
      }
    }
  });

  test("送り先の URL は、幅が足りないとき `/` の後で折り返す", async ({ page }) => {
    await openConsent(page);
    for (const width of [320, 360, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const rows = await lines(page, ".uri");
      expect(rows.length, `${width}px で折り返す`).toBeGreaterThan(1);
      for (const row of rows.slice(0, -1)) {
        expect(row.endsWith("/"), `${width}px の行末: ${rows.join(" | ")}`).toBe(true);
      }
    }
  });
});

test.describe("接続の取り消し", () => {
  test("取り消した後の一覧に、取り消した接続の名前と許可の日時を出す", async ({
    page,
  }, testInfo) => {
    // ほかの環境の同じテストも同じ KV に接続を足すので、名前を環境ごとに分け、件数ではなく grant の id で確かめる
    const name = `Claude ${testInfo.project.name}`;
    await connectOAuthClient(name);
    await connectOAuthClient(name);
    await page.goto("/_auth/oauth/grants");
    const target = page
      .locator(".grants li")
      .filter({ has: page.locator("strong", { hasText: name }) })
      .nth(1);
    const grant = await target.locator('input[name="grant"]').getAttribute("value");
    const granted = /許可: (\S+ \S+ UTC)/.exec(
      (await target.locator(".meta").textContent()) ?? "",
    )?.[1];
    expect(granted).toBeDefined();
    await target.getByRole("button", { name: /^取り消す/ }).click();

    await expect(page.locator(".done")).toHaveText(
      `${name}（${granted} に許可）の接続を取り消しました。`,
    );
    await expect(page.locator(`input[name="grant"][value="${grant}"]`)).toHaveCount(0);
  });
});

test.describe("OAuth の画面のタップ対象", () => {
  test.skip(({ isMobile }) => !isMobile, "pointer: coarse の端末だけ");
  test.use({ viewport: { width: 375, height: 812 } });

  /** リンクの箱が 44px 以上で、字の位置は箱の中央に在り、箱の外の文章と重ならない。 */
  async function expectBackTarget(page: Page): Promise<void> {
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const link = page.getByRole("link", { name: "wiki に戻る" });
    await expect(link).toBeVisible();
    // 接続の一覧は、ほかのテストが足した接続の数で伸びる。elementFromPoint は画面の外を引けない
    await link.scrollIntoViewIfNeeded();
    const box = await link.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(el);
      const glyphs = text.getBoundingClientRect();
      const previous = el.closest("p")?.previousElementSibling?.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        centerGap: Math.abs(rect.top + rect.height / 2 - (glyphs.top + glyphs.height / 2)),
        gapAbove: previous === undefined ? undefined : rect.top - previous.bottom,
      };
    });
    expect(box.width).toBeGreaterThanOrEqual(44 - 0.1);
    expect(box.height).toBeGreaterThanOrEqual(44 - 0.1);
    expect(box.centerGap).toBeLessThan(1);
    // 上の要素に箱が食い込まない。上は押せる対象のこともある（接続の取り消し）
    expect(box.gapAbove ?? 0).toBeGreaterThanOrEqual(0);
    // 箱の上端の押下が、このリンクに届く
    const top = await link.boundingBox();
    expect(top).not.toBeNull();
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent, {
      x: (top?.x ?? 0) + 4,
      y: (top?.y ?? 0) + 1,
    });
    expect(hit).toBe("wiki に戻る");
  }

  test("エラーの画面の「wiki に戻る」は 44px 以上押せる", async ({ page }) => {
    await page.goto("/_auth/oauth/authorize");
    await expect(page.locator("h1")).toHaveText("接続できません");
    await expectBackTarget(page);
  });

  test("接続の一覧の「wiki に戻る」は 44px 以上押せる", async ({ page }) => {
    await page.goto("/_auth/oauth/grants");
    await expect(page.locator("h1")).toHaveText("許可した接続");
    await expectBackTarget(page);
  });
});
