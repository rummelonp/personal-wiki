import { describe, expect, it } from "vitest";
import { createLocalBackupStore } from "./draft-backup";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

const ID = "page-1";
const KEY = `personal-wiki:draft:${ID}`;
const OLD = { title: "題", body: "本文", baseVersion: 1, savedAt: 0 };

describe("createLocalBackupStore", () => {
  it("base の欄が無い古い退避も読む", () => {
    const storage = memoryStorage();
    storage.setItem(KEY, JSON.stringify(OLD));
    expect(createLocalBackupStore(() => storage).load(ID)).toEqual(OLD);
  });

  it("base の欄を含めて書いたものを読み戻す", () => {
    const storage = memoryStorage();
    const store = createLocalBackupStore(() => storage);
    const backup = { ...OLD, baseTitle: "題", baseBody: "前の本文" };
    store.save(ID, backup);
    expect(store.load(ID)).toEqual(backup);
  });

  it.each([
    ["baseTitle", { baseTitle: 1 }],
    ["baseBody", { baseBody: null }],
  ])("%s が文字列でない退避は読まない", (_, extra) => {
    const storage = memoryStorage();
    storage.setItem(KEY, JSON.stringify({ ...OLD, ...extra }));
    expect(createLocalBackupStore(() => storage).load(ID)).toBeNull();
  });
});
