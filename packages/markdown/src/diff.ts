export type LineDiffKind = "equal" | "delete" | "insert";

export interface LineDiff {
  readonly kind: LineDiffKind;
  /** 改行を含まない行の内容。 */
  readonly text: string;
  /** 旧テキストでの 1 始まりの行番号。`insert` では null。 */
  readonly oldLine: number | null;
  /** 新テキストでの 1 始まりの行番号。`delete` では null。 */
  readonly newLine: number | null;
}

const EQUAL = 0;
const DELETE = 1;
const INSERT = 2;
type RunKind = typeof EQUAL | typeof DELETE | typeof INSERT;
type Run = [kind: RunKind, count: number];

/**
 * markdown 本文同士の行単位のテキスト差分。
 * 最短の編集列（一致する行数が最長共通部分列と等しい）を返す。
 * 変更箇所の中では削除した行を挿入した行より先に並べる。
 *
 * 行は `"\n"` で区切り、CodeMirror 6 と同じ数え方をする。空文字列は空行 1 行、`"a\n"` は `"a"` と
 * 空行の 2 行になるので、`oldLine`・`newLine` は Editor に表示される行番号と一致し、末尾の改行の
 * 追加や削除も空行 1 行の差分として見える。`"\r"` は行の内容の一部として比べる。
 */
export function diffLines(before: string, after: string): LineDiff[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");

  const runs = diffTokens(oldLines, newLines);

  const result: LineDiff[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let pendingDelete = 0;
  let pendingInsert = 0;
  const flush = () => {
    for (; pendingDelete > 0; pendingDelete--) {
      result.push({
        kind: "delete",
        text: lineAt(oldLines, oldIndex),
        oldLine: ++oldIndex,
        newLine: null,
      });
    }
    for (; pendingInsert > 0; pendingInsert--) {
      result.push({
        kind: "insert",
        text: lineAt(newLines, newIndex),
        oldLine: null,
        newLine: ++newIndex,
      });
    }
  };
  for (const [kind, count] of runs) {
    if (kind === DELETE) pendingDelete += count;
    else if (kind === INSERT) pendingInsert += count;
    else {
      flush();
      for (let i = 0; i < count; i++) {
        result.push({
          kind: "equal",
          text: lineAt(oldLines, oldIndex),
          oldLine: ++oldIndex,
          newLine: ++newIndex,
        });
      }
    }
  }
  flush();
  return result;
}

// 読み込むだけで作らないのは、`Intl.Segmenter` の無い環境でもこの module の他の関数を使えるようにするため。
let segmenter: Intl.Segmenter | undefined;

export interface WordDiff {
  readonly kind: LineDiffKind;
  readonly text: string;
}

/**
 * 1 行どうしを語の単位で比べる（行を書き換えたときに、どこを変えたかを示すため）。
 * 語の区切りは `Intl.Segmenter` の word 単位に従い、空白や記号も 1 つの区間として比べる。
 * 同じ種類の区間は 1 つにまとめ、変更箇所の中では削除を挿入より先に並べる。
 * 変えた語どうしの間の空白は、両側の変更に含める。
 * `kind` が `insert` 以外の区間をつなぐと `before` に、`delete` 以外をつなぐと `after` に戻る。
 * `Intl.Segmenter` の無い環境では throw するので、有無は呼ぶ側で確かめる。
 */
export function diffWords(before: string, after: string): WordDiff[] {
  segmenter ??= new Intl.Segmenter("ja", { granularity: "word" });
  const words = segmenter;
  const split = (text: string) => Array.from(words.segment(text), (part) => part.segment);
  const oldWords = split(before);
  const newWords = split(after);
  const runs = diffTokens(oldWords, newWords);

  const result: { kind: LineDiffKind; text: string }[] = [];
  const push = (kind: LineDiffKind, text: string) => {
    if (text === "") return;
    const last = result.at(-1);
    if (last !== undefined && last.kind === kind) last.text += text;
    else result.push({ kind, text });
  };
  let oldIndex = 0;
  let newIndex = 0;
  let pendingDelete = "";
  let pendingInsert = "";
  const flush = () => {
    push("delete", pendingDelete);
    push("insert", pendingInsert);
    pendingDelete = "";
    pendingInsert = "";
  };
  runs.forEach(([kind, count], index) => {
    if (kind === DELETE) {
      pendingDelete += oldWords.slice(oldIndex, oldIndex + count).join("");
      oldIndex += count;
    } else if (kind === INSERT) {
      pendingInsert += newWords.slice(newIndex, newIndex + count).join("");
      newIndex += count;
    } else {
      const text = oldWords.slice(oldIndex, oldIndex + count).join("");
      oldIndex += count;
      newIndex += count;
      // 変えた語に挟まれた空白だけを残すと、続けて書き換えた語句が語ごとの細切れに見える。
      const between = pendingDelete !== "" || pendingInsert !== "";
      if (between && index < runs.length - 1 && /^\s+$/.test(text)) {
        pendingDelete += text;
        pendingInsert += text;
        return;
      }
      flush();
      push("equal", text);
    }
  });
  flush();
  return result;
}

/** 列を整数に置き換えておくと、探索中の比較が要素の長さに依存しなくなる。 */
function diffTokens(before: readonly string[], after: readonly string[]): Run[] {
  const ids = new Map<string, number>();
  const intern = (tokens: readonly string[]) =>
    Int32Array.from(tokens, (token) => {
      let id = ids.get(token);
      if (id === undefined) {
        id = ids.size;
        ids.set(token, id);
      }
      return id;
    });
  const runs: Run[] = [];
  diffRange(intern(before), intern(after), runs);
  return runs;
}

function lineAt(lines: readonly string[], index: number): string {
  const line = lines[index];
  if (line === undefined) throw new Error(`diff の行番号が範囲外: ${index}`);
  return line;
}

function pushRun(runs: Run[], kind: RunKind, count: number): void {
  if (count === 0) return;
  const last = runs.at(-1);
  if (last !== undefined && last[0] === kind) last[1] += count;
  else runs.push([kind, count]);
}

function diffRange(a: Int32Array, b: Int32Array, runs: Run[]): void {
  const common = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < common && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < common - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix++;
  }

  pushRun(runs, EQUAL, prefix);
  const middleA = a.subarray(prefix, a.length - suffix);
  const middleB = b.subarray(prefix, b.length - suffix);
  if (middleA.length === 0) pushRun(runs, INSERT, middleB.length);
  else if (middleB.length === 0) pushRun(runs, DELETE, middleA.length);
  else diffMiddle(middleA, middleB, runs);
  pushRun(runs, EQUAL, suffix);
}

