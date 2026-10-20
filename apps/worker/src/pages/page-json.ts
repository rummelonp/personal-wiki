import type { Page } from "./store";

/**
 * `/api/pages/:id` の応答と、public のページの HTML に入れる初回の表示用の JSON の共通の形。
 * 後者は匿名の閲覧者とキャッシュにも出るので、引数の page 以外（principal など）には依存させない。
 * 項目は明示して取り出す。呼び出し元が Page より広い値（抜粋を持つ PageMeta など）を渡しても、
 * 余分な項目が応答や HTML に漏れない。
 */
export function pageJson(page: Page) {
  return {
    id: page.id,
    title: page.title,
    body: page.body,
    visibility: page.visibility,
    version: page.version,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}
