import type { Bindings } from "../env";

/** owner のログインとセッションに要る設定。1 つでも欠けると owner の経路はすべて閉じる。 */
export interface OwnerAuthConfig {
  /** `<team>.cloudflareaccess.com`。JWT の iss と JWKS の取得先に使う */
  teamDomain: string;
  /** Access のアプリケーションの AUD タグ */
  audience: string;
  /** 小文字に揃えた許可リスト */
  ownerEmails: ReadonlySet<string>;
  sessionSecret: string;
}

const HOSTNAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/**
 * HMAC-SHA256 の鍵として短すぎる秘密は未設定と同じに扱う。
 * `openssl rand -base64 32` の出力（44 文字）を想定している。
 */
const MIN_SESSION_SECRET_LENGTH = 32;

/** 設定が欠けているか形式が誤っていれば null。 */
export function readOwnerAuthConfig(env: Partial<Bindings>): OwnerAuthConfig | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const audience = env.ACCESS_AUD?.trim() ?? "";
  const sessionSecret = env.SESSION_SECRET ?? "";
  const ownerEmails = new Set(
    (env.OWNER_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email !== ""),
  );
  if (!HOSTNAME_PATTERN.test(teamDomain)) return null;
  if (audience === "") return null;
  if (ownerEmails.size === 0) return null;
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) return null;
  return { teamDomain, audience, ownerEmails, sessionSecret };
}

export function isOwnerEmail(config: OwnerAuthConfig, email: string): boolean {
  return config.ownerEmails.has(email.trim().toLowerCase());
}
