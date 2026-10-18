import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { REDIRECT_URI as CALLBACK, connectOAuthClient } from "./support/principals";

/*
 * OAuth の画面（同意、エラー、接続の一覧）の折り返し、タッチ端末での押せる範囲、同意の送信、接続の取り消し。
 * 画面は Worker が組む HTML で、SPA の styles.css は読まない。
 * 行の折れ目は座標で測る。`word-break: auto-phrase` は WebKit に無いので、測るのは Chromium だけにする（@widths）。
 */

/** Worker が取り消しの知らせを渡す cookie。Secure なので、ブラウザによっては http://localhost で受け付けない */
const NOTICE_COOKIE_NAME = "__Host-wiki_oauth_notice";

// 文節の途中で切れないことを見る語。画面の警告文（.warn）に含まれる
const WORDS = ["許可", "ください", "リンク", "接続", "自分", "限りません", "始めた"];

async function openConsent(page: Page): Promise<void> {
  const origin = process.env.E2E_ORIGIN ?? "";
  // global setup が 1 件だけ登録した client
  const clientId = process.env.E2E_CONSENT_CLIENT_ID ?? "";
  expect(clientId, "global setup が同意画面用の client を登録していない").not.toBe("");
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
  const response = await page.goto(`/_auth/oauth/authorize?${params}`);
  await expect(page.locator("h1")).toContainText("接続を許可しますか");
  // WebKit は http://localhost で Secure の Set-Cookie を受け付けず、同意の binding の cookie が無いと
  // 送信が通らない。受け付けなかったときは置き直す（WebKit が送るのは url で置いた cookie だけ）
  const binding = /^(__Host-oauth-consent-[^=;]+)=([^;]*)/.exec(
    (await response?.headerValue("set-cookie")) ?? "",
  );
  expect(binding).not.toBeNull();
  const [, name = "", value = ""] = binding ?? [];
  if (!(await page.context().cookies()).some((cookie) => cookie.name === name)) {
    await page
      .context()
      .addCookies([{ name, value, url: origin, secure: true, httpOnly: true, sameSite: "Lax" }]);
  }
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

/**
 * 同意の送信を Worker へ流して数え、応答は release まで返さない。client への 302 は辿らず（送り先は
 * claude.ai）、Location を載せた画面に置き換える。それ以外の応答（エラーの画面）はそのまま返す。
 */
async function holdConsentSubmissions(
  page: Page,
): Promise<{ count: () => number; release: () => void }> {
  let count = 0;
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === "/_auth/oauth/authorize",
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      count += 1;
      const response = await route.fetch({ maxRedirects: 0 });
      await released;
      const location = response.headers().location;
      try {
        await route.fulfill(
          response.status() === 302 && location !== undefined
            ? {
                status: 200,
                contentType: "text/html; charset=utf-8",
                body: `<!doctype html><p id="location">${location.replaceAll("&", "&amp;")}</p>`,
              }
            : { response },
        );
      } catch {
        // 後の送信に置き換えられた遷移は、fulfill の前に打ち切られる
      }
    },
  );
  return { count: () => count, release };
}

