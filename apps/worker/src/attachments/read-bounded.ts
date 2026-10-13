/**
 * 本文を上限まで読む。上限を超えたら読むのをやめて null を返す。Content-Length は申告にすぎないので、
 * arrayBuffer() で全体を受けずに実際の長さで打ち切る（偽った長さで大きな本文をメモリに載せさせない）。
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