/**
 * 片側にしか現れない行は必ず delete か insert になり、最長共通部分列には入らない。
 * それを除いた列で探索してから、除いた行を一致した行の間へ戻す。
 * Myers の探索は O((N+M)·D) なので、D の大半を占める書き換えた行を先に外すと、
 * 全面的な書き換えでも探索は両側に共通する行だけを相手にすればよくなる。
 */
function diffMiddle(a: Int32Array, b: Int32Array, runs: Run[]): void {
  const keptA = keptIndices(a, new Set(b));
  const keptB = keptIndices(b, new Set(a));
  if (keptA.length === a.length && keptB.length === b.length) {
    bisect(a, b, runs);
    return;
  }

  const reduced: Run[] = [];
  diffRange(pick(a, keptA), pick(b, keptB), reduced);
  let nextA = 0;
  let nextB = 0;
  let keptIndexA = 0;
  let keptIndexB = 0;
  for (const [kind, count] of reduced) {
    if (kind === DELETE) keptIndexA += count;
    else if (kind === INSERT) keptIndexB += count;
    else {
      for (let i = 0; i < count; i++) {
        const matchA = at(keptA, keptIndexA++);
        const matchB = at(keptB, keptIndexB++);
        pushRun(runs, DELETE, matchA - nextA);
        pushRun(runs, INSERT, matchB - nextB);
        pushRun(runs, EQUAL, 1);
        nextA = matchA + 1;
        nextB = matchB + 1;
      }
    }
  }
  pushRun(runs, DELETE, a.length - nextA);
  pushRun(runs, INSERT, b.length - nextB);
}

