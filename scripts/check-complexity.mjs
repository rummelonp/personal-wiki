// 関数ごとの認知的複雑度（SonarSource の定義）を cccc で測り、上限を超える関数が増えていないか検査する。
//   引数なし:  baseline と比べ、違いがあれば一覧を出して終了コード 1 で終わる
//   --update:  今の値で baseline を書き直す
// 上限を超えている既存の関数は baseline に載せて許し、新しく超えた関数と、baseline より値が上がった関数を
// 落とす。値が下がった関数と、上限以下になった関数も落とす（baseline を今の値に合わせて締めるため）。
//
// 関数は「ファイルのパス + 入れ子の名前の並び」で見分け、行番号は使わない（上の行を編集するたびに
// baseline がずれないため）。同じ名前の関数が同じ入れ子に複数あるとき（無名関数など）は、値を大きい順に
// 並べて組にして比べる。同じ key の中ではどの関数の値が変わったかを見分けられないので、上がった分が
// 下がった分に隠れることがある（その分は baseline の差分のレビューで拾う）。
// 循環的複雑度は検査しない。JSX の条件の分岐で膨らみ、読みにくさの指標としては認知的複雑度で足りるため。
//
// 版で値の数え方が変わりうるので、cccc の版は baseline に書いた版と同じでなければ失敗にする。
// CI も baseline の版の Release を入れる。
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = join(ROOT, "scripts/complexity-baseline.json");
const TARGETS = ["apps", "packages", "scripts", "vitest.config.ts"];

/**
 * @typedef {{ name: string, line: number, cognitive: number, children?: CcccFunction[] }} CcccFunction
 * @typedef {{ files: { path: string, functions: CcccFunction[] }[],
 *   summary: { parse_error_count: number } }} CcccReport
 * @typedef {{ cccc: string, maxCognitive: number, functions: Record<string, number[]> }} Baseline
 * @typedef {{ key: string, line: number, cognitive: number }} Measured
 */

/**
 * 上限を超える関数を、見分ける key ごとに値の大きい順に集める。
 * @param {CcccReport} report
 * @param {number} max
 * @returns {Map<string, Measured[]>}
 */
export function overLimit(report, max) {
  /** @type {Map<string, Measured[]>} */
  const found = new Map();
  /** @param {string} path @param {string[]} names @param {CcccFunction} fn */
  const visit = (path, names, fn) => {
    const chain = [...names, fn.name];
    if (fn.cognitive > max) {
      const key = `${path}:${chain.join(" > ")}`;
      const list = found.get(key) ?? [];
      list.push({ key, line: fn.line, cognitive: fn.cognitive });
      found.set(key, list);
    }
    for (const child of fn.children ?? []) visit(path, chain, child);
  };
  for (const file of report.files) {
    for (const fn of file.functions) visit(file.path, [], fn);
  }
  for (const list of found.values()) list.sort((a, b) => b.cognitive - a.cognitive);
  return found;
}

/**
 * @param {CcccReport} report
 * @param {string} version
 * @param {number} max
 * @returns {Baseline}
 */
export function toBaseline(report, version, max) {
  const measured = overLimit(report, max);
  /** @type {Record<string, number[]>} */
  const functions = {};
  for (const key of [...measured.keys()].sort()) {
    functions[key] = (measured.get(key) ?? []).map((m) => m.cognitive);
  }
  return { cccc: version, maxCognitive: max, functions };
}

/**
 * baseline と今の値の違いを返す。
 * @param {CcccReport} report
 * @param {Baseline} baseline
 * @returns {{ worse: string[], stale: string[] }}
 */
