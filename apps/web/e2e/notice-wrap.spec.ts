import { expect, test } from "./support/fixtures";

/*
 * 通知の見出しと本文の折り返し。小さい仮名（ゃ、っ）、長音（ー）、句読点を行頭に置かない。
 * 行頭に来る文字は文字ごとの Range の位置で測る。幅を 150〜360px で振ると、WebKit の既定の禁則
 * （line-break: auto）では小さい仮名が行頭に来る幅が現れる。
 * 語の途中で折り返すのは測らない。word-break: auto-phrase は WebKit が解釈しないので、
 * iPhone ではこのテストの対象外の限界として残る。
 */

const TITLE = "ショートカットのキャンセルができませんでした";
const TEXT =
  "ちょっとしたシャッターを切ってください。ニュースのキャンセルはじゅうぶんにっこりしゃべりながら、きっちりぎゅっとゆっくりフェッチしたデータをコーヒーのようにリフレッシュします。";
const LINE_HEAD_PROHIBITED = "ゃゅょっぁぃぅぇぉゎャュョッァィゥェォヮー、。，．";

test("通知の見出しと本文は、どの幅でも小さい仮名、長音、句読点が行頭に来ない", async ({ page }) => {
  await page.goto("/");
  const violations = await page.evaluate(
    ({ title, text, prohibited }) => {
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;top:0;left:0;visibility:hidden";
      host.innerHTML = `<section class="notice notice-info"><h2 class="notice-title"><span class="dot"></span>${title}</h2><div class="notice-text"><p>${text}</p></div></section>`;
      document.body.append(host);
      const section = host.firstElementChild as HTMLElement;

      const lineHeads = (root: Element): string[] => {
        const heads: string[] = [];
        let top: number | null = null;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const data = (node as Text).data;
          for (let index = 0; index < data.length; index++) {
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            const rect = range.getBoundingClientRect();
            if (rect.width === 0) continue;
            const lineTop = Math.round(rect.top);
            if (top !== null && lineTop !== top) heads.push(data[index] as string);
            top = lineTop;
          }
        }
        return heads;
      };

      const found: string[] = [];
      for (let width = 150; width <= 360; width += 3) {
        section.style.width = `${width}px`;
        for (const selector of [".notice-title", ".notice-text"]) {
          const root = section.querySelector(selector) as Element;
          for (const head of lineHeads(root)) {
            if (prohibited.includes(head)) found.push(`${selector} ${width}px 「${head}」`);
          }
        }
      }
      host.remove();
      return found;
    },
    { title: TITLE, text: TEXT, prohibited: LINE_HEAD_PROHIBITED },
  );
  expect(violations).toEqual([]);
});