function keptIndices(lines: Int32Array, other: ReadonlySet<number>): Int32Array {
  const kept: number[] = [];
  lines.forEach((id, index) => {
    if (other.has(id)) kept.push(index);
  });
  return Int32Array.from(kept);
}

function pick(lines: Int32Array, indices: Int32Array): Int32Array {
  return indices.map((index) => at(lines, index));
}

/**
 * Myers の O(ND) 探索を前後の両端から進め、2 つの経路が重なった点（middle snake）で分割して
 * 再帰する線形空間の版（diff-match-patch の `diff_bisect_` と同じ構成）。
 * 経路の履歴を全部保持する素朴な版は O(D²) の memory を使い、長いページを全面的に書き換えた
 * revision 同士で破綻するため採らない。
 */
function bisect(a: Int32Array, b: Int32Array, runs: Run[]): void {
  const n = a.length;
  const m = b.length;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD;
  // 書き込むのは offset ± d（d < maxD）と初期化の offset + 1 だけで、2 * maxD で足りるのは
  // maxD ≥ 2 のとき。n + m = 2 でも初期化が収まるよう余分に取る。
  const size = 2 * maxD + 2;
  const forward = new Int32Array(size).fill(-1);
  const reverse = new Int32Array(size).fill(-1);
  forward[offset + 1] = 0;
  reverse[offset + 1] = 0;
  const delta = n - m;
  // n + m が奇数なら前向きの経路が、偶数なら後ろ向きの経路が先に重なる。
  const checkOnForward = delta % 2 !== 0;
  let forwardStart = 0;
  let forwardEnd = 0;
  let reverseStart = 0;
  let reverseEnd = 0;

  for (let d = 0; d < maxD; d++) {
    for (let k = -d + forwardStart; k <= d - forwardEnd; k += 2) {
      const index = offset + k;
      let x =
        k === -d || (k !== d && at(forward, index - 1) < at(forward, index + 1))
          ? at(forward, index + 1)
          : at(forward, index - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      forward[index] = x;
      if (x > n) forwardEnd += 2;
      else if (y > m) forwardStart += 2;
      else if (checkOnForward) {
        const reverseIndex = offset + delta - k;
        if (reverseIndex >= 0 && reverseIndex < size && at(reverse, reverseIndex) !== -1) {
          if (x >= n - at(reverse, reverseIndex)) {
            split(a, b, x, y, runs);
            return;
          }
        }
      }
    }

    for (let k = -d + reverseStart; k <= d - reverseEnd; k += 2) {
      const index = offset + k;
      let x =
        k === -d || (k !== d && at(reverse, index - 1) < at(reverse, index + 1))
          ? at(reverse, index + 1)
          : at(reverse, index - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[n - x - 1] === b[m - y - 1]) {
        x++;
        y++;
      }
      reverse[index] = x;
      if (x > n) reverseEnd += 2;
      else if (y > m) reverseStart += 2;
      else if (!checkOnForward) {
        const forwardIndex = offset + delta - k;
        if (forwardIndex >= 0 && forwardIndex < size && at(forward, forwardIndex) !== -1) {
          const forwardX = at(forward, forwardIndex);
          if (forwardX >= n - x) {
            split(a, b, forwardX, offset + forwardX - forwardIndex, runs);
            return;
          }
        }
      }
    }
  }

  // 経路が重ならずに終わるのは、共通する行が 1 つも無い（最長共通部分列が 0）ときだけで、
  // そのとき全削除と全挿入が最短の差分になる。diffMiddle がそういう範囲を先に片付けるので、
  // 今の呼び出し方ではここに来ない。
  pushRun(runs, DELETE, n);
  pushRun(runs, INSERT, m);
}

function split(a: Int32Array, b: Int32Array, x: number, y: number, runs: Run[]): void {
  diffRange(a.subarray(0, x), b.subarray(0, y), runs);
  diffRange(a.subarray(x), b.subarray(y), runs);
}

function at(array: Int32Array, index: number): number {
  const value = array[index];
  if (value === undefined) throw new Error(`diff の探索が範囲外を読んだ: ${index}`);
  return value;
}
