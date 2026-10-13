import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backup, BackupStore } from "./draft-backup";
import { type EditorApi, type EditorDeps, EditorSession, saveStatusOf } from "./editor-session";
import type { ApiResult, Page } from "./pages-api";

const ID = "AAAAAAAAAAAAAAAAAAAAAA";

function page(patch: Partial<Page> = {}): Page {
  return {
    id: ID,
    title: "題",
    body: "本文",
    visibility: "draft",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function memoryBackup(initial?: Backup): BackupStore & { saved: Map<string, Backup> } {
  const saved = new Map<string, Backup>();
  if (initial) saved.set(ID, initial);
  return {
    saved,
    load: (id) => saved.get(id) ?? null,
    save: (id, backup) => void saved.set(id, backup),
    remove: (id) => void saved.delete(id),
  };
}

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });

/** 本物のサーバーのように、保存のたびに版を 1 進める。 */
function fakeApi(server: { page: Page }): EditorApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getPage() {
      calls.push("get");
      return ok(server.page);
    },
    async updatePage(_id, version, input) {
      calls.push(`put@${version}`);
      if (version !== server.page.version) {
        return { ok: false, reason: "version_conflict", currentVersion: server.page.version };
      }
      server.page = { ...server.page, ...input, version: version + 1 };
      return ok(server.page);
    },
    async setVisibility(_id, version, visibility) {
      calls.push(`vis@${version}`);
      if (version !== server.page.version) {
        return { ok: false, reason: "version_conflict", currentVersion: server.page.version };
      }
      server.page = { ...server.page, visibility, version: version + 1 };
      return ok(server.page);
    },
    async deletePage(_id, version) {
      calls.push(`del@${version}`);
      if (version !== server.page.version) {
        return { ok: false, reason: "version_conflict", currentVersion: server.page.version };
      }
      return ok(null);
    },
  };
}

