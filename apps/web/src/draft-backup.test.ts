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
    ["createFailed", { createFailed: "yes" }],
    ["owner", { owner: 1 }],
    ["deletedFrom", { deletedFrom: true }],
  ])("%s の型が違う退避は読まない", (_, extra) => {
    const storage = memoryStorage();
    storage.setItem(KEY, JSON.stringify({ ...OLD, ...extra }));
    expect(createLocalBackupStore(() => storage).load(ID)).toBeNull();
  });

  it("持ち主の目印を含めて書いたものを読み戻し、欄の無い退避も読む", () => {
    const storage = memoryStorage();
    const store = createLocalBackupStore(() => storage);
    store.save(ID, { ...OLD, owner: "abc" });
    expect(store.load(ID)?.owner).toBe("abc");
    storage.setItem(KEY, JSON.stringify(OLD));
    expect(store.load(ID)?.owner).toBeUndefined();
  });

  it("持ち主の目印を足しても、欄を増やす前の版の判定（必須の欄だけ）を満たす", () => {
    const storage = memoryStorage();
    createLocalBackupStore(() => storage).save(ID, { ...OLD, owner: "abc" });
    const value = JSON.parse(storage.getItem(KEY) ?? "null");
    expect(typeof value.title).toBe("string");
    expect(typeof value.body).toBe("string");
    expect(typeof value.baseVersion).toBe("number");
    expect(typeof value.savedAt).toBe("number");
  });

  it("prefix で始まる退避の key を、load に渡す形で返す", () => {
    const storage = memoryStorage();
    const store = createLocalBackupStore(() => storage);
    store.save("new:a", OLD);
    store.save("new:b", OLD);
    store.save(ID, OLD);
    storage.setItem("other:new:c", "{}");
    expect(store.list("new:").sort()).toEqual(["new:a", "new:b"]);
  });
});
