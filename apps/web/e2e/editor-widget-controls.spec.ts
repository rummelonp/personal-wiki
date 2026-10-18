import type { Page } from "@playwright/test";
import type { OwnerApi } from "./support/api";
import { bodyEditor, expect, saveState, test, uniqueTitle } from "./support/fixtures";

/*
 * 本文の中のウィジェット（callout の開閉、frontmatter の tag、embed の「記法を編集」、添付の完了）の
 * 操作と表示。ウィジェットの単体の挙動はエディタのテストが見る。ここでは実際のブラウザで、Tab で届くことと、
 * 操作した後に focus が残ることを見る。
 */

// 1x1 の PNG。サーバーが形式を検査するので、読める画像にする。
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function openWithBody(page: Page, api: OwnerApi, title: string, body: string): Promise<void> {
  const created = await api.createPage({ title, body });
  await page.goto(`/p/${created.id}`);
  await expect(saveState(page)).toHaveText("保存済み");
}

/** hover できない端末（iPhone）では、文字だけの embed に編集ボタンを出さない */
const canHover = (page: Page) => page.evaluate(() => matchMedia("(hover: hover)").matches);

test("callout の開閉ボタンは Tab で届き、Enter と Space で開閉し、focus が残る", async ({
  page,
  api,
}, testInfo) => {
  await openWithBody(
    page,
    api,
    uniqueTitle(testInfo, "開閉"),
    "> [!note]- 手順\n> 中の本文\n\n外の本文",
  );
  const fold = bodyEditor(page).getByRole("button", { name: "「手順」の内容" });
  const inner = bodyEditor(page).locator(".cm-line", { hasText: "中の本文" });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(inner).toBeHidden();

  // caret が見出し行に触れていると、見出しは source で出て開閉ボタンが無い。別の行から Tab で入る
  await bodyEditor(page).locator(".cm-line", { hasText: "外の本文" }).click();
  await page.keyboard.press("Tab");
  await expect(fold).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(inner).toBeVisible();
  await expect(fold).toBeFocused();

  await page.keyboard.press("Space");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(inner).toBeHidden();
  await expect(fold).toBeFocused();
  // 開閉は本文を書き換えない
  await expect(saveState(page)).toHaveText("保存済み");
});

test("frontmatter の tag の chip は Tab で届き、Enter でタグの一覧へ移る", async ({
  page,
  api,
}, testInfo) => {
  const tag = `chip${Date.now().toString(36)}`;
  await openWithBody(page, api, uniqueTitle(testInfo, "chip"), `---\ntags: [${tag}]\n---\n本文`);
  const chip = bodyEditor(page).getByRole("link", { name: `#${tag}` });

  // caret が frontmatter に触れていると、枠は source で出て chip が無い。本文の行から Tab で入る
  await bodyEditor(page).locator(".cm-line", { hasText: "本文" }).click();
  await page.keyboard.press("Tab");
  await expect(chip).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(new RegExp(`tag=${tag}`));
});

