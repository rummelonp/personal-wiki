import { afterEach, expect, it } from "vitest";
import { page as browserPage } from "vitest/browser";
import "./theme.css";
import "./styles.css";

let host: HTMLElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

it("embed の本文の editor は、本文の編集欄の最低の高さを受け継がない", async () => {
  await browserPage.viewport(1280, 800);
  host = document.createElement("div");
  host.innerHTML = `
    <div class="body-editor">
      <div class="cm-editor">
        <div class="cm-scroller">
          <span class="cm-embed-page-body">
            <div class="cm-editor"><div class="cm-scroller"><div class="cm-line">1 行だけの本文</div></div></div>
          </span>
        </div>
      </div>
    </div>`;
  document.body.append(host);
  const [outer, nested] = host.querySelectorAll<HTMLElement>(".cm-editor");
  if (!outer || !nested) throw new Error("editor が無い");
  expect(outer.getBoundingClientRect().height).toBeGreaterThanOrEqual(400);
  expect(nested.getBoundingClientRect().height).toBeLessThan(100);
});
