/**
 * 明暗で変える色。`--ui-light` と `--ui-dark` はホストが領域ごとに置く切り替えで、選ばれた側だけが
 * guaranteed-invalid になり、その fallback だけが残る。
 *
 * `light-dark()` を使わないのは、対応ブラウザの下限をホストの token と揃えるため。Editor のスタイルは
 * 実行時に `<style>` として注入され build の CSS 変換を通らないので、`light-dark()` は書き換えられずに
 * ブラウザへ届く代わりに、変換による下位互換も受けない。
 *
 * 切り替えを置くのはホストの責務で、置かれていないと両方の fallback が並んで宣言ごと無効になる
 * （色が消えるのではなく継承か初期値に落ちる）。test では `test-tokens.ts` が同じ切り替えを置く。
 */
export function byScheme(light: string, dark: string): string {
  return `var(--ui-light, ${light}) var(--ui-dark, ${dark})`;
}
