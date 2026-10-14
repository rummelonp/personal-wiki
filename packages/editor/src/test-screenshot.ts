import { cdp } from "vitest/browser";

/** 実際に描かれた画面を撮り、CSS の座標で 1 点の色を読む道具 */
export async function screenshotReader() {
  const { data } = (await cdp().send("Page.captureScreenshot", { format: "png" })) as {
    data: string;
  };
  const bitmap = await createImageBitmap(
    await (await fetch(`data:image/png;base64,${data}`)).blob(),
  );
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("canvas 2d context is unavailable");
  context.drawImage(bitmap, 0, 0);
  const scale = bitmap.width / innerWidth;
  return (x: number, y: number): number[] =>
    [...context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data].slice(0, 3);
}
