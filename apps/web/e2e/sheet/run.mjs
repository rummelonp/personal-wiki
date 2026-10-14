// 画面の一覧を作る。playwright.sheet.config.ts でスクリーンショットを撮り、1 枚の HTML にまとめる。
//
//   pnpm e2e:sheet [--out <dir>]
//
// 既定の出力先は apps/web/e2e-output/sheet/<UTC の日時>/。--out の相対パスは pnpm を実行した
// ディレクトリ（INIT_CWD）を起点にする。
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const webDir = resolve(import.meta.dirname, "../..");

function parseOut(argv) {
  let out;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--out にはディレクトリを渡す");
      }
      out = value;
      i++;
      continue;
    }
    throw new Error(`知らない引数: ${arg}`);
  }
  if (out !== undefined) return resolve(process.env.INIT_CWD ?? process.cwd(), out);
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
  return resolve(webDir, "e2e-output/sheet", stamp);
}

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

function buildIndex(outDir) {
  const shotsDir = resolve(outDir, "shots");
  const shots = readdirSync(shotsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(resolve(shotsDir, name), "utf8")));
  const schemeOrder = { light: 0, dark: 1 };
  shots.sort(
    (a, b) =>
      a.order - b.order || schemeOrder[a.scheme] - schemeOrder[b.scheme] || a.width - b.width,
  );

  const screens = new Map();
  for (const shot of shots) {
    if (!screens.has(shot.screen)) screens.set(shot.screen, new Map());
    const states = screens.get(shot.screen);
    if (!states.has(shot.state)) states.set(shot.state, []);
    states.get(shot.state).push(shot);
  }

  const sections = [...screens]
    .map(([screen, states]) => {
      const groups = [...states]
        .map(([state, list]) => {
          const figures = list
            .map(
              (shot) => `<figure class="shot-${escapeHtml(shot.scheme)}">
  <a href="${escapeHtml(shot.file)}" target="_blank" rel="noopener"><img src="${escapeHtml(shot.file)}" alt="${escapeHtml(`${screen} / ${state}（${shot.scheme}、${shot.width}px）`)}" loading="lazy"></a>
  <figcaption>${escapeHtml(shot.scheme)} · ${shot.width}px</figcaption>
</figure>`,
            )
            .join("\n");
          return `<h3>${escapeHtml(state)}</h3>\n<div class="shots">\n${figures}\n</div>`;
        })
        .join("\n");
      return `<section>\n<h2>${escapeHtml(screen)}</h2>\n${groups}\n</section>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>画面の一覧</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #1f2329; --muted: #6b7180; --line: #d9dce3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #16181d; --fg: #e6e8ec; --muted: #9aa1ad; --line: #343843; } }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.6 system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: var(--muted); margin: 0 0 24px; }
  section { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 24px; }
  h2 { font-size: 18px; margin: 0 0 8px; }
  h3 { font-size: 15px; margin: 16px 0 8px; color: var(--muted); }
  .shots { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
  figure { margin: 0; width: 200px; }
  img { display: block; width: 100%; height: 160px; object-fit: cover; object-position: top; border: 1px solid var(--line); border-radius: 4px; }
  figcaption { color: var(--muted); font-size: 12px; margin-top: 4px; }
</style>
</head>
<body>
<h1>画面の一覧</h1>
<p class="meta">${escapeHtml(new Date().toISOString())} · ${shots.length} 枚 · 画像を押すと原寸で開く</p>
${sections}
</body>
</html>
`;
  writeFileSync(resolve(outDir, "index.html"), html);
  return shots.length;
}

const outDir = parseOut(process.argv.slice(2));
mkdirSync(resolve(outDir, "shots"), { recursive: true });
const run = spawnSync("pnpm", ["exec", "playwright", "test", "-c", "playwright.sheet.config.ts"], {
  cwd: webDir,
  stdio: "inherit",
  env: { ...process.env, E2E_SHEET_DIR: outDir },
});
// 撮れなかった画面があっても、撮れた分で一覧を作ってから終了コードを返す
const count = buildIndex(outDir);
console.log(`画面の一覧: ${resolve(outDir, "index.html")}（${count} 枚）`);
process.exit(run.status ?? 1);
