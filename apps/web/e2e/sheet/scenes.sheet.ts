import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { ApiPage, OwnerApi } from "../support/api";
import { bodyEditor, expect, saveState, test, typeAtBodyEnd } from "../support/fixtures";
import { SEED } from "../support/seed";

/*
 * 画面の一覧に載せる画面と状態。1 つの状態を 1 つのテストにし、明暗と幅は project で切り替える。
 * 撮った画像の横に、run.mjs が一覧を組むための JSON（画面、状態、並び順）を置く。
 */

interface SceneContext {
  page: Page;
  api: OwnerApi;
  seedIds: Record<string, string>;
  title: string;
}

interface Scene {
  id: string;
  screen: string;
  state: string;
  role: "owner" | "anonymous";
  show(ctx: SceneContext): Promise<void>;
}

async function openSeed(page: Page, seedIds: Record<string, string>, title: string) {
  await page.goto(`/p/${seedIds[title]}`);
  await expect(page.locator(".title-input")).toHaveText(title);
  await expect(saveState(page)).toHaveText("保存済み");
}

async function openFresh(page: Page, api: OwnerApi, title: string, body: string): Promise<ApiPage> {
  const created = await api.createPage({ title, body });
  await page.goto(`/p/${created.id}`);
  // 先頭の行は見出しの記号を隠して表示するので、装飾の無い最後の行で待つ
  await expect(bodyEditor(page)).toContainText(body.split("\n").at(-1) ?? "");
  await expect(saveState(page)).toHaveText("保存済み");
  return created;
}

const EDIT_BODY = `## 今日やること

- [ ] [[${SEED.server}]] を読み直す
- [x] **太字** と \`code\` の表示を確かめる

段落の途中で書き足している`;