function setup(
  options: {
    server?: Page;
    backup?: BackupStore;
    api?: EditorApi;
    deps?: Partial<EditorDeps>;
  } = {},
) {
  const server = { page: options.server ?? page() };
  const api = (options.api ?? fakeApi(server)) as EditorApi & { calls: string[] };
  const backup = options.backup ?? memoryBackup();
  const session = new EditorSession(server.page, { api, backup, ...options.deps });
  return { server, api, backup, session };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("自動保存の間引き", () => {
  it("入力が続く間は送らず、止まって 2 秒後に 1 回だけ送る", async () => {
    const { session, api, server } = setup();
    session.edit({ title: "題", body: "a" });
    await vi.advanceTimersByTimeAsync(1500);
    session.edit({ title: "題", body: "ab" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.calls).toEqual([]);
    expect(saveStatusOf(session.getState())).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(600);
    expect(api.calls).toEqual(["put@1"]);
    expect(server.page.body).toBe("ab");
    expect(saveStatusOf(session.getState())).toBe("saved");
    expect(session.getState().base.version).toBe(2);
  });

  it("元の内容に戻した入力は送らない", async () => {
    const { session, api } = setup();
    session.edit({ title: "題", body: "a" });
    session.edit({ title: "題", body: "本文" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.calls).toEqual([]);
    expect(saveStatusOf(session.getState())).toBe("saved");
  });

  it("変更が無ければ blur の flush でも送らない", async () => {
    const { session, api } = setup();
    await session.flush();
    expect(api.calls).toEqual([]);
  });

  it("blur の flush は待たずに送り、後からタイマーで二重に送らない", async () => {
    const { session, api } = setup();
    session.edit({ title: "題", body: "a" });
    await session.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.calls).toEqual(["put@1"]);
  });

  it("保存中の入力は次の保存にまわし、版は応答のものを使う", async () => {
    const { session, api, server } = setup();
    session.edit({ title: "題", body: "a" });
    const real = api.updatePage;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.updatePage = async (...args) => {
      await gate;
      return real(...args);
    };
    const saving = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(saveStatusOf(session.getState())).toBe("saving");
    session.edit({ title: "題", body: "ab" });
    release();
    await saving;
    expect(saveStatusOf(session.getState())).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(2100);
    expect(api.calls).toEqual(["put@1", "put@2"]);
    expect(server.page.body).toBe("ab");
  });

  it("保存の失敗は error になり、自動では再送しない。次の入力で再開する", async () => {
    const { session, api, server } = setup();
    api.updatePage = vi.fn(
      async () => ({ ok: false, reason: "error", message: "落ちた" }) as const,
    );
    session.edit({ title: "題", body: "a" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(saveStatusOf(session.getState())).toBe("error");
    expect(session.getState().error).toBe("落ちた");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.updatePage).toHaveBeenCalledTimes(1);
    session.edit({ title: "題", body: "ab" });
    expect(session.getState().error).toBeNull();
    await vi.advanceTimersByTimeAsync(2100);
    expect(api.updatePage).toHaveBeenCalledTimes(2);
    expect(server.page.body).toBe("本文");
  });

  it("title の重複は error として知らせる", async () => {
    const { session, api } = setup();
    api.updatePage = async () => ({ ok: false, reason: "title_conflict", message: "重複" });
    session.edit({ title: "別", body: "本文" });
    await session.flush();
    expect(saveStatusOf(session.getState())).toBe("error");
    expect(session.getState().error).toBe("重複");
  });
});

describe("409 の衝突", () => {
  async function conflicted() {
    const ctx = setup();
    ctx.session.edit({ title: "題", body: "手元" });
    ctx.server.page = { ...ctx.server.page, body: "サーバー", version: 2 };
    await ctx.session.flush();
    return ctx;
  }

  it("サーバーの最新を取り直して conflict にし、手元の内容と自動保存を止める", async () => {
    const { session, api } = await conflicted();
    const state = session.getState();
    expect(saveStatusOf(state)).toBe("conflict");
    expect(state.conflict?.body).toBe("サーバー");
    expect(state.draft.body).toBe("手元");
    expect(api.calls).toEqual(["put@1", "get"]);
    session.edit({ title: "題", body: "さらに" });
    expect(session.getState().draft.body).toBe("手元");
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.calls).toEqual(["put@1", "get"]);
  });

  it("衝突の時点で手元の内容を localStorage に退避する", async () => {
    const { backup } = await conflicted();
    expect(backup.load(ID)).toMatchObject({ body: "手元", baseVersion: 1 });
  });

  it("手元で上書きすると、サーバーの版に重ねて保存する", async () => {
    const { session, api, server, backup } = await conflicted();
    await session.overwrite();
    expect(api.calls.at(-1)).toBe("put@2");
    expect(server.page.body).toBe("手元");
    expect(saveStatusOf(session.getState())).toBe("saved");
    expect(backup.load(ID)).toBeNull();
  });

  it("上書きの最中にまた版が進んだら、再び衝突にする", async () => {
    const { session, server } = await conflicted();
    const original = session.getState().conflict as Page;
    server.page = { ...original, body: "さらに別", version: 3 };
    await session.overwrite();
    expect(saveStatusOf(session.getState())).toBe("conflict");
    expect(session.getState().conflict?.version).toBe(3);
    expect(session.getState().draft.body).toBe("手元");
  });

  it("サーバーの版を取り込むと、手元を捨てて最新の版から再開する", async () => {
    const { session, backup } = await conflicted();
    session.takeServer();
    const state = session.getState();
    expect(state.draft.body).toBe("サーバー");
    expect(state.base.version).toBe(2);
    expect(saveStatusOf(state)).toBe("saved");
    expect(backup.load(ID)).toBeNull();
  });
});

describe("フォーカス復帰", () => {
  const server2 = () => page({ body: "他で更新", version: 2 });

  it("手元に変更が無ければ最新を読み直す", async () => {
    const { session, server } = setup();
    server.page = server2();
    await session.checkFreshness();
    const state = session.getState();
    expect(state.base.version).toBe(2);
    expect(state.draft.body).toBe("他で更新");
    expect(saveStatusOf(state)).toBe("saved");
  });

  it("版が同じなら何もしない", async () => {
    const { session } = setup();
    await session.checkFreshness();
    expect(session.getState().conflict).toBeNull();
  });

  it("未保存の変更があれば衝突として扱い、手元は失わない", async () => {
    const { session, server } = setup();
    session.edit({ title: "題", body: "手元" });
    server.page = server2();
    await session.checkFreshness();
    const state = session.getState();
    expect(saveStatusOf(state)).toBe("conflict");
    expect(state.draft.body).toBe("手元");
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.base.version).toBe(1);
  });

  it("手元の内容がサーバーの最新と同じなら衝突にしない", async () => {
    const { session, server } = setup();
    session.edit({ title: "題", body: "他で更新" });
    server.page = server2();
    await session.checkFreshness();
    expect(saveStatusOf(session.getState())).toBe("saved");
    expect(session.getState().base.version).toBe(2);
  });

  it("続けて来た visibilitychange と focus は 1 回の確認にまとめる", async () => {
    let now = 10_000;
    const { session, api } = setup({ deps: { now: () => now } });
    await session.checkFreshness();
    await session.checkFreshness();
    expect(api.calls).toEqual(["get"]);
    now += 3000;
    await session.checkFreshness();
    expect(api.calls).toEqual(["get", "get"]);
  });

  it("サーバーから消えていたら gone にする", async () => {
    const { session, api } = setup();
    api.getPage = async () => ({ ok: false, reason: "not_found" });
    await session.checkFreshness();
    expect(saveStatusOf(session.getState())).toBe("gone");
  });
});

describe("ログイン切れ", () => {
  it("401 で未保存の内容を退避し、以後は送らない", async () => {
    const { session, api, backup } = setup();
    api.updatePage = vi.fn(async () => ({ ok: false, reason: "unauthorized" }) as const);
    session.edit({ title: "題", body: "手元" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(saveStatusOf(session.getState())).toBe("auth");
    expect(backup.load(ID)).toMatchObject({ body: "手元", baseVersion: 1 });
    session.edit({ title: "題", body: "手元 続き" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.updatePage).toHaveBeenCalledTimes(1);
    expect(backup.load(ID)?.body).toBe("手元 続き");
  });

  it("再試行でログインし直した後の保存が通る", async () => {
    const { session, api, backup } = setup();
    const real = api.updatePage;
    api.updatePage = async () => ({ ok: false, reason: "unauthorized" });
    session.edit({ title: "題", body: "手元" });
    await session.flush();
    expect(saveStatusOf(session.getState())).toBe("auth");
    api.updatePage = real;
    await session.retry();
    expect(saveStatusOf(session.getState())).toBe("saved");
    expect(backup.load(ID)).toBeNull();
  });

  it("戻ったとき、退避分があれば復元を選ばせ、同じ版なら通常の編集に戻す", async () => {
    const backup = memoryBackup({ title: "題", body: "退避", baseVersion: 1, savedAt: 0 });
    const { session, server } = setup({ backup });
    expect(session.getState().pendingBackup?.body).toBe("退避");
    expect(session.getState().draft.body).toBe("本文");
    session.restoreBackup();
    expect(session.getState().draft.body).toBe("退避");
    expect(saveStatusOf(session.getState())).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(2100);
    expect(server.page.body).toBe("退避");
    expect(backup.load(ID)).toBeNull();
  });

  it("退避した後にサーバーが進んでいたら、復元は衝突として差分を見せる", () => {
    const backup = memoryBackup({ title: "題", body: "退避", baseVersion: 1, savedAt: 0 });
    const { session } = setup({ backup, server: page({ body: "他", version: 3 }) });
    session.restoreBackup();
    const state = session.getState();
    expect(saveStatusOf(state)).toBe("conflict");
    expect(state.draft.body).toBe("退避");
    expect(state.conflict?.body).toBe("他");
  });

  it("退避分を破棄できる。サーバーと同じ内容の退避は黙って消す", () => {
    const backup = memoryBackup({ title: "題", body: "退避", baseVersion: 1, savedAt: 0 });
    const a = setup({ backup });
    a.session.discardBackup();
    expect(a.session.getState().pendingBackup).toBeNull();
    expect(backup.load(ID)).toBeNull();

    const same = memoryBackup({ title: "題", body: "本文", baseVersion: 1, savedAt: 0 });
    const b = setup({ backup: same });
    expect(b.session.getState().pendingBackup).toBeNull();
    expect(same.load(ID)).toBeNull();
  });
});

describe("visibility", () => {
  it("未保存の変更を先に保存し、応答の版を以後の保存に使う", async () => {
    const { session, api, server } = setup();
    session.edit({ title: "題", body: "手元" });
    await session.changeVisibility("public");
    expect(api.calls).toEqual(["put@1", "vis@2"]);
    expect(session.getState().base.version).toBe(3);
    expect(session.getState().base.visibility).toBe("public");
    session.edit({ title: "題", body: "手元2" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(api.calls.at(-1)).toBe("put@3");
    expect(server.page.visibility).toBe("public");
  });

  it("未保存の変更を保存できなければ変えない", async () => {
    const { session, api } = setup();
    api.updatePage = async () => ({ ok: false, reason: "error", message: "落ちた" });
    api.setVisibility = vi.fn(api.setVisibility);
    session.edit({ title: "題", body: "手元" });
    await session.changeVisibility("public");
    expect(api.setVisibility).not.toHaveBeenCalled();
  });

  it("版が違えば 409 で衝突にする", async () => {
    const { session, server } = setup();
    server.page = page({ body: "他", version: 2 });
    await session.changeVisibility("public");
    expect(saveStatusOf(session.getState())).toBe("conflict");
  });

  it("If-Match を照合しない Worker でも、他の保存が混ざった応答は衝突にする", async () => {
    const { session, api } = setup();
    api.setVisibility = async () => ok(page({ body: "他", version: 2, visibility: "public" }));
    await session.changeVisibility("public");
    const state = session.getState();
    expect(saveStatusOf(state)).toBe("conflict");
    expect(state.conflict?.body).toBe("他");
  });
});

describe("削除と離脱", () => {
  it("削除は表示中の版を付けて送り、成功すると以後は保存しない", async () => {
    const { session, api } = setup();
    expect(await session.remove()).toBe(true);
    expect(api.calls).toEqual(["del@1"]);
    await session.leave();
    expect(api.calls).toEqual(["del@1"]);
  });

  it("版が違えば削除せず衝突にする", async () => {
    const { session, server } = setup();
    server.page = page({ version: 2 });
    expect(await session.remove()).toBe(false);
    expect(saveStatusOf(session.getState())).toBe("conflict");
  });

  it("離脱時は未保存の内容を退避し、keepalive で保存する", async () => {
    const { session, api, backup } = setup();
    const put = vi.fn(api.updatePage);
    api.updatePage = put;
    session.edit({ title: "題", body: "手元" });
    const leaving = session.leave();
    expect(backup.load(ID)?.body).toBe("手元");
    await leaving;
    expect(put).toHaveBeenCalledWith(ID, 1, { title: "題", body: "手元" }, { keepalive: true });
    expect(backup.load(ID)).toBeNull();
  });

  it("変更が無い離脱では何も送らない", async () => {
    const { session, api } = setup();
    await session.leave();
    expect(api.calls).toEqual([]);
  });
});
