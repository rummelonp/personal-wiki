import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backup, BackupStore } from "./draft-backup";
import {
  type Draft,
  type EditorApi,
  type EditorDeps,
  EditorSession,
  isReadOnly,
  NEW_PAGE_BACKUP_PREFIX,
  saveStatusOf,
} from "./editor-session";
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
    list: (prefix) => [...saved.keys()].filter((key) => key.startsWith(prefix)),
  };
}

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });

/** 本物のサーバーのように、保存のたびに版を 1 進める。 */
function fakeApi(server: { page: Page }): EditorApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async createPage(input) {
      calls.push("create");
      server.page = { ...page(), ...input, version: 1 };
      return ok(server.page);
    },
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

  it("別の場所で同じ内容が保存済みなら、衝突にせず版だけ進める", async () => {
    const { session, server, backup } = setup();
    session.edit({ title: "題", body: "同じ" });
    server.page = { ...server.page, body: "同じ", version: 2 };
    await session.flush();
    const state = session.getState();
    expect(state.conflict).toBeNull();
    expect(state.base.version).toBe(2);
    expect(saveStatusOf(state)).toBe("saved");
    expect(backup.load(ID)).toBeNull();
  });

  it("最新を取り直す間に打った入力は、偽の衝突にせず新しい版へ自動保存する", async () => {
    const { session, api, server, backup } = setup();
    session.edit({ title: "題", body: "同じ" });
    server.page = { ...server.page, body: "同じ", version: 2 };
    const real = api.getPage;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.getPage = async (id) => {
      await gate;
      return real(id);
    };
    const flushing = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    session.edit({ title: "題", body: "同じ 続き" });
    release();
    await flushing;
    const state = session.getState();
    expect(state.conflict).toBeNull();
    expect(state.base.version).toBe(2);
    expect(saveStatusOf(state)).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(2100);
    expect(api.calls.at(-1)).toBe("put@2");
    expect(server.page.body).toBe("同じ 続き");
    expect(backup.load(ID)).toBeNull();
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

describe("externalBases", () => {
  it("自分の保存では増えず、サーバーの版の取り込みと衝突の解決で増える", async () => {
    const { session, server } = setup();
    session.edit({ title: "題", body: "手元" });
    await session.flush();
    expect(session.getState().base.version).toBe(2);
    expect(session.getState().externalBases).toBe(0);

    server.page = { ...server.page, body: "他で更新", version: 3 };
    session.edit({ title: "題", body: "さらに手元" });
    await session.flush();
    expect(session.getState().conflict).not.toBeNull();
    session.takeServer();
    expect(session.getState().externalBases).toBe(1);
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
    session.edit({ title: "題", body: "手元 続き 続き" });
    expect(backup.load(ID)?.body).toBe("手元");
    await vi.advanceTimersByTimeAsync(1000);
    expect(backup.load(ID)?.body).toBe("手元 続き 続き");
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.updatePage).toHaveBeenCalledTimes(1);
  });

  it("保存が 5xx で失敗しても、未保存の内容を退避する", async () => {
    const { session, api, backup } = setup();
    api.updatePage = vi.fn(
      async () => ({ ok: false, reason: "error", message: "サーバーで問題が起きました" }) as const,
    );
    session.edit({ title: "題", body: "手元" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(saveStatusOf(session.getState())).toBe("error");
    expect(backup.load(ID)).toMatchObject({ body: "手元", baseVersion: 1 });

    // 保存できたら退避を消す。残ると、次に開いたとき保存済みの内容を復元するか尋ねてしまう
    api.updatePage = fakeApi({ page: page() }).updatePage;
    await session.retry();
    expect(saveStatusOf(session.getState())).toBe("saved");
    expect(backup.load(ID)).toBeNull();
  });

  it("ログイン切れの間の入力は、離脱すれば待たずに退避する", async () => {
    const { session, api, backup } = setup();
    api.updatePage = async () => ({ ok: false, reason: "unauthorized" });
    session.edit({ title: "題", body: "手元" });
    await session.flush();
    session.edit({ title: "題", body: "手元 続き" });
    await session.leave();
    expect(backup.load(ID)?.body).toBe("手元 続き");
  });

  it("フォーカス復帰で 401 を受けても、未保存が無ければ何も退避しない", async () => {
    const { session, api, backup } = setup();
    api.getPage = async () => ({ ok: false, reason: "unauthorized" });
    await session.checkFreshness();
    expect(saveStatusOf(session.getState())).toBe("auth");
    expect(backup.load(ID)).toBeNull();
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

  describe("サーバーがリンクの書き換えで進んでいた退避", () => {
    const base = () => page({ body: "[[旧]] 本文" });

    /** タブを閉じて送り直しが成立しなかったことにする。退避だけが古い版のまま残る */
    async function closedWithUnsaved(edit: Draft, from: Page = base()) {
      const first = setup({ server: from });
      first.api.updatePage = async () => ({ ok: false, reason: "error", message: "通信の失敗" });
      first.session.edit(edit);
      await first.session.leave();
      return first.backup;
    }

    it("退避には、その時点の base の title と本文を残す", async () => {
      const backup = await closedWithUnsaved({ title: "新題", body: "[[旧]] 本文 追記" });
      expect(backup.load(ID)).toEqual({
        title: "新題",
        body: "[[旧]] 本文 追記",
        baseVersion: 1,
        baseTitle: "題",
        baseBody: "[[旧]] 本文",
        savedAt: expect.any(Number),
      });
    });

    it("title が変わらず差分が書き換えだけなら、衝突にせず退避の編集を重ねて保存する", async () => {
      const backup = await closedWithUnsaved({ title: "新題", body: "[[旧]] 本文 追記" });
      const { session, server, api } = setup({
        backup,
        server: page({ body: "[[新]] 本文", version: 3 }),
      });
      session.restoreBackup();
      expect(session.getState()).toMatchObject({
        conflict: null,
        pendingBackup: null,
        draft: { title: "新題", body: "[[新]] 本文 追記" },
      });
      await vi.advanceTimersByTimeAsync(2100);
      expect(api.calls).toEqual(["put@3"]);
      expect(server.page).toMatchObject({ title: "新題", body: "[[新]] 本文 追記" });
      expect(backup.load(ID)).toBeNull();
    });

    it("離脱の後（dev の StrictMode の mount 直後など）に復元しても、重ねた内容を自動保存する", async () => {
      const backup = await closedWithUnsaved({ title: "題", body: "[[旧]] 本文 追記" });
      const { session, api } = setup({
        backup,
        server: page({ body: "[[新]] 本文", version: 3 }),
      });
      await session.leave();
      session.restoreBackup();
      await vi.advanceTimersByTimeAsync(2100);
      expect(api.calls).toEqual(["put@3"]);
    });

    it("重ねた内容を保存する前に離れても、新しい版に対する退避を残す", async () => {
      const backup = await closedWithUnsaved({ title: "題", body: "[[旧]] 本文 追記" });
      const { session, api } = setup({
        backup,
        server: page({ body: "[[新]] 本文", version: 3 }),
      });
      api.updatePage = async () => ({ ok: false, reason: "error", message: "通信の失敗" });
      session.restoreBackup();
      await session.leave();
      expect(backup.load(ID)).toMatchObject({
        body: "[[新]] 本文 追記",
        baseVersion: 3,
        baseBody: "[[新]] 本文",
      });
    });

    it("手元が title だけの変更なら、サーバーの本文を取り込んで title を残す", async () => {
      const backup = await closedWithUnsaved({ title: "新題", body: "[[旧]] 本文" });
      const { session } = setup({ backup, server: page({ body: "他の編集", version: 3 }) });
      session.restoreBackup();
      expect(session.getState()).toMatchObject({
        conflict: null,
        draft: { title: "新題", body: "他の編集" },
      });
    });

    it("本文が変わらず版だけ進んでいた（公開設定の変更など）なら、衝突にしない", async () => {
      const backup = await closedWithUnsaved({ title: "題", body: "[[旧]] 本文 追記" });
      const { session } = setup({
        backup,
        server: page({ body: "[[旧]] 本文", visibility: "public", version: 3 }),
      });
      session.restoreBackup();
      expect(session.getState()).toMatchObject({
        conflict: null,
        draft: { body: "[[旧]] 本文 追記" },
      });
    });

    it("書き換え以外の変更が混ざっていれば、衝突にする", async () => {
      const backup = await closedWithUnsaved({ title: "題", body: "[[旧]] 本文 追記" });
      const { session } = setup({ backup, server: page({ body: "[[新]] 他の編集", version: 3 }) });
      session.restoreBackup();
      expect(session.getState().conflict).toMatchObject({ body: "[[新]] 他の編集" });
      expect(session.getState().draft.body).toBe("[[旧]] 本文 追記");
    });

    it("サーバーの title が退避の base と違えば、本文が書き換えだけでも衝突にする", async () => {
      const backup = await closedWithUnsaved({ title: "新題", body: "[[旧]] 本文 追記" });
      const { session } = setup({
        backup,
        server: page({ title: "別題", body: "[[新]] 本文", version: 3 }),
      });
      session.restoreBackup();
      expect(session.getState().conflict).toMatchObject({ title: "別題" });
      expect(session.getState().draft).toEqual({ title: "新題", body: "[[旧]] 本文 追記" });
    });

    describe("離脱の保存が成立したあとに step が書き換えた退避", () => {
      const self = () => page({ body: "[[題]] 本文" });

      it("title を変えて閉じ、自分への [[旧 title]] が書き換わっていれば、保存済みとして黙って消す", async () => {
        const backup = await closedWithUnsaved({ title: "新題", body: "[[題]] 本文 追記" }, self());
        const { session } = setup({
          backup,
          server: page({ title: "新題", body: "[[新題]] 本文 追記", version: 3 }),
        });
        expect(session.getState()).toMatchObject({ pendingBackup: null, conflict: null });
        expect(backup.load(ID)).toBeNull();
      });

      it("title だけを変えて閉じた場合も、保存済みとして消す", async () => {
        const backup = await closedWithUnsaved({ title: "新題", body: "[[題]] 本文" }, self());
        const { session } = setup({
          backup,
          server: page({ title: "新題", body: "[[新題]] 本文", version: 3 }),
        });
        expect(session.getState().pendingBackup).toBeNull();
        expect(backup.load(ID)).toBeNull();
      });

      it("title が保存されていても、本文に書き換え以外の差があれば未決のまま残す", async () => {
        const backup = await closedWithUnsaved({ title: "新題", body: "[[題]] 本文 追記" }, self());
        const { session } = setup({
          backup,
          server: page({ title: "新題", body: "[[新題]] 他の編集", version: 3 }),
        });
        expect(session.getState().pendingBackup).toMatchObject({ title: "新題" });
        expect(backup.load(ID)).not.toBeNull();
      });

      it("title が保存前のままなら（保存が成立していない）、書き換えが入っていても残す", async () => {
        const backup = await closedWithUnsaved({ title: "新題", body: "[[題]] 本文 追記" }, self());
        const { session } = setup({
          backup,
          server: page({ body: "[[題]] 本文 追記", version: 3 }),
        });
        expect(session.getState().pendingBackup).toMatchObject({ title: "新題" });
      });

      it("title を変えずに本文を編集して閉じ、別ページの改名で書き換わっていれば、保存済みとして消す", async () => {
        const backup = await closedWithUnsaved({ title: "題", body: "[[旧]] 本文 追記" });
        const { session } = setup({
          backup,
          server: page({ body: "[[新]] 本文 追記", version: 3 }),
        });
        expect(session.getState().pendingBackup).toBeNull();
        expect(backup.load(ID)).toBeNull();
      });

      it("title を変えない閉じ方で保存されていなければ（書き換わった保存前の本文）、残す", async () => {
        const backup = await closedWithUnsaved({ title: "題", body: "[[旧]] 本文 追記" });
        const { session } = setup({ backup, server: page({ body: "[[新]] 本文", version: 3 }) });
        expect(session.getState().pendingBackup).toMatchObject({ body: "[[旧]] 本文 追記" });
        expect(backup.load(ID)).not.toBeNull();
      });

      it("手元の編集がリンクの付け替えだけで、保存の成否を区別できないときは残す", async () => {
        // サーバーの本文は、保存されていてもいなくても同じ見た目になる
        const backup = await closedWithUnsaved({ title: "題", body: "[[別]] 本文" });
        const { session } = setup({ backup, server: page({ body: "[[新]] 本文", version: 3 }) });
        expect(session.getState().pendingBackup).toMatchObject({ body: "[[別]] 本文" });
      });

      it("他の書き手が同じ title に改名しただけなら、手元のリンクの付け替えを残す", async () => {
        const backup = await closedWithUnsaved(
          { title: "新題", body: "[[題]] 本文 [[乙]]" },
          page({ body: "[[題]] 本文 [[甲]]" }),
        );
        const { session } = setup({
          backup,
          server: page({ title: "新題", body: "[[新題]] 本文 [[甲]]", version: 3 }),
        });
        expect(session.getState().pendingBackup).toMatchObject({ body: "[[題]] 本文 [[乙]]" });
      });

      it("同じリンクの別の箇所を他の書き手が付け替えただけなら、手元の付け替えを残す", async () => {
        const backup = await closedWithUnsaved(
          { title: "題", body: "[[乙]] 本文 [[甲]]" },
          page({ body: "[[甲]] 本文 [[甲]]" }),
        );
        const { session } = setup({
          backup,
          server: page({ body: "[[甲]] 本文 [[丙]]", version: 3 }),
        });
        expect(session.getState().pendingBackup).toMatchObject({ body: "[[乙]] 本文 [[甲]]" });
      });

      it("同じページを指す見出しのリンクに target を足しただけなら、残す", async () => {
        const backup = await closedWithUnsaved(
          { title: "題", body: "[[乙#h]] 本文" },
          page({ body: "[[#h]] 本文" }),
        );
        const { session } = setup({ backup, server: page({ body: "[[丙#h]] 本文", version: 3 }) });
        expect(session.getState().pendingBackup).toMatchObject({ body: "[[乙#h]] 本文" });
      });

      it("版が 1 つしか進んでいなければ（保存と step の 2 回が入っていない）、残す", async () => {
        const backup = await closedWithUnsaved({ title: "題", body: "[[旧]] 本文 追記" });
        const { session } = setup({
          backup,
          server: page({ body: "[[新]] 本文 追記", version: 2 }),
        });
        expect(session.getState().pendingBackup).toMatchObject({ body: "[[旧]] 本文 追記" });
      });
    });

    it("base の欄が無い古い退避は、これまでどおり衝突にする", () => {
      const backup = memoryBackup({
        title: "題",
        body: "[[旧]] 本文 追記",
        baseVersion: 1,
        savedAt: 0,
      });
      const { session } = setup({ backup, server: page({ body: "[[新]] 本文", version: 3 }) });
      session.restoreBackup();
      expect(session.getState().conflict).toMatchObject({ body: "[[新]] 本文" });
    });
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

describe("退避が未決の間", () => {
  const stale = { title: "題", body: "退避", baseVersion: 1, savedAt: 0 };

  it("編集は受け付けず、自動保存も退避の上書きもしない", async () => {
    const backup = memoryBackup(stale);
    const { session, api } = setup({ backup });
    expect(isReadOnly(session.getState())).toBe(true);
    session.edit({ title: "題", body: "上書きのつもり" });
    expect(session.getState().draft.body).toBe("本文");
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.calls).toEqual([]);
    expect(backup.load(ID)).toEqual(stale);
    await session.leave();
    expect(backup.load(ID)).toEqual(stale);
  });

  it("フォーカス復帰で最新の版を取り込んでも退避は残り、復元は衝突になる", async () => {
    const backup = memoryBackup(stale);
    const { session, server } = setup({ backup });
    server.page = page({ body: "他で更新", version: 2 });
    await session.checkFreshness();
    expect(session.getState().base.version).toBe(2);
    expect(backup.load(ID)).toEqual(stale);
    session.restoreBackup();
    expect(saveStatusOf(session.getState())).toBe("conflict");
    expect(session.getState().draft.body).toBe("退避");
  });

  it("削除は退避を決めるまで拒否する", async () => {
    const backup = memoryBackup(stale);
    const { session, api } = setup({ backup });
    expect(await session.remove()).toBe(false);
    expect(api.calls).toEqual([]);
    expect(backup.load(ID)).toEqual(stale);
  });

  it("破棄すると退避が消え、以後は編集できる", async () => {
    const backup = memoryBackup(stale);
    const { session, server } = setup({ backup });
    session.discardBackup();
    expect(backup.load(ID)).toBeNull();
    expect(isReadOnly(session.getState())).toBe(false);
    session.edit({ title: "題", body: "新" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(server.page.body).toBe("新");
  });
});

describe("公開設定と削除の失敗", () => {
  const failOnce = <A extends unknown[], T>(real: (...args: A) => Promise<ApiResult<T>>) => {
    let failed = false;
    return async (...args: A): Promise<ApiResult<T>> => {
      if (failed) return real(...args);
      failed = true;
      return { ok: false, reason: "error", message: "落ちた" };
    };
  };

  it("公開設定の失敗は保存の状態にせず、そのまま再操作できる", async () => {
    const { session, api, server } = setup();
    api.setVisibility = failOnce(api.setVisibility);
    await session.changeVisibility("public");
    const failed = session.getState();
    expect(failed.error).toBe("落ちた");
    expect(failed.failedOp).toEqual({ kind: "visibility", to: "public" });
    expect(saveStatusOf(failed)).toBe("saved");
    await session.changeVisibility("public");
    expect(session.getState().error).toBeNull();
    expect(session.getState().base.visibility).toBe("public");
    expect(server.page.visibility).toBe("public");
  });

  it("保存の失敗が残っていても、公開設定の操作は前回の失敗に妨げられない", async () => {
    const { session, api, server } = setup();
    api.updatePage = failOnce(api.updatePage);
    session.edit({ title: "題", body: "手元" });
    await session.flush();
    expect(saveStatusOf(session.getState())).toBe("error");
    await session.changeVisibility("public");
    expect(session.getState().error).toBeNull();
    expect(server.page).toMatchObject({ body: "手元", visibility: "public" });
  });

  it("削除の失敗は保存の状態にせず、再操作で削除できる", async () => {
    const { session, api } = setup();
    api.deletePage = failOnce(api.deletePage);
    expect(await session.remove()).toBe(false);
    const failed = session.getState();
    expect(failed.failedOp).toEqual({ kind: "delete" });
    expect(saveStatusOf(failed)).toBe("saved");
    expect(await session.remove()).toBe(true);
    expect(session.getState().error).toBeNull();
    expect(saveStatusOf(session.getState())).toBe("gone");
  });

  it("保存の失敗は保存の状態になり、次の入力で消える", async () => {
    const { session, api } = setup();
    api.updatePage = failOnce(api.updatePage);
    session.edit({ title: "題", body: "手元" });
    await session.flush();
    expect(session.getState().failedOp).toEqual({ kind: "save" });
    session.edit({ title: "題", body: "手元2" });
    expect(session.getState().failedOp).toBeNull();
  });
});

describe("title の確定", () => {
  it("打っている途中の title は保存せず、本文の自動保存も保存済みの title を送る", async () => {
    const { session, api } = setup();
    const put = vi.spyOn(api, "updatePage");
    session.editTitle("新しい");
    session.editTitle("新しい題");
    expect(saveStatusOf(session.getState())).toBe("unsaved");
    session.edit({ ...session.getState().draft, body: "本文 追記" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(ID, 1, { title: "題", body: "本文 追記" }, {});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(put).toHaveBeenCalledTimes(1);
    expect(session.getState().titleInput).toBe("新しい題");
  });

  it("確定で 1 回だけ保存し、前後の空白は落とす。変わっていなければ送らない", async () => {
    const { session, api } = setup();
    const put = vi.spyOn(api, "updatePage");
    session.editTitle("  新  ");
    await session.commitTitle();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(ID, 1, { title: "新", body: "本文" }, {});
    expect(session.getState().titleInput).toBeNull();
    expect(saveStatusOf(session.getState())).toBe("saved");
    session.editTitle("新");
    await session.commitTitle();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("空白だけの title は確定せず、欄に残して未保存のままにする", async () => {
    const { session, api } = setup();
    const put = vi.spyOn(api, "updatePage");
    session.editTitle("   ");
    await session.commitTitle();
    expect(put).not.toHaveBeenCalled();
    expect(session.getState()).toMatchObject({ titleInput: "   ", draft: { title: "題" } });
    expect(saveStatusOf(session.getState())).toBe("unsaved");
  });

  it("本文の自分への [[旧 title]] は手元で書き換えない（step の書き換えを取り込む）", async () => {
    const { session, api } = setup({ server: page({ body: "[[題]] と [[別]]" }) });
    const put = vi.spyOn(api, "updatePage");
    session.editTitle("新");
    await session.commitTitle();
    expect(put).toHaveBeenCalledWith(ID, 1, { title: "新", body: "[[題]] と [[別]]" }, {});
  });

  it("title が title_conflict で通らなかったあとに title を変え直しても、他のページへのリンクは書き換えない", async () => {
    const { session, api, server } = setup({
      server: page({ title: "メモ", body: "[[週報]] を見る" }),
    });
    const sent: Draft[] = [];
    const real = api.updatePage;
    api.updatePage = async (id, version, input, options) => {
      sent.push(input);
      if (input.title === "週報") return { ok: false, reason: "title_conflict", message: "重複" };
      return real(id, version, input, options);
    };
    session.editTitle("週報");
    await session.commitTitle();
    expect(session.getState().error).toBe("重複");
    session.editTitle("週報 2");
    await session.commitTitle();
    expect(sent).toEqual([
      { title: "週報", body: "[[週報]] を見る" },
      { title: "週報 2", body: "[[週報]] を見る" },
    ]);
    expect(server.page).toMatchObject({ title: "週報 2", body: "[[週報]] を見る" });
  });

  it("離脱すると、打っていた title を確定して送る", async () => {
    const backup = memoryBackup();
    const { session, api } = setup({ backup });
    const put = vi.spyOn(api, "updatePage");
    session.editTitle("新");
    await session.leave();
    expect(put).toHaveBeenCalledWith(ID, 1, { title: "新", body: "本文" }, { keepalive: true });
    expect(backup.saved.size).toBe(0);
  });

  it("サーバーの title が変わっていれば、取り込むときに打っていた title は捨てる", async () => {
    const { session, server } = setup();
    session.editTitle("打ちかけ");
    server.page = page({ title: "他で変えた", version: 2 });
    await session.checkFreshness();
    expect(session.getState().titleInput).toBeNull();
    expect(session.getState().draft.title).toBe("他で変えた");
  });

  it.each([
    ["フォーカス復帰", (session: EditorSession) => session.checkFreshness()],
    [
      "リンクの書き換え",
      (session: EditorSession) => session.linkRewritten({ sourcePageId: ID, version: 2 }),
    ],
  ])(
    "%sの取り込みは変換が落ち着くまで待ち、変換中に打った title で他での改名を上書きしない",
    async (_, adopt) => {
      let settle = () => {};
      const whenSettled = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      );
      const { session, server, api } = setup({ deps: { whenSettled } });
      server.page = page({ title: "他で変えた", version: 2 });
      const adopting = adopt(session);
      await vi.advanceTimersByTimeAsync(0);
      expect(whenSettled).toHaveBeenCalled();
      // 変換中の入力は、取り込む前の title を土台にして届く
      session.editTitle("題へんかん");
      expect(session.getState().base.version).toBe(1);
      settle();
      await adopting;
      expect(session.getState()).toMatchObject({
        titleInput: null,
        base: { version: 2 },
        draft: { title: "他で変えた" },
      });
      await session.commitTitle();
      expect(api.calls).toEqual(["get"]);
      expect(server.page.title).toBe("他で変えた");
    },
  );

  it("リンクの書き換えの取り込みでも、サーバーの title が変わっていれば打っていた title は捨てる", async () => {
    const { session, server } = setup();
    session.editTitle("打ちかけ");
    server.page = page({ title: "他で変えた", version: 2 });
    await session.linkRewritten({ sourcePageId: ID, version: 2 });
    expect(session.getState().titleInput).toBeNull();
    expect(session.getState().draft.title).toBe("他で変えた");
  });

  it("サーバーの title が変わっていなければ、フォーカス復帰の取り込みでも打っていた title を残す", async () => {
    const { session, server, api } = setup();
    session.editTitle("新");
    server.page = page({ body: "他の本文", version: 2 });
    await session.checkFreshness();
    expect(session.getState()).toMatchObject({
      titleInput: "新",
      base: { version: 2 },
      draft: { title: "題", body: "他の本文" },
    });
    await session.commitTitle();
    expect(api.calls).toEqual(["get", "put@2"]);
    expect(server.page).toMatchObject({ title: "新", body: "他の本文" });
  });

  it("手元の確定済みの title がサーバーに入っていた取り込みでも、その上に打っていた title を残す", async () => {
    const { session, server } = setup();
    session.edit({ title: "確定", body: "本文" });
    session.editTitle("確定の続き");
    server.page = page({ title: "確定", version: 2 });
    await session.checkFreshness();
    expect(session.getState()).toMatchObject({
      titleInput: "確定の続き",
      base: { title: "確定", version: 2 },
      conflict: null,
    });
  });
});

describe("リンクの書き換えの取り込み", () => {
  /** step が開いているページを書き換えたことにする */
  function rewriteOnServer(server: { page: Page }, body: string) {
    server.page = { ...server.page, body, version: server.page.version + 1 };
    return { sourcePageId: ID, version: server.page.version };
  }

  it("手元に変更が無ければ、書き換えた版をそのまま取り込む", async () => {
    const { session, server } = setup({ server: page({ body: "[[旧]]" }) });
    await session.linkRewritten(rewriteOnServer(server, "[[新]]"));
    expect(session.getState().base.version).toBe(2);
    expect(session.getState().draft.body).toBe("[[新]]");
    expect(saveStatusOf(session.getState())).toBe("saved");
  });

  it("未保存の編集があれば書き換えを重ね、新しい版に対して保存する（409 にしない）", async () => {
    const { session, server, api } = setup({ server: page({ body: "[[旧]] 本文" }) });
    session.edit({ title: "題", body: "[[旧]] 本文 追記" });
    await session.linkRewritten(rewriteOnServer(server, "[[新]] 本文"));
    expect(session.getState().draft.body).toBe("[[新]] 本文 追記");
    expect(session.getState().conflict).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.calls).toEqual(["get", "put@2"]);
    expect(server.page).toMatchObject({ body: "[[新]] 本文 追記", version: 3 });
  });

  it("保存と step が行き違っても、409 に書き換えを重ねて送り直し、後から届いた取り込みは何もしない", async () => {
    const { session, server, api } = setup({ server: page({ body: "[[旧]]" }) });
    session.edit({ title: "題", body: "[[旧]] 追記" });
    const saving = session.flush();
    // 保存の要求が届く前に、step が同じページを書き換える
    const processed = rewriteOnServer(server, "[[新]]");
    const adopting = session.linkRewritten(processed);
    await Promise.all([saving, adopting]);
    expect(api.calls).toEqual(["put@1", "get", "put@2"]);
    expect(session.getState()).toMatchObject({
      base: { version: 3 },
      draft: { body: "[[新]] 追記" },
      conflict: null,
    });
    expect(server.page.body).toBe("[[新]] 追記");
  });

  it("取り込みは保存の後ろに並ぶ。自分の保存で版が追いついていれば読み直さない", async () => {
    const { session, server, api } = setup({ server: page({ body: "[[旧]]" }) });
    const real = api.updatePage;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.updatePage = async (...args) => {
      await gate;
      return real(...args);
    };
    session.edit({ title: "題", body: "[[旧]] 追記" });
    const saving = session.flush();
    const adopting = session.linkRewritten({ sourcePageId: ID, version: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.calls).toEqual([]);
    release();
    await Promise.all([saving, adopting]);
    // 自分の保存で版 2 になっているので、取り込みは読み直さない
    expect(api.calls).toEqual(["put@1"]);
    expect(server.page.version).toBe(2);
  });

  it("変換が落ち着くまで、手元の本文に重ねない", async () => {
    let settle = () => {};
    const whenSettled = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const { session, server } = setup({
      server: page({ body: "[[旧]]" }),
      deps: { whenSettled },
    });
    session.edit({ title: "題", body: "[[旧]] へんかん" });
    const adopting = session.linkRewritten(rewriteOnServer(server, "[[新]]"));
    await vi.advanceTimersByTimeAsync(0);
    expect(whenSettled).toHaveBeenCalledTimes(1);
    // 変換中の入力（未確定文字を含む）が届く
    session.edit({ title: "題", body: "[[旧]] 変換" });
    expect(session.getState().base.version).toBe(1);
    settle();
    await adopting;
    expect(session.getState().draft.body).toBe("[[新]] 変換");
    expect(session.getState().base.version).toBe(2);
  });

  it("書き換え以外の変化が混ざっていれば、手元を失わないよう衝突にする", async () => {
    const { session, server } = setup({ server: page({ body: "[[旧]] 本文" }) });
    session.edit({ title: "題", body: "[[旧]] 手元" });
    await session.linkRewritten(rewriteOnServer(server, "[[新]] 他の編集"));
    expect(session.getState().conflict).toMatchObject({ body: "[[新]] 他の編集" });
    expect(session.getState().draft.body).toBe("[[旧]] 手元");
  });

  it("取り直した版が step の版より新しくても、リンクの書き換えだけの差分なら重ねる", async () => {
    const { session, server } = setup({ server: page({ body: "[[旧]] [[甲]] 本文" }) });
    session.edit({ title: "題", body: "[[旧]] [[甲]] 本文 追記" });
    const processed = rewriteOnServer(server, "[[新]] [[甲]] 本文");
    // 取り直す前に、別の step（Cron、別のタブ）がもう一つのリンクを書き換える
    rewriteOnServer(server, "[[新]] [[乙]] 本文");
    await session.linkRewritten(processed);
    expect(session.getState()).toMatchObject({
      conflict: null,
      base: { version: 3 },
      draft: { body: "[[新]] [[乙]] 本文 追記" },
    });
  });

  it("他のページの書き換えでは何も取りに行かない", async () => {
    const { session, api } = setup();
    await session.linkRewritten({ sourcePageId: "BBBBBBBBBBBBBBBBBBBBBB", version: 5 });
    expect(api.calls).toEqual([]);
  });
});

describe("自分のタブの外で走ったリンクの書き換え", () => {
  const base = () => page({ body: "[[旧]] 本文" });
  /** 別の step が開いているページのリンクを書き換えたことにする */
  const rewritten = (server: { page: Page }, body = "[[新]] 本文") => {
    server.page = { ...server.page, body, version: server.page.version + 1 };
  };

  it("保存が 409 でも、差分がリンクの書き換えだけなら手元に重ね、同じ形の要求ですぐに送り直す", async () => {
    const { session, server, api, backup } = setup({ server: base() });
    const put = vi.spyOn(api, "updatePage");
    session.edit({ title: "題", body: "[[旧]] 本文 追記" });
    rewritten(server);
    await session.leave();
    expect(api.calls).toEqual(["put@1", "get", "put@2"]);
    expect(put).toHaveBeenLastCalledWith(
      ID,
      2,
      { title: "題", body: "[[新]] 本文 追記" },
      { keepalive: true },
    );
    expect(session.getState().conflict).toBeNull();
    expect(saveStatusOf(session.getState())).toBe("saved");
    expect(backup.load(ID)).toBeNull();
  });

  it("送り直しがまた 409 になっても、続けては送らず自動保存に任せる", async () => {
    const { session, server, api } = setup({ server: base() });
    session.edit({ title: "題", body: "[[旧]] 本文 追記" });
    rewritten(server);
    const real = api.getPage;
    api.getPage = async (id) => {
      const res = await real(id);
      // 取り直した直後に、さらに別の step が書き換える
      if (server.page.version === 2) rewritten(server, "[[新2]] 本文");
      return res;
    };
    await session.flush();
    expect(api.calls).toEqual(["put@1", "get", "put@2", "get"]);
    expect(session.getState()).toMatchObject({
      conflict: null,
      base: { version: 3 },
      draft: { body: "[[新2]] 本文 追記" },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.calls.at(-1)).toBe("put@3");
    expect(server.page.body).toBe("[[新2]] 本文 追記");
  });

  it("フォーカス復帰で版が進んでいても、リンクの書き換えだけなら衝突にせず重ねる。確定済みの title は残す", async () => {
    const { session, server, api } = setup({ server: base() });
    session.edit({ title: "新題", body: "[[旧]] 本文 追記" });
    rewritten(server);
    await session.checkFreshness();
    expect(session.getState()).toMatchObject({
      conflict: null,
      base: { version: 2 },
      draft: { title: "新題", body: "[[新]] 本文 追記" },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.calls).toEqual(["get", "put@2"]);
    expect(server.page).toMatchObject({ title: "新題", body: "[[新]] 本文 追記" });
  });

  it("書き換え以外の変化が混ざっていれば、これまでどおり衝突にする", async () => {
    const { session, server } = setup({ server: base() });
    session.edit({ title: "題", body: "[[旧]] 本文 追記" });
    rewritten(server, "[[新]] 他の編集");
    await session.flush();
    expect(session.getState().conflict).toMatchObject({ body: "[[新]] 他の編集" });
    expect(session.getState().draft.body).toBe("[[旧]] 本文 追記");
  });

  it("手元が title だけの変更なら、書き換え以外の本文の変更も取り込み、title は残して送り直す", async () => {
    const { session, server, api } = setup({ server: base() });
    session.edit({ title: "新題", body: "[[旧]] 本文" });
    rewritten(server, "他の編集");
    await session.flush();
    expect(api.calls).toEqual(["put@1", "get", "put@2"]);
    expect(session.getState().conflict).toBeNull();
    expect(server.page).toMatchObject({ title: "新題", body: "他の編集", version: 3 });
  });

  it("title だけの変更でも、server の title が変わっていれば衝突にする", async () => {
    const { session, server } = setup({ server: base() });
    session.edit({ title: "新題", body: "[[旧]] 本文" });
    server.page = { ...server.page, title: "別題", body: "他の編集", version: 2 };
    await session.flush();
    expect(session.getState().conflict).toMatchObject({ title: "別題" });
  });

  it("本文が変わらず版だけ進んだ（公開設定の変更など）なら、衝突にせず手元の編集を送り直す", async () => {
    const { session, server, api } = setup({ server: base() });
    session.edit({ title: "題", body: "[[旧]] 本文 追記" });
    server.page = { ...server.page, visibility: "public", version: 2 };
    await session.flush();
    expect(api.calls).toEqual(["put@1", "get", "put@2"]);
    expect(session.getState().conflict).toBeNull();
    expect(server.page).toMatchObject({ body: "[[旧]] 本文 追記", visibility: "public" });
  });
});

describe("離脱のあと", () => {
  const base = () => page({ body: "[[旧]] 本文" });
  const rewritten = (server: { page: Page }, body: string) => {
    server.page = { ...server.page, body, version: server.page.version + 1 };
  };

  /** 離脱の保存が 2 回続けて 409 になり、重ね直した内容が未保存のまま残る状態にする */
  async function leaveWithRepeatedConflict() {
    const ctx = setup({ server: base() });
    const { session, server, api } = ctx;
    session.edit({ title: "題", body: "[[旧]] 本文 追記" });
    rewritten(server, "[[新]] 本文");
    const real = api.getPage;
    api.getPage = async (id) => {
      const res = await real(id);
      if (server.page.version === 2) rewritten(server, "[[新2]] 本文");
      return res;
    };
    await session.leave();
    return ctx;
  }

  it("離脱の保存がまた 409 になっても、自動保存のタイマーは立てず、重ね直した内容を退避に残す", async () => {
    const { session, api, backup, server } = await leaveWithRepeatedConflict();
    expect(api.calls).toEqual(["put@1", "get", "put@2", "get"]);
    expect(session.getState()).toMatchObject({
      conflict: null,
      base: { version: 3 },
      draft: { body: "[[新2]] 本文 追記" },
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.calls).toEqual(["put@1", "get", "put@2", "get"]);
    expect(server.page.body).toBe("[[新2]] 本文");
    expect(backup.load(ID)).toMatchObject({ body: "[[新2]] 本文 追記", baseVersion: 3 });
  });

  it("離脱のあとに届いた取り込みも、重ねるだけで自動保存のタイマーは立てない", async () => {
    const { session, server, api, backup } = setup({ server: base() });
    session.edit({ title: "題", body: "[[旧]] 本文 追記" });
    api.updatePage = async () => ({ ok: false, reason: "error", message: "通信の失敗" });
    await session.leave();
    rewritten(server, "[[新]] 本文");
    await session.linkRewritten({ sourcePageId: ID, version: 2 });
    expect(session.getState().draft.body).toBe("[[新]] 本文 追記");
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.calls).toEqual(["get"]);
    expect(backup.load(ID)).toMatchObject({ body: "[[新]] 本文 追記", baseVersion: 2 });
  });

  it("画面が戻ったら（フォーカス復帰）、止めていた自動保存を再開する", async () => {
    const { session, server, api } = await leaveWithRepeatedConflict();
    api.calls.length = 0;
    await session.checkFreshness();
    await vi.advanceTimersByTimeAsync(2100);
    expect(api.calls).toEqual(["get", "put@3"]);
    expect(server.page.body).toBe("[[新2]] 本文 追記");
  });

  it("画面が戻って入力すれば、自動保存が働く", async () => {
    const { session, server } = await leaveWithRepeatedConflict();
    session.edit({ title: "題", body: "[[新2]] 本文 追記 続き" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(server.page.body).toBe("[[新2]] 本文 追記 続き");
  });
});

describe("まだ作っていないページ", () => {
  function newSession(backup: BackupStore, api: EditorApi, title = "") {
    let now = 1000;
    return new EditorSession(null, { api, backup, now: () => now++ }, title);
  }

  function setupNew(options: { title?: string; backup?: BackupStore; api?: EditorApi } = {}) {
    const server = { page: page() };
    const api = (options.api ?? fakeApi(server)) as EditorApi & { calls: string[] };
    const backup = options.backup ?? memoryBackup();
    const session = newSession(backup, api, options.title);
    return { server, api, backup: backup as BackupStore, session };
  }

  /** 作る前の退避（key は画面ごとに違う）の中身 */
  const newBackups = (backup: BackupStore) =>
    backup.list(NEW_PAGE_BACKUP_PREFIX).map((key) => backup.load(key));

  // 退避の持ち主はモジュールの中で覚えるので、テストごとに別の key にする
  let orphanCount = 0;
  let orphan = "";
  beforeEach(() => {
    orphanCount += 1;
    orphan = `${NEW_PAGE_BACKUP_PREFIX}orphan-${orphanCount}`;
  });

  function deferredCreate(api: EditorApi & { calls: string[] }) {
    let release: () => void = () => {};
    const original = api.createPage.bind(api);
    api.createPage = (input) =>
      new Promise((resolve) => {
        release = () => void original(input).then(resolve);
      });
    return () => release();
  }

  /** 次に呼ばれた作成を、通信の失敗で返すまで待たせる。戻り値で返す */
  function deferredCreateFailure(api: EditorApi) {
    let fail: () => void = () => {};
    const original = api.createPage.bind(api);
    api.createPage = () =>
      new Promise((resolve) => {
        api.createPage = original;
        fail = () => resolve({ ok: false, reason: "error", message: "サーバーに接続できない" });
      });
    return () => fail();
  }

  it("title を確定すると、title と本文で作り、作った版を base にする", async () => {
    const { session, api, server } = setupNew();
    expect(saveStatusOf(session.getState())).toBe("new");
    session.editTitle(" 新しい題 ");
    session.edit({ ...session.getState().draft, body: "本文" });
    await session.commitTitle();
    expect(api.calls).toEqual(["create"]);
    expect(server.page).toMatchObject({ title: "新しい題", body: "本文" });
    expect(session.getState()).toMatchObject({ uncreated: false, base: { id: ID, version: 1 } });
    expect(saveStatusOf(session.getState())).toBe("saved");
  });

  it("空の title では作らない", async () => {
    const { session, api } = setupNew();
    session.edit({ title: "", body: "本文" });
    session.editTitle("   ");
    await session.commitTitle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.calls).toEqual([]);
    expect(session.getState().uncreated).toBe(true);
  });

  it("本文の入力、blur、離脱では作らない", async () => {
    const { session, api, backup } = setupNew();
    session.edit({ title: "", body: "本文" });
    await session.flush();
    await vi.advanceTimersByTimeAsync(5000);
    session.editTitle("題");
    await session.leave();
    expect(api.calls).toEqual([]);
    expect(newBackups(backup)).toEqual([expect.objectContaining({ title: "題", body: "本文" })]);
  });

  it("離脱の後に届いた title の確定（タブを隠したときの blur）では作らず、戻った後の確定で作る", async () => {
    const { session, api, backup } = setupNew();
    session.editTitle("打ちかけ");
    await session.leave();
    await session.commitTitle();
    expect(api.calls).toEqual([]);
    expect(newBackups(backup)).toEqual([expect.objectContaining({ title: "打ちかけ" })]);
    await session.checkFreshness();
    await session.commitTitle();
    expect(api.calls).toEqual(["create"]);
    expect(newBackups(backup)).toEqual([]);
  });

  it("unmount の後に mount し直したら（StrictMode）、title の確定で作る", async () => {
    const { session, api } = setupNew();
    await session.detach();
    session.attach();
    session.editTitle("題");
    await session.commitTitle();
    expect(api.calls).toEqual(["create"]);
  });

  it("作成の応答を待つ間の入力は、作れた後に自動保存で送る", async () => {
    const { session, api, server } = setupNew();
    const release = deferredCreate(api);
    session.editTitle("題");
    const created = session.commitTitle();
    await vi.advanceTimersByTimeAsync(0);
    session.edit({ title: "題", body: "待つ間の入力" });
    expect(saveStatusOf(session.getState())).toBe("creating");
    release();
    await created;
    expect(server.page.body).toBe("");
    await vi.advanceTimersByTimeAsync(2100);
    expect(api.calls).toEqual(["create", "put@1"]);
    expect(server.page.body).toBe("待つ間の入力");
  });

  it("Enter に続く blur の確定でも、作るのは 1 回", async () => {
    const { session, api } = setupNew();
    session.editTitle("題");
    const first = session.commitTitle();
    const second = session.commitTitle();
    await Promise.all([first, second]);
    expect(api.calls).toEqual(["create"]);
  });

  it("空の title の確定は作成の応答待ちにせず、内容があれば作る前の内容を持つと答える", async () => {
    const { session, api } = setupNew();
    expect(session.holdsUncreatedContent()).toBe(false);
    session.edit({ title: "", body: "本文" });
    void session.commitTitle();
    expect(session.holdsUncreatedContent()).toBe(true);
    const release = deferredCreate(api);
    session.editTitle("題");
    const created = session.commitTitle();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.holdsUncreatedContent()).toBe(false);
    release();
    await created;
    expect(session.holdsUncreatedContent()).toBe(false);
  });

  it("title を渡して始めたら、確定だけで作る", async () => {
    const { session, api, server } = setupNew({ title: "リンクの題" });
    await session.commitTitle();
    expect(api.calls).toEqual(["create"]);
    expect(server.page.title).toBe("リンクの題");
  });

  it("title の重複は、title を直すまで本文を打っても案内を残し、直して確定すると作り直す", async () => {
    const { session, api } = setupNew();
    const create = api.createPage.bind(api);
    api.createPage = async () => ({
      ok: false,
      reason: "title_conflict",
      message: "同じ title のページがすでにある",
    });
    session.editTitle("題");
    await session.commitTitle();
    expect(session.getState().failedOp).toEqual({ kind: "create", titleTaken: true, title: "題" });
    expect(saveStatusOf(session.getState())).toBe("create-error");
    session.edit({ title: "題", body: "続き" });
    expect(session.getState().error).not.toBeNull();
    api.createPage = create;
    session.editTitle("別の題");
    await session.commitTitle();
    expect(session.getState()).toMatchObject({ uncreated: false, error: null });
    expect(session.getState().base).toMatchObject({ title: "別の題", body: "続き" });
  });

  it("通信の失敗は再試行で作る", async () => {
    const { session, api } = setupNew();
    const create = api.createPage.bind(api);
    api.createPage = async () => ({
      ok: false,
      reason: "error",
      message: "サーバーに接続できない",
    });
    session.editTitle("題");
    await session.commitTitle();
    expect(session.getState().failedOp).toEqual({ kind: "create", titleTaken: false, title: "題" });
    expect(saveStatusOf(session.getState())).toBe("create-error");
    api.createPage = create;
    await session.retryCreate();
    expect(session.getState().uncreated).toBe(false);
  });

  it("401 はログイン切れにして退避し、ログインし直した後の再試行で作る", async () => {
    const { session, api, backup } = setupNew();
    const create = api.createPage.bind(api);
    api.createPage = async () => ({ ok: false, reason: "unauthorized" });
    session.editTitle("題");
    await session.commitTitle();
    expect(saveStatusOf(session.getState())).toBe("auth");
    expect(newBackups(backup)).toEqual([
      expect.objectContaining({ title: "題", createFailed: true }),
    ]);
    api.createPage = create;
    await session.retry();
    expect(session.getState().uncreated).toBe(false);
    expect(newBackups(backup)).toEqual([]);
  });

  it("作る前の確認、公開範囲、削除は何もしない", async () => {
    const { session, api } = setupNew();
    session.edit({ title: "", body: "本文" });
    await session.checkFreshness();
    await session.changeVisibility("public");
    expect(await session.remove()).toBe(false);
    expect(api.calls).toEqual([]);
  });

  it("作る前の入力は止まってから退避し、作れたら退避を消す", async () => {
    const { session, backup } = setupNew();
    session.edit({ title: "", body: "本文" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(newBackups(backup)).toEqual([expect.objectContaining({ body: "本文" })]);
    session.editTitle("題");
    await session.commitTitle();
    expect(newBackups(backup)).toEqual([]);
  });

  it("作成の応答を待つ間に開いた次の画面の退避は、作れても消さない", async () => {
    const { session, api, backup } = setupNew();
    const release = deferredCreate(api);
    session.editTitle("題");
    const created = session.commitTitle();
    await vi.advanceTimersByTimeAsync(0);
    void session.detach();
    const next = newSession(backup, api);
    next.adoptPendingBackup();
    next.edit({ title: "", body: "次の画面" });
    await vi.advanceTimersByTimeAsync(1100);
    release();
    await created;
    expect(newBackups(backup)).toEqual([expect.objectContaining({ body: "次の画面" })]);
  });

  it("作成の応答を待つ間に離れたら、作れた後も保存せず、続きの入力は作ったページの退避に残す", async () => {
    const { session, api, backup } = setupNew();
    const release = deferredCreate(api);
    session.editTitle("題");
    const created = session.commitTitle();
    await vi.advanceTimersByTimeAsync(0);
    session.edit({ title: "題", body: "待つ間の入力" });
    void session.detach();
    release();
    await created;
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.calls).toEqual(["create"]);
    expect(newBackups(backup)).toEqual([]);
    expect(backup.load(ID)).toMatchObject({ body: "待つ間の入力", baseVersion: 1 });
  });

  describe("前の画面が残した退避", () => {
    it("前のタブの寿命で残った退避は、mount の後に案内に出し、選ぶまで読み取り専用にする", () => {
      const backup = memoryBackup();
      backup.save(orphan, { title: "前の題", body: "前", baseVersion: 0, savedAt: 1 });
      const { session } = setupNew({ backup });
      expect(session.getState().pendingBackup).toBeNull();
      session.adoptPendingBackup();
      session.adoptPendingBackup();
      expect(session.getState().pendingBackup).toMatchObject({ title: "前の題" });
      expect(isReadOnly(session.getState())).toBe(true);
    });

    it("いくつも残っていれば、新しいものから出す", () => {
      const backup = memoryBackup();
      backup.save(`${orphan}-1`, { title: "古い", body: "", baseVersion: 0, savedAt: 1 });
      backup.save(`${orphan}-2`, { title: "新しい", body: "", baseVersion: 0, savedAt: 2 });
      const { session } = setupNew({ backup });
      session.adoptPendingBackup();
      expect(session.getState().pendingBackup).toMatchObject({ title: "新しい" });
    });

    it("復元すると、その title で作り、退避を消す", async () => {
      const backup = memoryBackup();
      backup.save(orphan, { title: "前の題", body: "前", baseVersion: 0, savedAt: 1 });
      const { session, server } = setupNew({ backup });
      session.adoptPendingBackup();
      session.restoreBackup();
      await vi.advanceTimersByTimeAsync(0);
      expect(server.page).toMatchObject({ title: "前の題", body: "前" });
      expect(newBackups(backup)).toEqual([]);
    });

    it("title の無い退避を復元したら、作るまで同じ退避に書き続ける", async () => {
      const backup = memoryBackup();
      backup.save(orphan, { title: "", body: "前", baseVersion: 0, savedAt: 1 });
      const { session, api } = setupNew({ backup });
      session.adoptPendingBackup();
      session.restoreBackup();
      session.edit({ title: "", body: "前と続き" });
      await vi.advanceTimersByTimeAsync(1100);
      expect(api.calls).toEqual([]);
      expect(backup.list(NEW_PAGE_BACKUP_PREFIX)).toEqual([orphan]);
      expect(backup.load(orphan)).toMatchObject({ body: "前と続き" });
    });

    it("破棄すると退避を消し、作らない", async () => {
      const backup = memoryBackup();
      backup.save(orphan, { title: "前の題", body: "前", baseVersion: 0, savedAt: 1 });
      const { session, api } = setupNew({ backup });
      session.adoptPendingBackup();
      session.discardBackup();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.calls).toEqual([]);
      expect(newBackups(backup)).toEqual([]);
    });

    it("title を渡して開いた画面は退避を出さず、退避は次の素の新規作成の画面まで残る", async () => {
      const backup = memoryBackup();
      backup.save(orphan, { title: "前の題", body: "前", baseVersion: 0, savedAt: 1 });
      const { session, server } = setupNew({ backup, title: "リンクの題" });
      session.adoptPendingBackup();
      expect(session.getState().pendingBackup).toBeNull();
      await session.commitTitle();
      expect(server.page.title).toBe("リンクの題");
      expect(backup.load(orphan)).toMatchObject({ title: "前の題" });
    });

    it("このタブの生きている画面の退避は、次の画面に出さない", async () => {
      const { session, api, backup } = setupNew();
      session.edit({ title: "", body: "生きている画面" });
      await vi.advanceTimersByTimeAsync(1100);
      const next = newSession(backup, api);
      next.adoptPendingBackup();
      expect(next.getState().pendingBackup).toBeNull();
    });

    it("内容のある作る前の画面を閉じると、次の画面がその内容の復元を尋ねる", async () => {
      const { session, api, backup } = setupNew();
      session.editTitle("前の題");
      session.edit({ title: "", body: "前の画面" });
      void session.detach();
      const next = newSession(backup, api);
      next.adoptPendingBackup();
      expect(next.getState().pendingBackup).toMatchObject({ title: "前の題", body: "前の画面" });
      expect(next.getState().pendingBackup?.createFailed).toBeUndefined();
      expect(api.calls).toEqual([]);
    });

    it("unmount の後に mount し直した画面（StrictMode）の内容は、次の画面に出さない", async () => {
      const { session, api, backup } = setupNew();
      session.edit({ title: "", body: "戻った画面" });
      void session.detach();
      session.attach();
      const next = newSession(backup, api);
      next.adoptPendingBackup();
      expect(next.getState().pendingBackup).toBeNull();
    });

    it("作成の失敗を表示したまま閉じた画面の内容は、次の画面に作れなかった内容として出す", async () => {
      const { session, api, backup } = setupNew();
      api.createPage = async () => ({ ok: false, reason: "error", message: "接続できない" });
      session.editTitle("作れない題");
      await session.commitTitle();
      expect(saveStatusOf(session.getState())).toBe("create-error");
      void session.detach();
      const next = newSession(backup, api);
      next.adoptPendingBackup();
      expect(next.getState().pendingBackup).toMatchObject({
        title: "作れない題",
        createFailed: true,
      });
    });

    it("作成の応答を待つ画面を閉じて次の画面を開いても、作成中の内容は出さない", async () => {
      const { session, api, backup } = setupNew();
      const release = deferredCreate(api);
      session.editTitle("作成中の題");
      const created = session.commitTitle();
      await vi.advanceTimersByTimeAsync(0);
      void session.detach();
      const next = newSession(backup, api);
      next.adoptPendingBackup();
      expect(next.getState().pendingBackup).toBeNull();
      release();
      await created;
    });

    it("閉じた後に作成が失敗した内容は、次の画面の入力で消えず、後の画面に作れなかった内容として出す", async () => {
      const { session, api, backup } = setupNew();
      const fail = deferredCreateFailure(api);
      session.editTitle("作れない題");
      const created = session.commitTitle();
      await vi.advanceTimersByTimeAsync(0);
      void session.detach();
      const second = newSession(backup, api);
      second.adoptPendingBackup();
      second.edit({ title: "", body: "次の画面の入力" });
      fail();
      await created;
      await vi.advanceTimersByTimeAsync(1100);
      expect(newBackups(backup)).toHaveLength(2);
      // 閉じた 2 つの画面の内容は、1 つずつ尋ねる
      void second.detach();
      const asked = [];
      for (let i = 0; i < 2; i++) {
        const later = newSession(backup, api);
        later.adoptPendingBackup();
        asked.push(later.getState().pendingBackup);
        later.discardBackup();
        void later.detach();
      }
      expect(asked).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: "作れない題", createFailed: true }),
          expect.objectContaining({ body: "次の画面の入力" }),
        ]),
      );
    });

    it("2 回の離脱の後に作成が失敗した内容を、次の画面で復元して作ると、作る前の退避は残らない", async () => {
      const { session, api, backup } = setupNew();
      const fail = deferredCreateFailure(api);
      session.editTitle("題");
      session.edit({ title: "", body: "本文" });
      const created = session.commitTitle();
      await vi.advanceTimersByTimeAsync(0);
      // 開き直す前の離脱（タブを隠す）と、unmount の離脱。どちらも同じ退避に書く
      await session.leave();
      const next = newSession(backup, api);
      void session.detach();
      fail();
      await created;
      next.adoptPendingBackup();
      expect(next.getState().pendingBackup).toMatchObject({ title: "題", body: "本文" });
      next.restoreBackup();
      await vi.advanceTimersByTimeAsync(0);
      expect(next.getState().uncreated).toBe(false);
      expect(newBackups(backup)).toEqual([]);
    });
  });
});
