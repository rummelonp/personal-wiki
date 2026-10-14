import { expect, test } from "./support/fixtures";
import { addSessionCookie, mintSessionValue } from "./support/session";
import { OWNER_EMAIL } from "./support/stack";

/*
 * E2E のログイン（support/session.ts で作る cookie）を Worker が owner と認めることを確かめる。
 * Worker の cookie の形式が変わったら、ここが最初に落ちる。
 */

const fetchMe = () => fetch("/api/me").then((res) => res.json() as Promise<{ kind: string }>);

test("作った cookie で owner として開ける @smoke", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(fetchMe)).toMatchObject({ kind: "owner" });
  await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();
});

/*
 * WebKit は http://localhost で、検証できない cookie を消す Set-Cookie（Secure 付き）を受け付けない。
 * cookie が残るので、続く一覧の取得が 401 になり、本文にログインの期限切れの案内が出る（https の本番では消える）。
 */
test.describe("検証できない cookie", () => {
  test.use({ role: "anonymous" });

  test("別の秘密で署名した cookie は匿名になる", async ({ page, context, browserName }) => {
    await addSessionCookie(
      context,
      browserName,
      process.env.E2E_ORIGIN ?? "",
      mintSessionValue("x".repeat(44), OWNER_EMAIL),
    );
    await page.goto("/");
    expect(await page.evaluate(fetchMe)).toMatchObject({ kind: "anonymous" });
    // 本文の側の案内はブラウザで変わる（describe の注記）ので、ヘッダーだけを見る
    await expect(page.getByRole("banner").getByRole("link", { name: "ログイン" })).toBeVisible();
  });

  test("期限の切れた cookie は匿名になる", async ({ page, context, browserName }) => {
    await addSessionCookie(
      context,
      browserName,
      process.env.E2E_ORIGIN ?? "",
      mintSessionValue(
        process.env.E2E_SESSION_SECRET ?? "",
        OWNER_EMAIL,
        Math.floor(Date.now() / 1000) - 60,
      ),
    );
    await page.goto("/");
    expect(await page.evaluate(fetchMe)).toMatchObject({ kind: "anonymous" });
  });
});
