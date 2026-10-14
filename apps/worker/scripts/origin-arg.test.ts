import { describe, expect, it } from "vitest";
import { parseArgs as parseRebuildArgs } from "./derived-rebuild.mjs";
import { parseArgs as parseLinkRewritesArgs } from "./link-rewrites.mjs";
import { parseOriginArg } from "./origin-arg.mjs";

describe("parseOriginArg", () => {
  it("https は任意のホスト、http は loopback だけを受ける", () => {
    for (const origin of [
      "https://wiki.example.com",
      "https://wiki.example.com:8443",
      "http://localhost:8787",
      "http://localhost",
      "http://127.0.0.1:8787",
      "http://[::1]:8787",
      // hostname は URL として正規化されてから判定する（大文字は小文字に、127.1 は 127.0.0.1 になる）
      "http://LOCALHOST:8787",
      "http://127.1:8787",
      "https://Wiki.Example.COM",
    ]) {
      expect(parseOriginArg(origin), origin).toBe(origin);
    }
  });

  it("loopback でない http を拒む（token を平文で送らない）", () => {
    for (const origin of [
      "http://wiki.example.com",
      "http://localhost.example.com",
      "http://127.0.0.1.example.com",
      "http://192.168.0.10:8787",
      "http://[::2]:8787",
      "http://0.0.0.0:8787",
      "http://Wiki.Example.COM",
      // userinfo で loopback の名前を前に置いても、実際の hostname は後ろ
      "http://localhost@wiki.example.com",
      "http://localhost:8787@wiki.example.com",
    ]) {
      expect(() => parseOriginArg(origin), origin).toThrow("--url");
    }
  });

  it("origin でないもの、資格情報つきのものを拒む", () => {
    for (const origin of [
      "http://localhost:8787/path",
      // authority の後ろに ? # \ が続く値は、origin でなく別の URL として解釈されうる
      "http://localhost:8787?x",
      "http://localhost:8787#x",
      "http://localhost:8787\\x",
      "https://wiki.example.com?x=1",
      "https://wiki.example.com#x",
      "https://wiki.example.com\\@evil.example",
      "https://wiki.example.com/",
      "ftp://wiki.example.com",
      "wiki.example.com",
      "https://user:pass@wiki.example.com",
      "https://user@wiki.example.com",
    ]) {
      expect(() => parseOriginArg(origin), origin).toThrow("--url");
    }
  });

  it("2 つのスクリプトとも parseArgs で同じ検査を通す", () => {
    for (const parseArgs of [parseRebuildArgs, parseLinkRewritesArgs]) {
      expect(() => parseArgs(["--url", "http://wiki.example.com"])).toThrow("https");
      expect(() => parseArgs(["--url=http://wiki.example.com"])).toThrow("https");
      expect(parseArgs(["--url", "https://wiki.example.com"]).url).toBe("https://wiki.example.com");
      expect(parseArgs(["--url=http://[::1]:8787"]).url).toBe("http://[::1]:8787");
    }
  });
});
