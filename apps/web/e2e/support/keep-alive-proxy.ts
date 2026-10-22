import http from "node:http";

/*
 * ブラウザと wrangler dev の間に挟む proxy。wrangler dev は、使われていない keep-alive の接続を
 * 5 秒で閉じる。WebKit は、閉じられる瞬間に再利用した接続への POST を送り直さず、
 * 「The network connection was lost」で失敗させる。ページを開いてから 5 秒近く
 * たって最初の POST を打つテストが、この競合で時々落ちる。
 * 手前に idle の長い接続を受ける proxy を置くと、テストの間はブラウザの接続が閉じられない。
 * 上流へは要求ごとに新しい接続を張るので、proxy と wrangler dev の間では再利用による競合が起きない。
 */

// 1 つのテストの時間切れ（60 秒）より十分長くする
const IDLE_TIMEOUT_MS = 10 * 60_000;

// 接続ごとの項目で、proxy が受け持つ区間の外へ渡してはならない（RFC 9110 の 7.6.1）
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forward(upstreamPort: number): http.RequestListener {
  const agent = new http.Agent({ keepAlive: false });
  return (req, res) => {
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name)),
    );
    const upstream = http.request(
      { host: "127.0.0.1", port: upstreamPort, method: req.method, path: req.url, headers, agent },
      (upstreamRes) => {
        const raw: string[] = [];
        for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
          const name = upstreamRes.rawHeaders[i] ?? "";
          if (!HOP_BY_HOP.has(name.toLowerCase()))
            raw.push(name, upstreamRes.rawHeaders[i + 1] ?? "");
        }
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, raw);
        upstreamRes.pipe(res);
      },
    );
    // ブラウザが途中で切ったら上流も切り、読む相手のいない応答を残さない
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.on("error", (error) => {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`wrangler dev did not respond: ${error.message}\n`);
    });
    req.pipe(upstream);
  };
}

/**
 * localhost をどちらの経路に引くかはブラウザと OS で違うので、127.0.0.1 と ::1 の両方で待つ。
 * IPv6 が無い環境では ::1 を諦める。
 */
export async function startKeepAliveProxy(
  port: number,
  upstreamPort: number,
): Promise<() => Promise<void>> {
  const handler = forward(upstreamPort);
  const servers: http.Server[] = [];
  const stop = async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      ),
    );
  };
  for (const host of ["127.0.0.1", "::1"]) {
    const server = http.createServer(handler);
    server.keepAliveTimeout = IDLE_TIMEOUT_MS;
    try {
      await new Promise<void>((done, fail) => {
        server.once("error", fail);
        server.listen(port, host, () => done());
      });
      servers.push(server);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (host === "::1" && (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT")) continue;
      await stop();
      throw error;
    }
  }
  return stop;
}
