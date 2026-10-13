export interface Backup {
  title: string;
  body: string;
  /** 退避した時点で手元が前提にしていたサーバーの版 */
  baseVersion: number;
  savedAt: number;
}

export interface BackupStore {
  load(pageId: string): Backup | null;
  save(pageId: string, backup: Backup): void;
  remove(pageId: string): void;
}

const keyOf = (pageId: string) => `personal-wiki:draft:${pageId}`;

function isBackup(value: unknown): value is Backup {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.title === "string" &&
    typeof v.body === "string" &&
    typeof v.baseVersion === "number" &&
    typeof v.savedAt === "number"
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
      } catch {
        // 退避できなくても編集は続けられる
      }
    },
    remove(pageId) {
      try {
        storage().removeItem(keyOf(pageId));
      } catch {
        // 同上
      }
    },
  };
}
