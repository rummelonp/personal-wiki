import { ATTACHMENT_CONTENT_TYPES, ATTACHMENT_MAX_BYTES } from "@personal-wiki/domain/attachment";
import { describe, expect, it, vi } from "vitest";
import {
  acceptAttachment,
  attachmentUrl,
  createAttachmentUploader,
  createAttachmentUrlResolver,
  type UploadNotice,
} from "./attachments";
import type { UploadFailureKind, UploadResult } from "./attachments-api";

const NAME = `${"A".repeat(21)}b.png`;
const SAVED: UploadResult = {
  ok: true,
  value: { name: NAME, contentType: "image/png", size: 1 },
};
const KINDS: UploadFailureKind[] = [
  "too_large",
  "unsupported_type",
  "content_mismatch",
  "unauthorized",
  "forbidden",
  "unavailable",
  "error",
];
const png = (name = "a.png") => new File([new Uint8Array([1])], name, { type: "image/png" });

function setup(result: UploadResult | (() => Promise<UploadResult>)) {
  const notices: UploadNotice[] = [];
  const send = vi.fn(typeof result === "function" ? result : async () => result);
  const uploader = createAttachmentUploader({ notify: (n) => notices.push(n), upload: send });
  return { uploader, notices, send };
}

describe("acceptAttachment", () => {
  it("画像は種類を問わず受け取り、画像でないものは既定の貼り付けに任せる", () => {
    for (const type of [...ATTACHMENT_CONTENT_TYPES, "image/svg+xml", "image/heic", "image/bmp"]) {
      expect(acceptAttachment(new File([], "x", { type }))).toBe(true);
    }
    for (const type of ["text/plain", "application/pdf", ""]) {
      expect(acceptAttachment(new File([], "x", { type }))).toBe(false);
    }
  });
});

