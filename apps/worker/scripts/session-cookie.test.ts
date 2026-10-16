import { describe, expect, it } from "vitest";
import { mintSessionValue, SESSION_COOKIE_NAME } from "./session-cookie.mjs";

// tsconfig.node.json は workers の型を持たず src を型検査できないので、Worker の実装は
// 型の検査から外して実行時にだけ読み込む（中身は Node でも動く WebCrypto と hono だけ）
const workerSessionPath = "../src/auth/session.ts";
const worker = (await import(/* @vite-ignore */ workerSessionPath)) as {
  SESSION_COOKIE_NAME: string;
  createSessionValue: (config: unknown, email: string, now: number) => Promise<string>;
  verifySessionValue: (config: unknown, value: string, now: number) => Promise<boolean>;
};

const SECRET = "s".repeat(44);
const EMAIL = "owner@example.test";
const NOW_MS = Date.UTC(2026, 9, 17);
const config = {
  teamDomain: "access.example.test",
  audience: "test-audience",
  ownerEmails: new Set([EMAIL]),
  sessionSecret: SECRET,
};

describe("mintSessionValue", () => {
  it("Worker の発行と同じ名前と値を作る", async () => {
    expect(SESSION_COOKIE_NAME).toBe(worker.SESSION_COOKIE_NAME);
    const expiresAt = NOW_MS / 1000 + 24 * 60 * 60;
    expect(mintSessionValue(SECRET, EMAIL, expiresAt)).toBe(
      await worker.createSessionValue(config, EMAIL, NOW_MS),
    );
  });

  it("Worker の検証は同じ秘密で期限内の値だけを通す", async () => {
    const expiresAt = NOW_MS / 1000 + 60;
    expect(
      await worker.verifySessionValue(config, mintSessionValue(SECRET, EMAIL, expiresAt), NOW_MS),
    ).toBe(true);
    expect(
      await worker.verifySessionValue(
        config,
        mintSessionValue("t".repeat(44), EMAIL, expiresAt),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      await worker.verifySessionValue(
        config,
        mintSessionValue(SECRET, EMAIL, NOW_MS / 1000),
        NOW_MS,
      ),
    ).toBe(false);
  });
});
