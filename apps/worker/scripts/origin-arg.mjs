const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * スクリプトの `--url` を検査する。write の token を Authorization に載せて送るので、
 * 平文の http は loopback だけに許し、それ以外は https に限る。
 * userinfo（`http://localhost@evil.example`）は正規表現の検査をすり抜けるので、URL として
 * 解釈し直して hostname を見る。
 * @param {string} value
 * @returns {string} 渡された origin（正規化しない）
 */
export function parseOriginArg(value) {
  if (!/^https?:\/\/[^/?#\\\s]+$/.test(value)) {
    throw new Error("--url must be an origin such as http://localhost:8787");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--url must be an origin such as http://localhost:8787");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("--url must not contain credentials");
  }
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      "--url must use https unless it is localhost, 127.0.0.1 or [::1] (the token would be sent in plain text)",
    );
  }
  return value;
}