describe("createAttachmentUploader", () => {
  it("成功したら保存された名前を返し、通知しない", async () => {
    const { uploader, notices, send } = setup(SAVED);
    await expect(uploader.upload(png())).resolves.toEqual({ filename: NAME });
    expect(send).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it("上限を超える File は送らずに通知し、reject する", async () => {
    const { uploader, notices, send } = setup(SAVED);
    const big = new File([new Uint8Array(ATTACHMENT_MAX_BYTES + 1)], "big.png", {
      type: "image/png",
    });
    await expect(uploader.upload(big)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "too_large" });
    expect(notices[0]?.message).toContain("big.png");
    expect(notices[0]?.message).toContain("10 MB までです");
    // 上限を 1 バイト超えただけでも「10.0 MB」と書かない
    expect(notices[0]?.message).toContain("10.1 MB あります");
  });

  it("上限を超える File の大きさは 1,000 単位の MB で出す", async () => {
    const { uploader, notices } = setup(SAVED);
    const big = new File([new Uint8Array(12_300_000)], "big.png", { type: "image/png" });
    await expect(uploader.upload(big)).rejects.toThrow();
    expect(notices[0]?.message).toContain("12.3 MB あります");
  });

  it("content_mismatch は形式が違う場合と別の文で、申告した形式を示す", async () => {
    const { uploader, notices } = setup({ ok: false, kind: "content_mismatch" });
    const jpeg = new File([new Uint8Array([1])], "photo.jpg", { type: "image/jpeg" });
    await expect(uploader.upload(jpeg)).rejects.toThrow();
    expect(notices[0]).toMatchObject({ kind: "content_mismatch" });
    expect(notices[0]?.message).toContain("photo.jpg");
    expect(notices[0]?.message).toContain("JPEG として読めませんでした");
    expect(notices[0]?.message).not.toContain("添付できない形式");
  });

  it.each(["image/svg+xml", "image/heic", "image/bmp"])(
    "受けない種類の画像（%s）は送らずに unsupported_type で通知し、reject する",
    async (type) => {
      const { uploader, notices, send } = setup(SAVED);
      const file = new File(["<svg/>"], "pic.img", { type });
      await expect(uploader.upload(file)).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ kind: "unsupported_type" });
      expect(notices[0]?.message).toContain("pic.img");
    },
  );

  it("上限ちょうどの File は送る", async () => {
    const { uploader, send } = setup(SAVED);
    const exact = new File([new Uint8Array(ATTACHMENT_MAX_BYTES)], "x.png", { type: "image/png" });
    await uploader.upload(exact);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(KINDS)("%s の失敗はその種類で通知してから reject する", async (kind) => {
    const { uploader, notices } = setup({ ok: false, kind });
    await expect(uploader.upload(png())).rejects.toThrow();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe(kind);
    expect(notices[0]?.message).not.toBe("");
  });

  it("通知の文言は種類ごとに違う", async () => {
    const messages = new Set<string>();
    for (const kind of KINDS) {
      const { uploader, notices } = setup({ ok: false, kind });
      await uploader.upload(png()).catch(() => {});
      messages.add(notices[0]?.message ?? "");
    }
    expect(messages.size).toBe(KINDS.length);
  });

  it("error の知らせは、通信を原因として書かず、もう一度添付することと再読み込みを案内する", async () => {
    const { uploader, notices } = setup({ ok: false, kind: "error" });
    await uploader.upload(png("pic.png")).catch(() => {});
    expect(notices[0]?.message).toBe(
      "「pic.png」を添付できませんでした。もう一度添付してください。直らないときは再読み込みしてください。",
    );
  });

  it("名前の無い File は「この画像」と呼ぶ", async () => {
    const { uploader, notices } = setup({ ok: false, kind: "error" });
    await uploader.upload(png("")).catch(() => {});
    expect(notices[0]?.message).toContain("この画像");
  });

  it("アップロード中だけ、ページを離れる前の確認を出す", async () => {
    let finish: (result: UploadResult) => void = () => {};
    const { uploader } = setup(() => new Promise((resolve) => (finish = resolve)));
    const win = new EventTarget();
    const unbind = uploader.bindUnloadGuard(win);
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      win.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    const pending = uploader.upload(png());
    expect(leave()).toBe(true);
    finish(SAVED);
    await pending;
    expect(leave()).toBe(false);
    unbind();
  });

  it("失敗したアップロードも、確認の対象から外れる", async () => {
    const { uploader } = setup({ ok: false, kind: "error" });
    const win = new EventTarget();
    uploader.bindUnloadGuard(win);
    await uploader.upload(png()).catch(() => {});
    const event = new Event("beforeunload", { cancelable: true });
    win.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("確認を外すと、アップロード中でも出さない", async () => {
    const { uploader } = setup(() => new Promise(() => {}));
    const win = new EventTarget();
    const unbind = uploader.bindUnloadGuard(win);
    void uploader.upload(png());
    unbind();
    const event = new Event("beforeunload", { cancelable: true });
    win.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("createAttachmentUrlResolver", () => {
  const embedIds = new Map([["埋め込み先", "EMBED"]]);
  const make = (enabled = true) =>
    createAttachmentUrlResolver({
      enabled,
      pageId: () => "SELF",
      embedPageId: (target) => embedIds.get(target) ?? null,
    });

  it("ページ本体の添付は、このページの id の配信 URL にする", () => {
    expect(make()(NAME)).toBe(`/api/pages/SELF/attachments/${NAME}`);
    expect(attachmentUrl("a/b", "c d.png")).toBe("/api/pages/a%2Fb/attachments/c%20d.png");
  });

  it("入れ子の embed の添付は、埋め込み先の id で引く", () => {
    expect(make()(NAME, "埋め込み先")).toBe(`/api/pages/EMBED/attachments/${NAME}`);
  });

  it("埋め込み先の id が引けなければ null", () => {
    expect(make()(NAME, "取得前")).toBeNull();
  });

  it("サーバーが振る名前の形に合わないものは null（placeholder を含む）", () => {
    const resolve = make();
    for (const name of [
      "uploading.1700000000000-0.png",
      "image.png",
      "A".repeat(22),
      `${"A".repeat(22)}.svg`,
      `${"A".repeat(22)}.PNG`,
      `../${NAME}`,
      "",
    ]) {
      expect(resolve(name)).toBeNull();
      expect(resolve(name, "埋め込み先")).toBeNull();
    }
  });

  it("features が false のときは、正しい名前でも null", () => {
    const resolve = make(false);
    expect(resolve(NAME)).toBeNull();
    expect(resolve(NAME, "埋め込み先")).toBeNull();
  });
});
