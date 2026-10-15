export interface Backup {
  title: string;
  body: string;
  /** 退避した時点で手元が前提にしていたサーバーの版 */
  baseVersion: number;
  /**
   * 退避した時点の base の title と本文。サーバーが先へ進んでいたとき、手元の編集との差分が
   * リンクの書き換えだけかを調べるのに使う。この欄を足す前の退避には無い（その場合は衝突として扱う）。
   */
  baseTitle?: string;
  baseBody?: string;
  savedAt: number;
  /** まだ作っていないページの退避で、作成を試みて失敗した内容。復元の案内の文言を変える。 */
  createFailed?: boolean;
  /**
   * 退避を書いたセッションの乱数。同じページの退避は key を共有するので、別のタブの退避を上書きしたり
   * 消したりしないための持ち主の目印。この欄を足す前の退避には無く、その持ち主は誰でもない。
   */
  owner?: string;
  /**
   * サーバーから消えたページの id。そのページの退避を、新規作成の画面で新しいページとして復元できるよう、
   * 作る前の退避の key に移したもの。復元の案内の文言を変える。
   */
  deletedFrom?: string;
}

export interface BackupStore {
  load(pageId: string): Backup | null;
  /** 書けたら true。容量超過や private window では false になり、退避は残らない。 */
  save(pageId: string, backup: Backup): boolean;
  remove(pageId: string): void;
  /** prefix で始まる key（load に渡す形）の一覧。 */
  list(prefix: string): string[];
}

const KEY_PREFIX = "personal-wiki:draft:";
const keyOf = (pageId: string) => `${KEY_PREFIX}${pageId}`;

/** localStorage の key（storage イベントの key）が退避のものか。 */
export const isBackupStorageKey = (key: string): boolean => key.startsWith(KEY_PREFIX);

function isBackup(value: unknown): value is Backup {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.title === "string" &&
    typeof v.body === "string" &&
    typeof v.baseVersion === "number" &&
    typeof v.savedAt === "number" &&
    (v.baseTitle === undefined || typeof v.baseTitle === "string") &&
    (v.baseBody === undefined || typeof v.baseBody === "string") &&
    (v.createFailed === undefined || typeof v.createFailed === "boolean") &&
    (v.owner === undefined || typeof v.owner === "string") &&
    (v.deletedFrom === undefined || typeof v.deletedFrom === "string")
  );
}

/**
 * ログイン切れや離脱で保存できなかった内容の退避先。localStorage は private window や容量超過で
 * 読み書きに失敗するので、どの操作も失敗を握りつぶす（退避は救済であり、画面の動作を止めない）。
 */
export function createLocalBackupStore(storage: () => Storage = () => localStorage): BackupStore {
  return {
    load(pageId) {
      try {
        const raw = storage().getItem(keyOf(pageId));
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        return isBackup(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    save(pageId, backup) {
      try {
        storage().setItem(keyOf(pageId), JSON.stringify(backup));
        return true;
      } catch {
        // 退避できなくても編集は続けられる。書けなかったことは戻り値で知らせる
        return false;
      }
    },
    remove(pageId) {
      try {
        storage().removeItem(keyOf(pageId));
      } catch {
        // 同上
      }
    },
    list(prefix) {
      try {
        const store = storage();
        const found: string[] = [];
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (key?.startsWith(keyOf(prefix))) found.push(key.slice(KEY_PREFIX.length));
        }
        return found;
      } catch {
        return [];
      }
    },
  };
}