export function compare(report, baseline) {
  const measured = overLimit(report, baseline.maxCognitive);
  /** @type {string[]} */
  const worse = [];
  /** @type {string[]} */
  const stale = [];
  const keys = new Set([...measured.keys(), ...Object.keys(baseline.functions)]);
  for (const key of [...keys].sort()) {
    const now = measured.get(key) ?? [];
    const before = baseline.functions[key] ?? [];
    for (let i = 0; i < Math.max(now.length, before.length); i++) {
      const m = now[i];
      const b = before[i];
      if (m === undefined) stale.push(`${key}: ${b} から上限以下になった`);
      else if (b === undefined) worse.push(`${key} (${m.line} 行): ${m.cognitive} で上限を超えた`);
      else if (m.cognitive > b)
        worse.push(`${key} (${m.line} 行): ${b} から ${m.cognitive} に上がった`);
      else if (m.cognitive < b)
        stale.push(`${key} (${m.line} 行): ${b} から ${m.cognitive} に下がった`);
    }
  }
  return { worse, stale };
}

/**
 * @param {string} json cccc の出力
 * @returns {CcccReport}
 */
export function readReport(json) {
  /** @type {CcccReport} */
  const report = JSON.parse(json);
  // 解析できなかったファイルは測られないまま通るので、失敗にする
  if (report.summary.parse_error_count > 0) {
    throw new Error(`cccc が ${report.summary.parse_error_count} 件のファイルを解析できなかった`);
  }
  return report;
}

/** @param {string[]} args */
function cccc(args) {
  return spawnSync("cccc", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** @param {string} version */
function measure(version) {
  const install = `cargo install cccc-cli --version ${version} --locked で入れる`;
  const probe = cccc(["--version"]);
  if (probe.error) throw new Error(`cccc が見つからない。${install}`);
  const actual = probe.stdout.trim().replace(/^cccc\s+/, "");
  if (actual !== version)
    throw new Error(`cccc の版が ${actual} で、baseline の ${version} と違う。${install}`);

  // cccc は cwd から上のディレクトリの cccc.toml も読むので、repo の外の設定で結果が変わらないようにする
  const run = cccc(["--no-config", "--no-cache", ...TARGETS]);
  if (run.status !== 0)
    throw new Error(`cccc が失敗した (終了コード ${run.status})\n${run.stderr}`);
  return readReport(run.stdout);
}

function main() {
  /** @type {Baseline} */
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  const report = measure(baseline.cccc);

  if (process.argv.includes("--update")) {
    const next = toBaseline(report, baseline.cccc, baseline.maxCognitive);
    writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`);
    // JSON.stringify は配列を 1 要素ずつ改行するので、biome の整形に合わせないと pnpm lint で落ちる
    const biome = join(ROOT, "node_modules/.bin/biome");
    const format = spawnSync(biome, ["format", "--write", BASELINE_FILE], { encoding: "utf8" });
    if (format.status !== 0)
      throw new Error(`biome で baseline を整形できなかった\n${format.stderr}`);
    const count = Object.values(next.functions).reduce((sum, list) => sum + list.length, 0);
    console.error(`${count} 件の関数を baseline に書いた`);
    return;
  }

  const { worse, stale } = compare(report, baseline);
  if (worse.length > 0) {
    console.error(`認知的複雑度が上限の ${baseline.maxCognitive} を超えた関数があります`);
    for (const line of worse) console.error(`  ${line}`);
    console.error("関数を分けるなどして下げる");
  }
  if (stale.length > 0) {
    console.error("baseline より認知的複雑度が下がった関数があります");
    for (const line of stale) console.error(`  ${line}`);
    // --update は上がった値もそのまま baseline に取り込む
    console.error(
      worse.length > 0
        ? "上がった関数を直してから、pnpm complexity:update で baseline を今の値に合わせる"
        : "pnpm complexity:update で baseline を今の値に合わせる",
    );
  }
  if (worse.length > 0 || stale.length > 0) process.exit(1);
}

// import.meta.url は symlink を解決した後のパスになるので、argv も解決して比べる（比べ損ねると検査を
// 飛ばしたまま終了コード 0 で通る）
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
