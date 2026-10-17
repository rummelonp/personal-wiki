import { decodeBase64Url, decodeBase64UrlJson, encodeBase64Url } from "./base64url";

/*
 * cookie に載せる、署名付きの JSON の値。形は `<payload の base64url>.<HMAC-SHA256 の base64url>`。
 * 署名の対象の先頭に用途（context）を入れる。同じ秘密で署名した別の用途の値を差し替えられても、
 * 用途が違えば検証を通さない。
 */

// 鍵の取り込みを cookie 付きのリクエストごとに繰り返さないよう、isolate の中で使い回す。
// 秘密は通常 1 つなので、最後に使った 1 組だけを持つ（入れ替え後は古い鍵を持ち続けない）
let cachedKey: { secret: string; key: Promise<CryptoKey> } | undefined;

function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret !== secret) {
    const key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    cachedKey = { secret, key };
  }
  return cachedKey.key;
}

function signingInput(context: string, payloadPart: string): Uint8Array {
  return new TextEncoder().encode(context + payloadPart);
}

export async function signJson(
  secret: string,
  context: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const payloadPart = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    signingInput(context, payloadPart),
  );
  return `${payloadPart}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** 署名が合えば payload を返す。形、署名、JSON のどれかが合わなければ null。期限は呼び出し側で見る。 */
export async function verifyJson(
  secret: string,
  context: string,
  value: string,
): Promise<Record<string, unknown> | null> {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payloadPart, signaturePart] = parts as [string, string];
  const signature = decodeBase64Url(signaturePart);
  if (signature === null) return null;
  // crypto.subtle.verify は比較の時間が一致した長さに依存しない
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    signingInput(context, payloadPart),
  );
  if (!valid) return null;
  return decodeBase64UrlJson(payloadPart);
}
