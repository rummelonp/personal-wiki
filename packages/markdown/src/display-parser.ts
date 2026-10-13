import { parser, Strikethrough, Table } from "@lezer/markdown";
import { BlockId } from "./block-id";
import { ObsidianComment } from "./comment";
import { Frontmatter } from "./frontmatter";
import { Highlight } from "./highlight";
import { ObsidianTaskList } from "./task-list";
import { WikiLink } from "./wikilink";

// Editor（lang-markdown の GFM 入り）が描く構造に合わせる。抽出系の parser（wikilink.ts）が
// GFM Table を外す理由は派生データ（links など）の結果を変えないためで、表示にしか使わないここには当たらない。
// Tag は入れない。`#tag` は記法ではなく本文の語として扱う。
const BODY_EXTENSIONS = [
  ObsidianComment,
  WikiLink,
  BlockId,
  Highlight,
  Strikethrough,
  Table,
  ObsidianTaskList,
];

/** 本文を人に見せる形へ変えるときの parser。本文の先頭から読む。 */
export const displayParser = parser.configure([Frontmatter, ...BODY_EXTENSIONS]);

/** 本文の途中から切り出した断片用。断片の先頭が `---` の行でも、それは frontmatter ではない。 */
export const fragmentDisplayParser = parser.configure(BODY_EXTENSIONS);
