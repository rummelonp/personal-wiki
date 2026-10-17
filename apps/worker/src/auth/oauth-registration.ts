import type {
  ClientRegistrationCallbackOptions,
  ClientRegistrationCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import type { Bindings } from "../env";
import { readBounded } from "../read-bounded";

/*
 * client の登録（DCR）は匿名で呼べ、通れば KV に 1 回書き込む。KV の無料枠（1 日に書き込み 1,000 回）を
 * 使い切られると既存のコネクタのトークン更新まで止まるので、KV に書く前に次の順で断る。
 * 安く判定できるものから先に見て、断った登録は 1 日の回数に数えない。
 * 0. body の大きさ（boundRegistrationRequest。ライブラリに渡す前に断る）
 * 1. client_name の長さ
 * 2. redirect URI が許可リストに無い
 * 3. その日（UTC）の登録数が上限に達した
 *
 * Workers の Rate Limiting binding は使わない。数える窓が 10 秒か 60 秒で場所ごとに数えるので、
 * 1 日の書き込みの上限を守れない。
 */

/** claude.ai のカスタムコネクタのリダイレクト先。deploy.env の OAUTH_REDIRECT_URIS で足せる。 */
export const DEFAULT_OAUTH_REDIRECT_URIS: readonly string[] = [
  "https://claude.ai/api/mcp/auth_callback",
];

/** client の登録 1 回の JSON の上限（バイト）。claude.ai の登録は数百バイトに収まる。 */
export const MAX_REGISTRATION_BODY_BYTES = 4096;
/** 同意画面に出す名前なので、画面を埋めない長さに抑える */
export const MAX_CLIENT_NAME_LENGTH = 100;
/**
 * 1 日（UTC）に受け付ける登録の数。接続し直すたびに 1 回登録されるので、owner が試行錯誤しても
 * 足りる数にする。上限に達した日は新しい接続だけが止まり、接続済みのコネクタは動き続ける。
 */
export const MAX_REGISTRATIONS_PER_DAY = 20;

export function allowedRedirectUris(env: Bindings): ReadonlySet<string> {
  const extra = (env.OAUTH_REDIRECT_URIS ?? "")
    .split(",")
    .map((uri) => uri.trim())
    .filter((uri) => uri !== "");
  return new Set([...DEFAULT_OAUTH_REDIRECT_URIS, ...extra]);
}

function reject(description: string, status = 400): ClientRegistrationCallbackResult {
  return { code: "invalid_client_metadata", description, status };
}

function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** その日の登録数を 1 つ進める。上限に達していれば進めずに false を返す。 */
async function countRegistration(db: D1Database, day: string): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO oauth_client_registrations (day, count) VALUES (?1, 1)
       ON CONFLICT (day) DO UPDATE SET count = count + 1 WHERE count < ?2
       RETURNING count`,
    )
    .bind(day, MAX_REGISTRATIONS_PER_DAY)
    .first<{ count: number }>();
  return row !== null;
}

function oauthError(error: string, description: string, status: number): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * 登録のリクエストを、ライブラリに渡す前に MAX_REGISTRATION_BODY_BYTES で断る。
 * ライブラリ自身の上限は 1 MiB で、本文を JSON.parse した後に clientRegistrationCallback が呼ばれるので、
 * そこで大きさを見ても、解析のコストは先に払われている。
 * Content-Length を必須にして、申告より実際の本文が長い場合は読むのを途中でやめる。
 * 通した本文は読み終えているので、同じ内容の新しい Request に詰め直して返す。
 */
export async function boundRegistrationRequest(request: Request): Promise<Request | Response> {
  const declared = request.headers.get("Content-Length");
  if (declared === null) {
    return oauthError("invalid_request", "Content-Length が必要です", 411);
  }
  if (!/^[0-9]{1,16}$/.test(declared.trim())) {
    return oauthError("invalid_request", "Content-Length が不正です", 400);
  }
  const tooLarge = () =>
    oauthError(
      "invalid_request",
      `登録の JSON は ${MAX_REGISTRATION_BODY_BYTES} バイトまでです`,
      413,
    );
  if (Number(declared) > MAX_REGISTRATION_BODY_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    return tooLarge();
  }
  const bytes = await readBounded(request.body, MAX_REGISTRATION_BODY_BYTES);
  if (bytes === null) return tooLarge();
  if (bytes.byteLength !== Number(declared)) {
    return oauthError("invalid_request", "Content-Length と本文の長さが一致しません", 400);
  }
  return new Request(request, { body: bytes });
}

/**
 * ライブラリの clientRegistrationCallback。clientMetadata はライブラリが検証した後の値ではなく
 * 生の JSON なので、型を確かめてから読む。
 */
export function registrationGate(env: Bindings, now: () => number) {
  return async ({
    clientMetadata,
  }: ClientRegistrationCallbackOptions): Promise<ClientRegistrationCallbackResult | undefined> => {
    const name = clientMetadata.client_name;
    if (typeof name === "string" && name.length > MAX_CLIENT_NAME_LENGTH) {
      return reject(`client_name は ${MAX_CLIENT_NAME_LENGTH} 文字までです`);
    }
    const allowed = allowedRedirectUris(env);
    const uris = clientMetadata.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      !uris.every((uri) => typeof uri === "string" && allowed.has(uri))
    ) {
      return reject("この wiki が許可していない redirect_uri です");
    }
    if (!(await countRegistration(env.DB, utcDay(now())))) {
      return {
        code: "temporarily_unavailable",
        description: "今日の client の登録数が上限に達しました。UTC の翌日に登録し直してください",
        status: 429,
      };
    }
    return undefined;
  };
}
