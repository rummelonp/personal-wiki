/** `Content-Type` の値から、パラメータ（`; charset=` など）を落として小文字にした media type を返す。 */
export function mediaTypeOf(header: string | undefined): string | undefined {
  return header?.split(";")[0]?.trim().toLowerCase();
}
