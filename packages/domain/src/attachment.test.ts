import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  AVIF_BRAND_SEARCH_LIMIT,
  attachmentExtensionForType,
  attachmentTypeForName,
  isAttachmentName,
  matchesAttachmentMagic,
} from "./attachment";

const ID = "AAAAAAAAAAAAAAAAAAAAAA";

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

function bytes(...parts: (number | ArrayLike<number>)[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((p) => (typeof p === "number" ? [p] : Array.from(p))));
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function ftyp(major: string, compatible: string[]): Uint8Array {
  const size = 16 + compatible.length * 4;
  return bytes(u32(size), ascii("ftyp"), ascii(major), u32(0), compatible.flatMap(ascii));
}

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF87 = bytes(ascii("GIF87a"), [1, 0, 1, 0]);
const GIF89 = bytes(ascii("GIF89a"), [1, 0, 1, 0]);
const WEBP = bytes(ascii("RIFF"), u32(100), ascii("WEBP"), ascii("VP8 "));
const AVIF = ftyp("avif", ["mif1", "miaf"]);

describe("isAttachmentName", () => {
  it.each(["png", "jpg", "gif", "webp", "avif"])("22 文字の乱数と .%s を受ける", (ext) => {
    expect(isAttachmentName(`${ID}.${ext}`)).toBe(true);
  });

  it("base64url の文字（- と _）を受ける", () => {
    expect(isAttachmentName("a-_Z09a-_Z09a-_Z09a-_Z.png")).toBe(true);
  });

  it.each([
    ["21 文字", `${ID.slice(1)}.png`],
    ["23 文字", `${ID}A.png`],
    ["親ディレクトリ", "..png"],
    ["親ディレクトリを含む", `../${ID}.png`],
    ["スラッシュを含む", `a/${ID.slice(2)}.png`],
    ["svg", `${ID}.svg`],
    ["大文字の拡張子", `${ID}.PNG`],
    ["jpeg の綴り", `${ID}.jpeg`],
    ["拡張子なし", ID],
    ["末尾に余分な文字", `${ID}.png.png`],
    ["改行を含む", `${ID}.png\n`],
    ["貼り付けの既定名", "Pasted image.png"],
    ["base64 の + と /", `${ID.slice(2)}+/.png`],
    ["空", ""],
  ])("%s は受けない", (_label, name) => {
    expect(isAttachmentName(name)).toBe(false);
  });
});

describe("content type と拡張子の対応", () => {
  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
    ["image/avif", "avif"],
  ] as const)("%s は %s", (type, ext) => {
    expect(attachmentExtensionForType(type)).toBe(ext);
    expect(attachmentTypeForName(`${ID}.${ext}`)).toBe(type);
  });

  it("許可する type すべてで、名前の判定と両方向の対応が噛み合う", () => {
    for (const type of ATTACHMENT_CONTENT_TYPES) {
      const ext = attachmentExtensionForType(type);
      expect(ext, type).not.toBeNull();
      const name = `${ID}.${ext}`;
      expect(isAttachmentName(name), name).toBe(true);
      expect(attachmentTypeForName(name), name).toBe(type);
    }
  });

  it("受けない type は null で、Object のプロパティ名も引かない", () => {
    expect(attachmentExtensionForType("image/svg+xml")).toBeNull();
    expect(attachmentExtensionForType("image/png; charset=utf-8")).toBeNull();
    expect(attachmentExtensionForType("toString")).toBeNull();
    expect(attachmentExtensionForType("")).toBeNull();
  });

  it("名前の形が合わなければ type を引かない", () => {
    expect(attachmentTypeForName(`${ID}.svg`)).toBeNull();
    expect(attachmentTypeForName("a.png")).toBeNull();
  });
});

describe("ATTACHMENT_MAX_BYTES", () => {
  it("10 MB（1,000 単位）", () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(10_000_000);
  });
});

