import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { SEED } from "./support/seed";

/*
 * 画面ごとに axe を走らせ、影響が serious 以上の違反を数える。いまある違反は a11y-known.json に
 * 書いて許し、そこに無い違反が出たときだけ落とす（アプリを直すのはこのテストの役目ではない）。
 * 画面ごとの件数は annotation（html の報告）に出す。
 *
 * 既知の違反は project ごとに書く（狭い画面ではヘッダーの文字を隠すので、出る違反が違う）。直したのに
 * 一覧に残るのを防ぐため、その project のどの画面でも出なくなった項目があれば最後のテストで落とす。
 * そのためにこのファイルは 1 つの worker で順に走らせ、見つけた違反を worker の中で集める。
 *
 * 違反の要素は、axe の target（CSS selector）ではなく、要素の名前と class で見分ける。target は
 * 画面の中で一意になる最短の selector なので、同じ要素でも画面やブラウザで変わる（`.save-state` と `p`、
 * class の並びの入れ替わりなど）。class は並びに依らないよう並べ替える。
 */

interface KnownViolation {
  rule: string;
  target: string;
  projects: string[];
  note: string;
}

const known: KnownViolation[] = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "a11y-known.json"), "utf8"),
);
const keyOf = (rule: string, target: string) => `${rule} ${target}`;

/** axe が返す要素の html の開始タグから `span.chip-count` の形を作る。 */
function elementOf(html: string): string {
  const open = /^<([a-z0-9-]+)([^>]*)>/i.exec(html);
  if (open === null) return html;
  const classes =
    /\bclass="([^"]*)"/
      .exec(open[2] ?? "")?.[1]
      ?.split(/\s+/)
      .filter(Boolean)
      .sort() ?? [];
  return [open[1]?.toLowerCase(), ...classes].join(".");
}

const knownFor = (project: string) => known.filter((v) => v.projects.includes(project));
const SCREENS = 9;
const checked = new Set<string>();
const seen = new Set<string>();

test.describe.configure({ mode: "serial" });

async function expectNoNewViolations(page: Page, screen: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  const found = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v) =>
      v.nodes.map((node) => ({
        rule: v.id,
        impact: v.impact,
        target: elementOf(node.html),
        summary: node.failureSummary?.split("\n")[1]?.trim() ?? v.help,
      })),
    );
  test.info().annotations.push({
    type: "axe",
    description: `${screen}: serious 以上 ${found.length} 件（${found.map((v) => keyOf(v.rule, v.target)).join(", ") || "なし"}）`,
  });
  checked.add(screen);
  for (const v of found) seen.add(keyOf(v.rule, v.target));
  const knownKeys = new Set(knownFor(test.info().project.name).map((v) => keyOf(v.rule, v.target)));
  const fresh = found.filter((v) => !knownKeys.has(keyOf(v.rule, v.target)));
  expect(fresh, `${screen} に a11y-known.json に無い違反がある`).toEqual([]);
}

test.describe("owner", () => {
  test("トップの一覧", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await expectNoNewViolations(page, "トップの一覧");
  });

  test("検索の結果", async ({ page }) => {
    await page.goto(`/?q=${encodeURIComponent("メモ")}`);
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await expectNoNewViolations(page, "検索の結果");
  });

  test("ページの編集", async ({ page, seedIds }) => {
    await page.goto(`/p/${seedIds[SEED.server]}`);
    await expect(page.locator(".title-input")).toHaveText(SEED.server);
    await expect(page.locator(".save-state")).toHaveText("保存済み");
    await expectNoNewViolations(page, "ページの編集");
  });

  test("タグが多いページ", async ({ page, seedIds }) => {
    await page.goto(`/p/${seedIds[SEED.manyTags]}`);
    await expect(page.locator(".title-input")).toHaveText(SEED.manyTags);
    await expectNoNewViolations(page, "タグが多いページ");
  });

  test("quick switcher", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "ページを検索" }).click();
    await page
      .getByRole("dialog", { name: "ページを検索" })
      .getByRole("combobox", { name: "ページを検索" })
      .fill("メモ");
    await expect(page.getByRole("option").first()).toBeVisible();
    await expectNoNewViolations(page, "quick switcher");
  });

  test("新規作成の画面", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "新規作成" }).click();
    await expect(page.locator(".title-input .cm-content")).toBeFocused();
    await expectNoNewViolations(page, "新規作成の画面");
  });
});

test.describe("匿名", () => {
  test.use({ role: "anonymous" });

  test("トップの一覧（匿名）", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".entries .entry").first()).toBeVisible();
    await expectNoNewViolations(page, "トップの一覧（匿名）");
  });

  test("public のページ", async ({ page }) => {
    await page.goto(`/${encodeURIComponent(SEED.welcome)}`);
    await expect(page.getByRole("heading", { level: 1, name: SEED.welcome })).toBeVisible();
    await expectNoNewViolations(page, "public のページ");
  });

  test("存在しないページ", async ({ page }) => {
    await page.goto(`/${encodeURIComponent("本当に存在しないページ")}`);
    await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();
    await expectNoNewViolations(page, "存在しないページ");
  });
});

test("既知の違反の一覧は、規則と対象の組が重ならない", () => {
  expect(new Set(known.map((v) => keyOf(v.rule, v.target))).size).toBe(known.length);
});

test("既知の違反は、どれもこの project のどこかの画面でまだ出る", () => {
  // 一部の画面だけを選んで走らせたときは、出なかったことを確かめられない
  test.skip(checked.size < SCREENS, "すべての画面を調べていない");
  const stale = knownFor(test.info().project.name)
    .map((v) => keyOf(v.rule, v.target))
    .filter((key) => !seen.has(key));
  expect(stale, "直った違反を a11y-known.json から外す").toEqual([]);
});
