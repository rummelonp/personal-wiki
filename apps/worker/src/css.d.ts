// wrangler.jsonc の rules で、CSS を文字列の module として取り込む
declare module "*.css" {
  const text: string;
  export default text;
}