const SCENES: Scene[] = [
  {
    id: "home",
    screen: "トップ",
    state: "最近の更新（owner）",
    role: "owner",
    async show({ page }) {
      await page.goto("/");
      await expect(page.locator(".entries .entry").first()).toBeVisible();
    },
  },
  {
    id: "search",
    screen: "検索",
    state: "結果あり",
    role: "owner",
    async show({ page }) {
      await page.goto(`/?q=${encodeURIComponent("メモ")}`);
      await expect(page.locator(".entries .entry").first()).toBeVisible();
    },
  },
  {
    id: "search-empty",
    screen: "検索",
    state: "0 件",
    role: "owner",
    async show({ page }) {
      await page.goto(`/?q=${encodeURIComponent("どこにも無い語句")}`);
      await expect(page.getByRole("heading", { name: "一致するページがありません" })).toBeVisible();
    },
  },
  {
    id: "page-owner",
    screen: "ページ",
    state: "開いたところ（owner）",
    role: "owner",
    async show({ page, seedIds }) {
      await openSeed(page, seedIds, SEED.server);
    },
  },
  {
    id: "page-editing",
    screen: "ページ",
    state: "編集中（未保存）",
    role: "owner",
    async show({ page, api, title }) {
      await openFresh(page, api, title, EDIT_BODY);
      await typeAtBodyEnd(page, "の文");
      await expect(saveState(page)).toHaveText("未保存の変更あり");
    },
  },
  {
    id: "page-long-title",
    screen: "ページ",
    state: "長い title",
    role: "owner",
    async show({ page, seedIds }) {
      await openSeed(page, seedIds, SEED.longTitle);
    },
  },
  {
    id: "page-many-tags",
    screen: "ページ",
    state: "タグが多い",
    role: "owner",
    async show({ page, seedIds }) {
      await openSeed(page, seedIds, SEED.manyTags);
    },
  },
  {
    id: "page-auth-lost",
    screen: "ページ",
    state: "ログインの期限切れ",
    role: "owner",
    async show({ page, api, title }) {
      const created = await openFresh(page, api, title, "ログインが切れる前からある行");
      await page.route(`**/api/pages/${created.id}`, (route) =>
        route.request().method() === "PUT"
          ? route.fulfill({
              status: 401,
              contentType: "application/json",
              body: JSON.stringify({ error: "unauthorized" }),
            })
          : route.fallback(),
      );
      await typeAtBodyEnd(page, "、切れたあとに打った文");
      await expect(
        page.getByRole("alert").filter({ hasText: "ログインの期限が切れました" }),
      ).toBeVisible();
    },
  },
  {
    id: "page-conflict",
    screen: "ページ",
    state: "衝突",
    role: "owner",
    async show({ page, api, title }) {
      const created = await openFresh(page, api, title, "共通の行\n二行目");
      let external: Promise<ApiPage> | undefined;
      // 保存を送る直前に別の場所で同じ行を書き換え、古い版への保存にする（failures.spec.ts と同じ）
      await page.route(`**/api/pages/${created.id}`, async (route) => {
        if (route.request().method() !== "PUT") return route.fallback();
        external ??= api.updatePage(created, { body: "共通の行\n別の場所で書き換えた二行目" });
        // 失敗は下で await して出す。handler の中で投げると、原因の書かれない失敗になる
        const updated = await external.then(
          () => true,
          () => false,
        );
        return updated ? route.fallback() : route.abort();
      });
      await typeAtBodyEnd(page, "を手元で書き換えた");
      await expect.poll(() => external, "保存が送られない").toBeDefined();
      await external;
      await expect(
        page.getByRole("heading", { name: "サーバーの内容と食い違っています" }),
      ).toBeVisible();
    },
  },
  {
    id: "new-page",
    screen: "ページ",
    state: "新規作成（title を決める前）",
    role: "owner",
    async show({ page }) {
      await page.goto("/");
      await page.getByRole("button", { name: "新規作成" }).click();
      await expect(page.locator(".title-input .cm-content")).toBeFocused();
      // Enter を押すと作ってしまうので、打つだけにする
      await page.keyboard.type("新しいページの title");
    },
  },
  {
    id: "switcher",
    screen: "ダイアログ",
    state: "quick switcher",
    role: "owner",
    async show({ page }) {
      await page.goto("/");
      await page.getByRole("button", { name: "ページを検索" }).click();
      await page
        .getByRole("dialog", { name: "ページを検索" })
        .getByRole("combobox", { name: "ページを検索" })
        .fill("メモ");
      await expect(page.getByRole("option").first()).toBeVisible();
    },
  },
  {
    id: "anonymous-page",
    screen: "匿名",
    state: "public のページ",
    role: "anonymous",
    async show({ page }) {
      await page.goto(`/${encodeURIComponent(SEED.welcome)}`);
      await expect(page.getByRole("heading", { level: 1, name: SEED.welcome })).toBeVisible();
    },
  },
  {
    id: "anonymous-not-found",
    screen: "匿名",
    state: "存在しないページ",
    role: "anonymous",
    async show({ page }) {
      await page.goto(`/${encodeURIComponent("本当に存在しないページ")}`);
      await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();
    },
  },
];

function outDir(): string {
  const dir = process.env.E2E_SHEET_DIR;
  if (dir === undefined) throw new Error("E2E_SHEET_DIR が無い（e2e/sheet/run.mjs から実行する）");
  return dir;
}

for (const role of ["owner", "anonymous"] as const) {
  test.describe(role, () => {
    test.use({ role });
    for (const scene of SCENES.filter((s) => s.role === role)) {
      test(scene.id, async ({ page, api, seedIds }, testInfo) => {
        // title は重ねられないので、同じ状態を撮る project ごとに変える
        const title = `${scene.state} ${testInfo.project.name}`;
        await scene.show({ page, api, seedIds, title });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const base = `${scene.id}--${testInfo.project.name}`;
        await page.screenshot({
          path: resolve(outDir(), "shots", `${base}.png`),
          animations: "disabled",
          caret: "hide",
        });
        const [scheme, width] = testInfo.project.name.split("-");
        writeFileSync(
          resolve(outDir(), "shots", `${base}.json`),
          JSON.stringify({
            id: scene.id,
            order: SCENES.indexOf(scene),
            screen: scene.screen,
            state: scene.state,
            scheme,
            width: Number(width),
            file: `shots/${base}.png`,
          }),
        );
      });
    }
  });
}