describe("matchesAttachmentMagic", () => {
  it.each([
    ["image/png", PNG],
    ["image/jpeg", JPEG],
    ["image/gif", GIF87],
    ["image/gif", GIF89],
    ["image/webp", WEBP],
    ["image/avif", AVIF],
    ["image/avif", ftyp("avis", [])],
    ["image/avif", ftyp("mif1", ["miaf", "avif"])],
  ])("%s の正しい中身を受ける", (type, data) => {
    expect(matchesAttachmentMagic(type, data)).toBe(true);
  });

  it("type と中身が食い違えば受けない", () => {
    const samples = {
      "image/png": PNG,
      "image/jpeg": JPEG,
      "image/gif": GIF89,
      "image/webp": WEBP,
      "image/avif": AVIF,
    };
    for (const [type] of Object.entries(samples)) {
      for (const [other, data] of Object.entries(samples)) {
        expect(matchesAttachmentMagic(type, data), `${type} に ${other} の中身`).toBe(
          type === other,
        );
      }
    }
  });

  it("短すぎる bytes は受けない", () => {
    expect(matchesAttachmentMagic("image/png", new Uint8Array())).toBe(false);
    expect(matchesAttachmentMagic("image/png", PNG.slice(0, 7))).toBe(false);
    expect(matchesAttachmentMagic("image/jpeg", JPEG.slice(0, 2))).toBe(false);
    expect(matchesAttachmentMagic("image/gif", GIF89.slice(0, 5))).toBe(false);
    expect(matchesAttachmentMagic("image/webp", WEBP.slice(0, 11))).toBe(false);
    expect(matchesAttachmentMagic("image/avif", AVIF.slice(0, 11))).toBe(false);
    expect(matchesAttachmentMagic("image/avif", new Uint8Array(3))).toBe(false);
  });

  it("RIFF でも WEBP でなければ受けない", () => {
    const wav = bytes(ascii("RIFF"), u32(100), ascii("WAVE"));
    expect(matchesAttachmentMagic("image/webp", wav)).toBe(false);
  });

  it("avif の brand を持たない ftyp は受けない", () => {
    expect(matchesAttachmentMagic("image/avif", ftyp("heic", ["mif1", "heix"]))).toBe(false);
    expect(matchesAttachmentMagic("image/avif", ftyp("isom", ["mp41"]))).toBe(false);
  });

  it("box の大きさの外にある avif の文字列は brand とみなさない", () => {
    const data = bytes(ftyp("heic", ["mif1"]), ascii("avif"));
    expect(matchesAttachmentMagic("image/avif", data)).toBe(false);
  });

  describe("avif の brand 探索", () => {
    // size を 0 や巨大にして box の終わりを入力に決めさせても、探索は上限で切れる
    function hugeFtyp(size: number, total: number, brandAt?: number): Uint8Array {
      const data = new Uint8Array(total);
      data.set([...u32(size), ...ascii("ftyp"), ...ascii("heic"), ...u32(0)]);
      // 上限いっぱいの入力を 4 バイトずつ埋めると数秒かかり、並行して負荷が高いと timeout に届く。倍々に複製する
      data.set(ascii("mif1"), 16);
      for (let filled = 4; 16 + filled < total; filled *= 2)
        data.copyWithin(16 + filled, 16, 16 + filled);
      if (brandAt !== undefined) data.set(ascii("avif"), brandAt);
      return data;
    }
    const MAX_BYTES = ATTACHMENT_MAX_BYTES;

    it("size が 0 でも上限の内側の brand は読む", () => {
      expect(matchesAttachmentMagic("image/avif", hugeFtyp(0, MAX_BYTES, 64))).toBe(true);
      expect(
        matchesAttachmentMagic("image/avif", hugeFtyp(0, MAX_BYTES, AVIF_BRAND_SEARCH_LIMIT - 4)),
      ).toBe(true);
    });

    it("size が 0 や巨大でも、上限より後ろの avif は brand とみなさない", () => {
      const far = AVIF_BRAND_SEARCH_LIMIT;
      expect(matchesAttachmentMagic("image/avif", hugeFtyp(0, MAX_BYTES, far))).toBe(false);
      expect(matchesAttachmentMagic("image/avif", hugeFtyp(0xffffffff, MAX_BYTES, far))).toBe(
        false,
      );
      expect(
        matchesAttachmentMagic("image/avif", hugeFtyp(MAX_BYTES, MAX_BYTES, MAX_BYTES - 4)),
      ).toBe(false);
    });

    it("brand が無い上限いっぱいの入力は false", () => {
      expect(matchesAttachmentMagic("image/avif", hugeFtyp(0, MAX_BYTES))).toBe(false);
    });

    it("minor version の avif は brand とみなさない", () => {
      const data = bytes(u32(16), ascii("ftyp"), ascii("heic"), ascii("avif"));
      expect(matchesAttachmentMagic("image/avif", data)).toBe(false);
      expect(matchesAttachmentMagic("image/avif", bytes(data, ascii("mif1")))).toBe(false);
    });
  });

  it("subarray の途中から始まる bytes も読める", () => {
    const padded = bytes([9, 9, 9], AVIF);
    expect(matchesAttachmentMagic("image/avif", padded.subarray(3))).toBe(true);
  });

  it("svg は type が何であれ受けない", () => {
    const svg = bytes(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
    expect(matchesAttachmentMagic("image/svg+xml", svg)).toBe(false);
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]) {
      expect(matchesAttachmentMagic(type, svg)).toBe(false);
    }
  });

  it("受けない type は中身が何でも false", () => {
    expect(matchesAttachmentMagic("text/html", bytes(ascii("<html>")))).toBe(false);
    expect(matchesAttachmentMagic("", PNG)).toBe(false);
  });
});
