import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProxyHandler, isLoopbackHost, parseArgs } from "./dev-owner.mjs";
import {
  localWranglerEnv,
  OWNER_EMAIL,
  toLocalConfig,
  writeLocalConfig,
  writeLocalSecrets,
} from "./local-dev.mjs";
import { mintSessionValue, SESSION_COOKIE_NAME } from "./session-cookie.mjs";

describe("parseArgs", () => {
  it("既定のポートと --port を受ける", () => {
    expect(parseArgs([])).toEqual({ port: 8780 });
    expect(parseArgs(["--port", "8840"])).toEqual({ port: 8840 });
    expect(parseArgs(["--port=8840"])).toEqual({ port: 8840 });
  });

  it("pnpm の引数の区切りの -- を読み飛ばす", () => {
    expect(parseArgs(["--", "--port", "8840"])).toEqual({ port: 8840 });
    expect(() => parseArgs(["--", "--remote"])).toThrow("--remote");
  });

  it("inspector（port + 549）が 65535 に収まる範囲まで受ける", () => {
    expect(parseArgs(["--port", "64986"])).toEqual({ port: 64986 });
    expect(() => parseArgs(["--port", "64987"])).toThrow("64986");
  });

  it("--remote を拒む", () => {
    expect(() => parseArgs(["--remote"])).toThrow("--remote");
    expect(() => parseArgs(["--port", "8840", "--remote"])).toThrow("--remote");
  });

  it("知らない引数と範囲外のポートを拒む", () => {
    for (const argv of [
      ["--local"],
      ["--port"],
      ["--port", "abc"],
      ["--port", "80"],
      ["--port", "1023"],
      ["--port", "8840.5"],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow();
    }
  });
});

describe("isLoopbackHost", () => {
  it("loopback の名前と proxy のポートの組だけを受ける", () => {
    for (const host of ["localhost:8780", "127.0.0.1:8780", "[::1]:8780", "LOCALHOST:8780"]) {
      expect(isLoopbackHost(host, 8780), host).toBe(true);
    }
  });

  it("DNS rebinding の Host、ポートの違い、userinfo を拒む", () => {
    for (const host of [
      undefined,
      "",
      "localhost",
      "localhost:8781",
      "evil.example:8780",
      "localhost.evil.example:8780",
      "127.0.0.1.nip.io:8780",
      "192.168.0.10:8780",
      "0.0.0.0:8780",
      "[::2]:8780",
      "localhost@evil.example:8780",
      "evil.example/localhost:8780",
    ]) {
      expect(isLoopbackHost(host, 8780), String(host)).toBe(false);
    }
  });
});

describe("local-dev の設定と秘密", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("routes を外し、パスを絶対にし、秘密を本人だけが読めるファイルに置く", () => {
    dir = mkdtempSync(join(tmpdir(), "dev-owner-test-"));
    const config = JSON.parse(readFileSync(writeLocalConfig(dir), "utf8"));
    expect(config.routes).toBeUndefined();
    expect(isAbsolute(config.main)).toBe(true);
    expect(isAbsolute(config.assets.directory)).toBe(true);
    for (const db of config.d1_databases) expect(isAbsolute(db.migrations_dir)).toBe(true);

    const secretsPath = writeLocalSecrets(dir, { sessionSecret: "s".repeat(44), audience: "aud" });
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
    const secrets = readFileSync(secretsPath, "utf8");
    expect(secrets).toContain(`SESSION_SECRET=${"s".repeat(44)}`);
    expect(secrets).toContain("ACCESS_AUD=aud");
  });

  it("wrangler dev の環境変数は、手元の値に関わらず .env の読み込みを有効に、process.env の取り込みを無効にする", () => {
    const base = {
      PATH: "/usr/bin",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    };
    expect(localWranglerEnv(base)).toEqual({
      PATH: "/usr/bin",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    });
    expect(base.CLOUDFLARE_INCLUDE_PROCESS_ENV).toBe("true");
    expect(localWranglerEnv({}).CLOUDFLARE_INCLUDE_PROCESS_ENV).toBe("false");
  });

  // E2E は CI で流れないので、stack.ts が上書きを自前で持ち直したり、外したりしたときはここで落とす
  it("E2E のスタックは、wrangler dev の環境変数を localWranglerEnv から取る", () => {
    const stack = readFileSync(new URL("../../web/e2e/support/stack.ts", import.meta.url), "utf8");
    expect(stack).toMatch(/env:\s*\{\s*\.\.\.localWranglerEnv\(\)/);
    expect(stack).not.toContain("CLOUDFLARE_");
  });

  it("Cloudflare 上の資源につなぐ remote の binding があれば拒む", () => {
    const base = {
      main: "src/index.ts",
      assets: { directory: "../web/dist" },
      d1_databases: [{ binding: "DB", migrations_dir: "migrations" }],
    };
    expect(() => toLocalConfig(base)).not.toThrow();
    expect(() => toLocalConfig({ ...base, vars: { remote: "yes" } })).not.toThrow();
    expect(() =>
      toLocalConfig({ ...base, d1_databases: [{ ...base.d1_databases[0], remote: false }] }),
    ).not.toThrow();
    expect(() =>
      toLocalConfig({ ...base, d1_databases: [{ ...base.d1_databases[0], remote: true }] }),
    ).toThrow("d1_databases[0]");
    expect(() =>
      toLocalConfig({
        ...base,
        r2_buckets: [{ binding: "BUCKET" }, { binding: "B", remote: true }],
      }),
    ).toThrow("r2_buckets[1]");
    expect(() => toLocalConfig({ ...base, ai: { binding: "AI", remote: true } })).toThrow("ai");
  });
});

describe("createProxyHandler", () => {
  const SECRET = "s".repeat(44);
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
    servers.length = 0;
  });

  async function listen(handler: http.RequestListener): Promise<number> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return (server.address() as AddressInfo).port;
  }

  /** 受けたヘッダーを返し、ログアウトのようにセッション cookie を消すレスポンスを真似る上流。 */
  async function startProxy(
    setCookie = [`${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/`, "other=1"],
  ): Promise<{ port: number; upstreamHits: () => number }> {
    let hits = 0;
    const upstreamPort = await listen((req, res) => {
      hits++;
      res.setHeader("set-cookie", setCookie);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.headers));
    });
    const port = await listen(
      createProxyHandler({ upstreamPort, sessionSecret: SECRET, email: OWNER_EMAIL }),
    );
    return { port, upstreamHits: () => hits };
  }

  function request(
    port: number,
    headers: Record<string, string>,
    path = "/api/me",
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((done, fail) => {
      const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", fail);
      req.end();
    });
  }

  function sessionValueOf(cookie: string | undefined): string[] {
    return (cookie ?? "")
      .split("; ")
      .filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
      .map((part) => part.slice(SESSION_COOKIE_NAME.length + 1));
  }

  it("owner の cookie を 1 つだけ足し、Host を書き換えずに渡す", async () => {
    const { port } = await startProxy();
    const res = await request(port, {
      host: `localhost:${port}`,
      cookie: `${SESSION_COOKIE_NAME}=stale; theme=dark`,
    });
    expect(res.status).toBe(200);
    const seen = JSON.parse(res.body);
    expect(seen.host).toBe(`localhost:${port}`);
    expect(seen.cookie).toContain("theme=dark");
    const values = sessionValueOf(seen.cookie);
    expect(values).toHaveLength(1);
    const payload = values[0]?.split(".")[0] ?? "";
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(values[0]).toBe(mintSessionValue(SECRET, OWNER_EMAIL, exp));
  });

  it("セッション cookie の Set-Cookie をブラウザに渡さない", async () => {
    const { port } = await startProxy();
    const res = await request(port, { host: `127.0.0.1:${port}` });
    expect(res.headers["set-cookie"]).toEqual(["other=1"]);

    const only = await startProxy([`${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/`]);
    const onlySession = await request(only.port, { host: `127.0.0.1:${only.port}` });
    expect(onlySession.headers["set-cookie"]).toBeUndefined();
  });

  it("Authorization 付きには cookie を足さない", async () => {
    const { port } = await startProxy();
    const res = await request(port, {
      host: `localhost:${port}`,
      authorization: "Bearer test",
      cookie: `${SESSION_COOKIE_NAME}=stale`,
    });
    const seen = JSON.parse(res.body);
    expect(seen.authorization).toBe("Bearer test");
    expect(seen.cookie).toBeUndefined();
  });

  it("別の site や別のポートの localhost のページからのリクエストには cookie を足さない", async () => {
    const { port } = await startProxy();
    for (const site of ["cross-site", "same-site"]) {
      const res = await request(port, { host: `localhost:${port}`, "sec-fetch-site": site });
      expect(JSON.parse(res.body).cookie, site).toBeUndefined();
    }
    for (const site of ["same-origin", "none"]) {
      const res = await request(port, { host: `localhost:${port}`, "sec-fetch-site": site });
      expect(sessionValueOf(JSON.parse(res.body).cookie), site).toHaveLength(1);
    }
  });

  it("loopback でない Host は上流に渡さずに拒む", async () => {
    const { port, upstreamHits } = await startProxy();
    for (const host of [`evil.example:${port}`, "localhost:1", `localhost.evil.example:${port}`]) {
      const res = await request(port, { host });
      expect(res.status, host).toBe(403);
    }
    expect(upstreamHits()).toBe(0);
  });

  it("absolute-form のリクエストは上流に渡さずに 400 にする", async () => {
    const { port, upstreamHits } = await startProxy();
    const res = await request(
      port,
      { host: `localhost:${port}` },
      `http://localhost:${port}/api/me`,
    );
    expect(res.status).toBe(400);
    expect(upstreamHits()).toBe(0);
  });

  it("上流につながらなければ 502 を返す", async () => {
    const closed = await listen(() => {});
    await new Promise((done) => servers.pop()?.close(done));
    const port = await listen(
      createProxyHandler({ upstreamPort: closed, sessionSecret: SECRET, email: OWNER_EMAIL }),
    );
    const res = await request(port, { host: `localhost:${port}` });
    expect(res.status).toBe(502);
  });

  it("ブラウザが途中で切ったら上流へのリクエストも切る", async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((done) => {
      upstreamClosed = done;
    });
    const upstreamPort = await listen((req, res) => {
      // 終わらないレスポンスの途中で切られる
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      req.socket.once("close", upstreamClosed);
    });
    const port = await listen(
      createProxyHandler({ upstreamPort, sessionSecret: SECRET, email: OWNER_EMAIL }),
    );
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/events",
      headers: { host: `localhost:${port}` },
    });
    // 切ったときの socket hang up は想定どおり
    req.on("error", () => {});
    req.end();
    const [res] = await once(req, "response");
    await once(res, "data");
    req.destroy();
    await closed;
  });
});
