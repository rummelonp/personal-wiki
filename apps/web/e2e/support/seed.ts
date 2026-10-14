import type { OwnerApi } from "./api";

/*
 * E2E と一覧シートが前提にするページ。テストはここの title で引くので、変えるときはテストも直す。
 * 実行のたびに空の D1 に入れ直すので、テストが書き換えるページはテストの中で別に作る。
 */

/** 匿名の検索とリンクで漏れていないかを見る、draft だけに書く語。 */
export const DRAFT_MARKER = "zqxsecret";

export const SEED = {
  welcome: "ようこそ",
  server: "サーバーのメモ",
  database: "データベースの制限",
  book: "読書メモ/読みやすいコード",
  todo: "TODO",
  diary: "日記/2026-10-14",
  longTitle:
    "長いタイトルのページ：一覧やヘッダーでどう折り返されるかを確かめるための、とても長いタイトル",
  english: "English note about keyboard shortcuts",
  manyTags: "タグが多いページ",
  longPage: "見出しが多い長いページ",
  draftSecret: `下書きの秘密メモ ${DRAFT_MARKER}`,
  empty: "空のページ",
} as const;

/** タグが多いページのタグ。長さの違うものを混ぜ、折り返しを確かめる。 */
export const MANY_TAGS = Array.from({ length: 32 }, (_, i) =>
  i % 5 === 0 ? `とても長いタグの名前-${i + 1}` : `tag${String(i + 1).padStart(2, "0")}`,
);

/** 見出しが 40 個、本文が 1 万字ほどのページ。速さの計測と見出しへの移動に使う。 */
export function longPageBody(): string {
  const sections: string[] = [];
  for (let i = 1; i <= 40; i++) {
    const paragraph =
      `${i} 番目の節の本文。長いページで打鍵から表示までの時間を測るため、` +
      "日本語と English の文を混ぜて段落を長くしている。".repeat(4) +
      `[[${SEED.welcome}]] へのリンクと #長文 のタグも入れる。`;
    sections.push(`## 見出し ${i}\n\n${paragraph}\n\n- 箇条書き ${i}-1\n- 箇条書き ${i}-2`);
  }
  return sections.join("\n\n");
}

interface SeedPage {
  title: string;
  visibility: "draft" | "public";
  body: string;
}

function seedPages(): SeedPage[] {
  const pages: SeedPage[] = [
    {
      title: SEED.welcome,
      visibility: "public",
      body: `この wiki は個人用のメモ置き場です。

## よく見るページ

- [[${SEED.server}]]
- [[${SEED.book}]]
- [[${SEED.database}]]

## 書き方

\`[[ページ名]]\` でリンク、\`#タグ\` でタグを付けます。

> 引用はこう表示されます。

#メモ #使い方`,
    },
    {
      title: SEED.server,
      visibility: "public",
      body: `---
tags: [server]
---

# サーバーのメモ

無料枠の上限を超えると課金ではなくエラーになる。

\`\`\`ts
app.get("/api/healthz", (c) => c.json({ status: "ok" }));
\`\`\`

関連: [[${SEED.database}]]

#server #メモ`,
    },
    {
      title: SEED.database,
      visibility: "public",
      body: `| 項目 | 上限 |
| --- | --- |
| 読み取り行数 | 500 万行/日 |
| 書き込み行数 | 10 万行/日 |

#database`,
    },
    {
      title: SEED.book,
      visibility: "public",
      body: `## 1 章

- コードは他の人が最短時間で理解できるように書く

**大事**: 名前は短いコメントだと思う。*斜体* と ~~取り消し~~ も試す。

#読書`,
    },
    {
      title: SEED.todo,
      visibility: "draft",
      body: `- [x] migration を流す
- [ ] バックアップを取る
- [ ] [[${SEED.book}]] の続きを読む

#todo`,
    },
    {
      title: SEED.diary,
      visibility: "draft",
      body: `朝から作業。長い段落がどう折り返されるか、狭い幅でも読みやすいかを確かめるために、この段落はわざと長めに書いている。日本語の文章は句読点の位置で折り返されないので、行末が揃わないことがある。

[[${SEED.todo}]] を更新した。

#日記`,
    },
    {
      title: SEED.longTitle,
      visibility: "public",
      body: "タイトルが長いときの表示を確かめる。\n\n#テスト",
    },
    {
      title: SEED.english,
      visibility: "public",
      body: `# Keyboard shortcuts

- \`Cmd+K\`: search

The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.

#english`,
    },
    {
      title: SEED.manyTags,
      visibility: "public",
      body: `タグが多いときの表示を確かめる。\n\n${MANY_TAGS.map((tag) => `#${tag}`).join(" ")}`,
    },
    { title: SEED.longPage, visibility: "public", body: longPageBody() },
    {
      // 匿名には title、一覧、検索、backlink のどこにも出てはいけない
      title: SEED.draftSecret,
      visibility: "draft",
      body: `この本文の ${DRAFT_MARKER} は匿名の検索に出てはいけない。[[${SEED.welcome}]] と [[${SEED.database}]] にリンクする。

#${DRAFT_MARKER}`,
    },
    { title: SEED.empty, visibility: "draft", body: "" },
  ];
  for (let i = 1; i <= 24; i++) {
    pages.push({
      title: `メモ ${String(i).padStart(2, "0")}`,
      visibility: i % 3 === 0 ? "public" : "draft",
      body: `短いメモの ${i} 番目。${i % 4 === 0 ? `[[${SEED.welcome}]] に戻る。` : ""}\n\n#メモ${i % 5 === 0 ? " #まとめ" : ""}`,
    });
  }
  return pages;
}

/** title から id への対応を返す。 */
export async function seed(api: OwnerApi): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  // 一覧の並び（更新の新しい順）を毎回同じにするため、並列にせず順に入れる
  for (const page of seedPages()) {
    const created = await api.createPage(page);
    ids[page.title] = created.id;
  }
  return ids;
}
