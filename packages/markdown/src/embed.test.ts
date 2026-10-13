import { ATTACHMENT_CONTENT_TYPES, attachmentExtensionForType } from "@personal-wiki/domain";
import { describe, expect, it } from "vitest";
import {
  embedKindForTarget,
  embedKindOf,
  MAX_EMBED_DIMENSION,
  parseImageEmbedLabel,
} from "./embed";
import { splitWikiLinkContent } from "./wikilink";

describe("保存できる添付の拡張子", () => {
  // domain は markdown に依存しないので、表示側が画像として展開できることはここで押さえる
  it("すべて画像として展開される", () => {
    for (const type of ATTACHMENT_CONTENT_TYPES) {
      const ext = attachmentExtensionForType(type);
      expect(ext, type).not.toBeNull();
      expect(embedKindForTarget(`x.${ext}`), type).toBe("image");
    }
  });
});

describe("embedKindOf", () => {
  const kindOf = (content: string) => {
    const parts = splitWikiLinkContent(content);
    if (!parts) throw new Error(`test setup: WikiLink として読めない: ${content}`);
    return embedKindOf(parts);
  };

  it("expands attachments by their extension", () => {
    expect(kindOf("a.png|300")).toBe("image");
    expect(kindOf("clip.mp4")).toBe("video");
  });

  it("reads any other target as a page title, including titles with a dot", () => {
    expect(kindOf("Note")).toBe("page");
    expect(kindOf("Note|別名")).toBe("page");
    expect(kindOf("v1.2 リリースノート")).toBe("page");
    expect(kindOf("Note.md")).toBe("page");
  });

  it("does not expand an embed of the same page", () => {
    expect(kindOf("#見出し")).toBeNull();
  });

  it("reads a heading embed as a page embed", () => {
    expect(kindOf("Note#見出し")).toBe("page");
    expect(kindOf("Note#親#子|別名")).toBe("page");
  });

  it("leaves block embeds to the WikiLink display", () => {
    expect(kindOf("Note^abc123")).toBeNull();
    expect(kindOf("Note#^abc123")).toBeNull();
    expect(kindOf("Note#見出し#^abc123")).toBeNull();
  });

  it("leaves PDF and audio attachments to the WikiLink display", () => {
    for (const target of ["doc.pdf", "song.mp3", "voice.m4a", "audio.ogg", "take.WAV"]) {
      expect(kindOf(target)).toBeNull();
    }
  });
});

describe("embedKindForTarget", () => {
  it.each(["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.svg", "a.bmp", "a.avif"])(
    "treats %s as an image",
    (target) => {
      expect(embedKindForTarget(target)).toBe("image");
    },
  );

  it.each(["a.mkv", "a.mov", "a.mp4", "a.ogv", "a.webm"])("treats %s as a video", (target) => {
    expect(embedKindForTarget(target)).toBe("video");
  });

  it("matches the extension case-insensitively", () => {
    expect(embedKindForTarget("Photo.PNG")).toBe("image");
    expect(embedKindForTarget("Clip.MP4")).toBe("video");
  });

  it("uses only the last extension", () => {
    expect(embedKindForTarget("archive.png.md")).toBeNull();
    expect(embedKindForTarget("folder/sub.dir/image.png")).toBe("image");
  });

  it("leaves page embeds and unknown extensions to the WikiLink display", () => {
    expect(embedKindForTarget("Note")).toBeNull();
    expect(embedKindForTarget("Note.md")).toBeNull();
    // 音声（`.ogg` など）はまだ展開しない
    expect(embedKindForTarget("audio.ogg")).toBeNull();
    expect(embedKindForTarget("video.avi")).toBeNull();
    expect(embedKindForTarget("trailing.")).toBeNull();
  });
});

describe("parseImageEmbedLabel", () => {
  it("reads a width", () => {
    expect(parseImageEmbedLabel("300")).toEqual({ kind: "size", width: 300, height: null });
  });

  it("reads a width and a height", () => {
    expect(parseImageEmbedLabel("300x200")).toEqual({ kind: "size", width: 300, height: 200 });
  });

  it("has no size when there is no label", () => {
    expect(parseImageEmbedLabel(null)).toEqual({ kind: "none" });
  });

  it.each(["abc", "300px", "300 x 200", "300X200", "x200", "300x", "-300", "1.5"])(
    "treats %j as alt text, as Obsidian treats it as a display name",
    (label) => {
      expect(parseImageEmbedLabel(label)).toEqual({ kind: "alt", text: label });
    },
  );

  it.each([
    "0",
    "0x200",
    "300x0",
    String(MAX_EMBED_DIMENSION + 1),
    `300x${MAX_EMBED_DIMENSION + 1}`,
    "99999999999999999999",
  ])("ignores the unusable size %j instead of showing it as alt text", (label) => {
    expect(parseImageEmbedLabel(label)).toEqual({ kind: "none" });
  });

  it("accepts the upper bound itself", () => {
    expect(parseImageEmbedLabel(`${MAX_EMBED_DIMENSION}`)).toEqual({
      kind: "size",
      width: MAX_EMBED_DIMENSION,
      height: null,
    });
  });
});
