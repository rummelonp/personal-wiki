import { connect } from "node:net";
import { expect, test } from "@playwright/test";

/*
 * E2E の proxy（support/keep-alive-proxy.ts）が、wrangler dev が閉じる 5 秒を過ぎても接続を保つことを、
 * ブラウザを使わず生のソケットで確かめる。
 */

const IDLE_MS = 5_500;

test("idle の接続を 5 秒を過ぎても閉じず、同じ接続で次の要求に答える", async ({
  browserName,
  isMobile,
}) => {
  test.skip(browserName !== "chromium" || isMobile, "ブラウザに依らないので 1 つの環境で足りる");
  const { port } = new URL(process.env.E2E_ORIGIN ?? "");
  const socket = connect({ host: "127.0.0.1", port: Number(port) });
  const statusLines: string[] = [];
  let closed = false;
  let error: Error | undefined;
  socket.on("data", (chunk) => {
    const line = chunk.toString().split("\r\n")[0];
    if (line?.startsWith("HTTP/")) statusLines.push(line);
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.on("error", (cause) => {
    error = cause;
  });
  const get = () => socket.write("GET /api/healthz HTTP/1.1\r\nHost: localhost\r\n\r\n");

  try {
    get();
    await expect.poll(() => statusLines.length).toBe(1);
    await new Promise((done) => setTimeout(done, IDLE_MS));
    expect(error).toBeUndefined();
    expect(closed).toBe(false);
    get();
    await expect.poll(() => statusLines.length).toBe(2);
    expect(statusLines).toEqual(["HTTP/1.1 200 OK", "HTTP/1.1 200 OK"]);
  } finally {
    socket.destroy();
  }
});