test("callout の開閉ボタンから Shift+Tab で本文に戻ると、caret は Tab の前の位置にある", async ({
  page,
  api,
}, testInfo) => {
  await openWithBody(
    page,
    api,
    uniqueTitle(testInfo, "戻る callout"),
    "> [!note]- 手順\n> 中の本文\n\n外の本文",
  );
  const fold = bodyEditor(page).getByRole("button", { name: "「手順」の内容" });
  await bodyEditor(page).locator(".cm-line", { hasText: "外の本文" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  await expect(fold).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(fold).not.toBeFocused();
  await page.keyboard.type("X");
  await expect(bodyEditor(page).locator(".cm-line", { hasText: "外の本文" })).toHaveText(
    "外の本文X",
  );
});

test("tag の chip から Shift+Tab で本文に戻ると、caret は Tab の前の位置にある", async ({
  page,
  api,
}, testInfo) => {
  const tag = `back${Date.now().toString(36)}`;
  await openWithBody(
    page,
    api,
    uniqueTitle(testInfo, "戻る chip"),
    `---\ntags: [${tag}]\n---\n本文`,
  );
  const chip = bodyEditor(page).getByRole("link", { name: `#${tag}` });
  await bodyEditor(page).locator(".cm-line", { hasText: "本文" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  await expect(chip).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(chip).not.toBeFocused();
  await page.keyboard.type("X");
  await expect(bodyEditor(page).locator(".cm-line", { hasText: "本文" })).toHaveText("本文X");
});

test("短い名前の未解決の embed の「記法を編集」は、文字が省略されず、名前の下に出て editor からはみ出さない", async ({
  page,
  api,
}, testInfo) => {
  // 行の右端に寄る位置へ置いて、右へ切れる場合も見る
  const filler = "あ".repeat(14);
  await openWithBody(
    page,
    api,
    uniqueTitle(testInfo, "短い名前"),
    `前 ![[ab]] 後\n\n${filler} ![[cd]]\n\n最後`,
  );
  const editor = bodyEditor(page);
  await editor.locator(".cm-line", { hasText: "最後" }).click();
  for (const target of ["ab", "cd"]) {
    const embed = editor.locator(`.cm-embed[data-embed-target="${target}"]`);
    const button = embed.locator(".cm-embed-edit");
    await embed.hover();
    if (!(await canHover(page))) {
      await expect(button).toBeHidden();
      continue;
    }
    await expect(button).toBeVisible();
    await expect(button).toHaveCSS("opacity", "1");
    const clipped = await button.evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(clipped).toBe(false);
    const name = await embed.locator(".cm-embed-unresolved").boundingBox();
    const box = await button.boundingBox();
    const content = await editor.boundingBox();
    if (!name || !box || !content) throw new Error("the embed is not laid out");
    expect(box.y).toBeGreaterThanOrEqual(name.y + name.height - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(content.x + content.width + 0.5);
  }
});

test("文字だけの embed は、名前に hover して、名前の下に出た「記法を編集」を押すと記法が出る", async ({
  page,
  api,
}, testInfo) => {
  await openWithBody(page, api, uniqueTitle(testInfo, "ボタンの操作"), "前 ![[ab]] 後\n\n最後");
  const editor = bodyEditor(page);
  await editor.locator(".cm-line", { hasText: "最後" }).click();
  const embed = editor.locator('.cm-embed[data-embed-target="ab"]');
  await expect(editor.locator(".cm-embed-source")).toHaveCount(0);
  await embed.hover();
  const button = embed.locator(".cm-embed-edit");
  if (!(await canHover(page))) {
    await expect(button).toBeHidden();
    return;
  }
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  if (!box) throw new Error("the button is not laid out");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(editor.locator(".cm-embed-source")).toContainText("![[ab]]");
});

test("折り返した名前の embed では、「記法を編集」が名前の最後の行の左端の下に出る", async ({
  page,
  api,
}, testInfo) => {
  const name = "存在しないページの名前をとても長くして折り返す確認".repeat(3);
  await openWithBody(
    page,
    api,
    uniqueTitle(testInfo, "折り返した名前"),
    `前の文です。![[${name}]] 後\n\n最後`,
  );
  const editor = bodyEditor(page);
  await editor.locator(".cm-line", { hasText: "最後" }).click();
  const embed = editor.locator(".cm-embed-unresolved").locator("xpath=..");
  const button = embed.locator(".cm-embed-edit");
  if (!(await canHover(page))) {
    await embed.hover();
    await expect(button).toBeHidden();
    return;
  }
  const lastLine = await embed.evaluate((el) => {
    const r = [...(el.firstElementChild?.getClientRects() ?? [])];
    const last = r.at(-1);
    return { lines: r.length, x: last?.left ?? 0, y: last?.top ?? 0, bottom: last?.bottom ?? 0 };
  });
  expect(lastLine.lines).toBeGreaterThan(1);
  await page.mouse.move(lastLine.x + 10, lastLine.y + 4);
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  if (!box) throw new Error("the button is not laid out");
  expect(box.x).toBeCloseTo(lastLine.x, 0);
  expect(box.y).toBeCloseTo(lastLine.bottom, 0);
});

test("折り返した名前の embed に hover したまま前に文字を打っても、「記法を編集」は最後の行の左端の下に出続ける", async ({
  page,
  api,
}, testInfo) => {
  const name = "存在しないページの名前をとても長くして折り返す確認".repeat(3);
  await openWithBody(
    page,
    api,
    uniqueTitle(testInfo, "hover 中の打鍵"),
    `前の文です。![[${name}]] 後\n\n最後`,
  );
  const editor = bodyEditor(page);
  // caret を embed から離して先頭に置く（隣り合うと記法が source で出る）
  await editor.locator(".cm-line", { hasText: "最後" }).click();
  await page.keyboard.press("ControlOrMeta+Home");
  const embed = editor.locator(".cm-embed-unresolved").locator("xpath=..");
  const button = embed.locator(".cm-embed-edit");
  if (!(await canHover(page))) {
    await embed.hover();
    await expect(button).toBeHidden();
    return;
  }
  const lastLineOf = () =>
    embed.evaluate((el) => {
      const last = [...(el.firstElementChild?.getClientRects() ?? [])].at(-1);
      return { x: last?.left ?? 0, y: last?.top ?? 0, bottom: last?.bottom ?? 0 };
    });
  const first = await lastLineOf();
  await page.mouse.move(first.x + 10, first.y + 4);
  await expect(button).toBeVisible();
  // 打つたびに最初の行の左端が右へ動き、最後の行の左端との差が変わる
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.type("あいうえ");
    await expect
      .poll(async () => {
        const lastLine = await lastLineOf();
        const box = await button.boundingBox();
        return box
          ? Math.abs(box.x - lastLine.x) + Math.abs(box.y - lastLine.bottom)
          : Number.POSITIVE_INFINITY;
      })
      .toBeLessThan(1);
  }
});

test("embed の「記法を編集」は Tab で止まらず、callout の開閉と tag の chip は止まる", async ({
  page,
  api,
}, testInfo) => {
  await openWithBody(
    page,
    api,
    uniqueTitle(testInfo, "Tab の方針"),
    "---\ntags: [alpha]\n---\n> [!note]- 手順\n> 中の本文\n\n![[ab]] と ![[cd.png]]\n\n最後",
  );
  const editor = bodyEditor(page);
  await editor.locator(".cm-line", { hasText: "最後" }).click();
  const stops: string[] = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => String(document.activeElement?.className ?? "")));
  }
  expect(stops.some((name) => name.includes("cm-frontmatter-chip"))).toBe(true);
  expect(stops.some((name) => name.includes("cm-lp-callout-fold"))).toBe(true);
  expect(stops.some((name) => name.includes("cm-embed-edit"))).toBe(false);
});

test("caret が仮の記法の上にあるまま添付が済むと、添付の画像に替わる", async ({
  page,
  api,
}, testInfo) => {
  await openWithBody(page, api, uniqueTitle(testInfo, "添付の完了"), "本文");
  await bodyEditor(page).click();
  await page.keyboard.press("End");
  // アップロードを止めて、caret が仮の記法に触れた状態で「添付中」を描かせてから完了させる
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/attachments", async (route) => {
    await gate;
    await route.continue();
  });
  await bodyEditor(page).evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "dot.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, PNG_BASE64);
  // 仮の記法から離れて「添付中」の表示を描かせ、また記法に触れて source を出す
  await page.keyboard.press("Home");
  await expect(bodyEditor(page).locator(".cm-embed-uploading")).toHaveCount(1);
  await page.keyboard.press("End");
  await expect(bodyEditor(page)).toContainText("![[uploading.");
  await expect(bodyEditor(page).locator(".cm-embed-uploading")).toHaveCount(1);

  release();

  await expect(bodyEditor(page)).toContainText(/!\[\[[A-Za-z0-9_-]{22}\.png\]\]/);
  await expect(bodyEditor(page).locator(".cm-embed-uploading")).toHaveCount(0);
  await expect(bodyEditor(page).locator(".cm-embed img")).toHaveCount(1);
});