/** 承認の応答が、client の redirect URI へ code と state を付けて戻すものだったこと */
async function expectCallback(page: Page): Promise<void> {
  await expect(page.locator("#location")).toBeVisible();
  const location = new URL((await page.locator("#location").textContent()) ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
  expect(location.searchParams.get("code")).toBeTruthy();
  expect(location.searchParams.get("state")).toBe("e2e");
}

test.describe("同意の送信", () => {
  // release の前に落ちたテストの handler を残さない
  test.afterEach(({ page }) => page.unrouteAll({ behavior: "ignoreErrors" }));

  test("「許可する」を続けて押しても送信は 1 回で、client へ code を付けて戻す", async ({
    page,
  }) => {
    await openConsent(page);
    const submissions = await holdConsentSubmissions(page);
    // 2 回目の押下は、1 回目の送信が Worker に届いた後、応答が返る前に当てる。続けて押すだけだと
    // ブラウザが 1 回目の遷移を始める前に 2 回目で置き換え、送信は 1 回で済む。遷移の途中の locator は
    // 遷移の終わりを待つので、座標で押す
    const approve = page.getByRole("button", { name: "許可する" });
    await approve.scrollIntoViewIfNeeded();
    const box = await approve.boundingBox();
    if (box === null) throw new Error("「許可する」の位置を取れない");
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.click(x, y);
    await expect.poll(submissions.count).toBe(1);
    await page.mouse.click(x, y);
    // 2 回目の送信が起きた場合に、Worker へ届くまで待つ
    await page.waitForTimeout(500);
    submissions.release();

    await expectCallback(page);
    expect(submissions.count()).toBe(1);
  });

  test("送信すると、許可と拒否のボタンをどちらも無効にする", async ({ page }) => {
    await openConsent(page);
    // 応答を待つ間は遷移の途中で、locator は遷移の終わりを待つ。遷移を取りやめて同意画面に留める
    let count = 0;
    await page.route(
      (url) => url.pathname === "/_auth/oauth/authorize",
      (route) => {
        if (route.request().method() !== "POST") return route.continue();
        count += 1;
        return route.abort("aborted");
      },
    );
    await page.getByRole("button", { name: "許可する" }).click();

    await expect(page.getByRole("button", { name: "許可する" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "拒否する" })).toBeDisabled();
    await expect.poll(() => count).toBe(1);
  });

  // 戻るは確かめない。ここの client への遷移は同意画面と同じ URL に留まり、Firefox は履歴を置き換えるので戻れない
  // これは「再読み込み後に押せる状態で開く」ことだけを見る smoke で、pageshow の対策の回帰は拾わない。
  // Playwright ではどのエンジンでも、再読み込みでフォームの状態が復元されず、bfcache からの復帰も起きないため
  test("送信が届かずに再読み込みすると、ボタンを押せる @smoke", async ({ page }) => {
    await openConsent(page);
    await page.route(
      (url) => url.pathname === "/_auth/oauth/authorize",
      (route) => (route.request().method() === "POST" ? route.abort("aborted") : route.continue()),
    );
    await page.getByRole("button", { name: "許可する" }).click();
    await expect(page.getByRole("button", { name: "許可する" })).toBeDisabled();

    await page.reload();
    await expect(page.locator("h1")).toContainText("接続を許可しますか");
    await expect(page.getByRole("button", { name: "許可する" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "拒否する" })).toBeEnabled();
  });

  test("動きを減らす設定では、押したボタンを縮めない", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "CSS の詳細度だけを見るので、1 つのエンジンで足りる");
    await openConsent(page);
    const approve = page.getByRole("button", { name: "許可する" });
    await approve.scrollIntoViewIfNeeded();
    const box = await approve.boundingBox();
    if (box === null) throw new Error("「許可する」の位置を取れない");
    const transform = () => approve.evaluate((el) => getComputedStyle(el).transform);
    // 押したまま（:active）で測り、離す前に外へ動かして送信しない
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(transform).not.toBe("none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(transform).toBe("none");
    await page.mouse.move(0, 0);
    await page.mouse.up();
  });

  test.describe("JS が無い環境", () => {
    test.use({ javaScriptEnabled: false });

    test("form は送れて、client へ code を付けて戻す", async ({ page }) => {
      await openConsent(page);
      const submissions = await holdConsentSubmissions(page);
      submissions.release();
      await page.getByRole("button", { name: "許可する" }).click();

      await expectCallback(page);
      expect(submissions.count()).toBe(1);
    });
  });
});

test.describe("接続の取り消し", () => {
  test("取り消すと一覧へ移り、取り消した接続の名前と許可の日時を 1 回だけ出す", async ({
    page,
    browserName,
  }, testInfo) => {
    // ほかの環境や繰り返しの同じテストも同じ KV に接続を足すので、名前を実行ごとに分け、件数ではなく grant の id で確かめる
    const name = `Claude ${testInfo.project.name} ${testInfo.repeatEachIndex}`;
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
    const grantsUrl = /\/_auth\/oauth\/grants$/;
    // 知らせの cookie は一覧を開く応答で消えるので、一覧への遷移の要求に付いたかで、ブラウザが受け入れたかを見る。
    // WebKit は拒んだ Set-Cookie を応答の headers にも出さないので、Worker が出したかは取り消しの応答からは見えない
    const grantsRequest = page.waitForRequest(
      (request) => grantsUrl.test(request.url()) && request.redirectedFrom() !== null,
    );
    await target.getByRole("button", { name: /^取り消す/ }).click();
    const noticeSent = ((await (await grantsRequest).allHeaders()).cookie ?? "").includes(
      NOTICE_COOKIE_NAME,
    );
    testInfo.annotations.push({
      type: "知らせの cookie",
      description: noticeSent ? "入った" : "入らなかった",
    });
    // Chromium は localhost を安全な文脈として Secure の cookie を受け付ける。
    // ここで入らなければ Worker が知らせを出していないので、入らなかった経路で黙って通さない
    if (browserName === "chromium") expect(noticeSent).toBe(true);
    await expect(page).toHaveURL(grantsUrl);
    await expect(page.locator(`input[name="grant"][value="${grant}"]`)).toHaveCount(0);
    // cookie が入らないブラウザ（http://localhost の WebKit など）でも、取り消しと一覧への遷移は変わらない
    if (noticeSent) {
      await expect(page.locator(".done")).toHaveText(
        `${name}（${granted} に許可）の接続を取り消しました。`,
      );
    } else {
      await expect(page.locator(".done")).toHaveCount(0);
    }

    await page.reload();
    await expect(page).toHaveURL(grantsUrl);
    await expect(page.locator("h1")).toHaveText("許可した接続");
    await expect(page.locator(".done")).toHaveCount(0);

    await page.getByRole("link", { name: "wiki に戻る" }).click();
    await expect(page).not.toHaveURL(grantsUrl);
    await page.goBack();
    await expect(page).toHaveURL(grantsUrl);
    await expect(page.locator("h1")).toHaveText("許可した接続");
    await expect(page.locator(".done")).toHaveCount(0);
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
