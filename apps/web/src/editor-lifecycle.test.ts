import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backup, BackupStore } from "./draft-backup";
import {
  bindLifecycle,
  registerEditor,
  SAVE_ALL_TIMEOUT_MS,
  saveAllEditors,
  type VisibilitySource,
} from "./editor-lifecycle";
import { type EditorApi, EditorSession } from "./editor-session";
import type { ApiResult, Page } from "./pages-api";

const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const BASE: Page = {
  id: ID,
  title: "題",
  body: "本文",
  visibility: "draft",
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });

function memoryBackup(): BackupStore & { saved: Map<string, Backup> } {
  const saved = new Map<string, Backup>();
  return {
    saved,
    load: (id) => saved.get(id) ?? null,
    save: (id, backup) => {
      saved.set(id, backup);
      return true;
    },
    remove: (id) => void saved.delete(id),
    list: (prefix) => [...saved.keys()].filter((key) => key.startsWith(prefix)),
  };
}

function setup(updatePage?: EditorApi["updatePage"]) {
  const backup = memoryBackup();
  const put = vi.fn<EditorApi["updatePage"]>(
    updatePage ?? (async (_id, version, input) => ok({ ...BASE, ...input, version: version + 1 })),
  );
  const api: EditorApi = {
    createPage: async () => ok(BASE),
    getPage: async () => ok(BASE),
    updatePage: put,
    setVisibility: async () => ok(BASE),
    deletePage: async () => ok(null),
    restoreRevision: async () => ok(BASE),
  };
  const session = new EditorSession(BASE, { api, backup });
  return { session, backup, put };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("bindLifecycle", () => {
  function targets() {
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible",
    }) as VisibilitySource & { visibilityState: string };
    return { doc, win: new EventTarget() };
  }

  it("hidden になったら退避してから keepalive で保存する", async () => {
    const { session, backup, put } = setup();
    const { doc, win } = targets();
    bindLifecycle(session, doc, win);
    session.edit({ title: "題", body: "手元" });
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(backup.load(ID)?.body).toBe("手元");
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledWith(ID, 1, { title: "題", body: "手元" }, { keepalive: true });
    expect(backup.load(ID)).toBeNull();
  });

  it("visible に戻ったら最新を確認する", async () => {
    const { session } = setup();
    const { doc, win } = targets();
    const check = vi.spyOn(session, "checkFreshness");
    bindLifecycle(session, doc, win);
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("focus"));
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("pagehide で退避して保存し、未保存があれば beforeunload で離脱を止める", async () => {
    const { session, backup } = setup();
    const { doc, win } = targets();
    bindLifecycle(session, doc, win);
    const clean = new Event("beforeunload", { cancelable: true });
    win.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    session.edit({ title: "題", body: "手元" });
    const dirty = new Event("beforeunload", { cancelable: true });
    win.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    win.dispatchEvent(new Event("pagehide"));
    expect(backup.load(ID)?.body).toBe("手元");
  });

  it("別のタブが退避の key を書き換えたら、セッションに退避を確かめさせる", () => {
    const { session } = setup();
    const { doc, win } = targets();
    const changed = vi.spyOn(session, "backupsChanged");
    bindLifecycle(session, doc, win);
    const storage = (key: string | null) => Object.assign(new Event("storage"), { key });
    win.dispatchEvent(storage("theme"));
    expect(changed).not.toHaveBeenCalled();
    win.dispatchEvent(storage(`personal-wiki:draft:${ID}`));
    win.dispatchEvent(storage(null));
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("解いた後はイベントに反応しない", () => {
    const { session, backup } = setup();
    const { doc, win } = targets();
    const unbind = bindLifecycle(session, doc, win);
    unbind();
    session.edit({ title: "題", body: "手元" });
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("pagehide"));
    expect(backup.load(ID)).toBeNull();
  });
});

describe("saveAllEditors", () => {
  it("開いている全部の編集画面の保存を待つ。外した画面は待たない", async () => {
    const a = setup();
    const b = setup();
    const gone = setup();
    const unregisters = [a, b, gone].map(({ session }) => registerEditor(session));
    unregisters[2]?.();
    a.session.edit({ title: "題", body: "a" });
    b.session.edit({ title: "題", body: "b" });
    gone.session.edit({ title: "題", body: "c" });
    await saveAllEditors();
    expect(a.put).toHaveBeenCalledTimes(1);
    expect(b.put).toHaveBeenCalledTimes(1);
    expect(gone.put).not.toHaveBeenCalled();
    expect(a.session.getState().base.version).toBe(2);
    unregisters[0]?.();
    unregisters[1]?.();
  });

  it("打っている途中の title は blur を待たず確定して送る", async () => {
    const a = setup();
    const unregister = registerEditor(a.session);
    a.session.editTitle("新題");
    await saveAllEditors();
    expect(a.put).toHaveBeenCalledWith(ID, 1, { title: "新題", body: "本文" }, {});
    expect(a.session.getState()).toMatchObject({ titleInput: null, base: { title: "新題" } });
    unregister();
  });

  it("保存に失敗しても完了し、離脱時の退避は残る", async () => {
    const failing = setup(async () => ({ ok: false, reason: "error", message: "落ちた" }));
    const unregister = registerEditor(failing.session);
    failing.session.edit({ title: "題", body: "手元" });
    await saveAllEditors();
    expect(failing.put).toHaveBeenCalledTimes(1);
    // ログアウト後の画面の取り外しで呼ばれる leave() が退避し、失敗した保存が退避を消さない
    await failing.session.leave();
    expect(failing.backup.load(ID)?.body).toBe("手元");
    unregister();
  });

  it("応答が遅くても、タイムアウトで先へ進む", async () => {
    const stuck = setup(() => new Promise(() => {}));
    const unregister = registerEditor(stuck.session);
    stuck.session.edit({ title: "題", body: "手元" });
    let done = false;
    const all = saveAllEditors().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(SAVE_ALL_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await all;
    expect(done).toBe(true);
    unregister();
  });
});
