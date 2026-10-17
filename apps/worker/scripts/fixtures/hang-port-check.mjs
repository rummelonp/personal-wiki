// dev-owner のテストで node --import に渡す。ポートの検査（net.connect）を結果の返らない
// ソケットにして、wrangler dev を起動する前で止める。signal handler は検査の前に置かれるので、
// 標準エラー出力にこの行が出た後に送ったシグナルは、必ず起動前に届く。

import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

net.connect = () => {
  console.error("port check pending");
  // 待つものが無いと process は未解決の top-level await のまま 13 で終わる
  setInterval(() => {}, 1000);
  return /** @type {any} */ (Object.assign(new EventEmitter(), { destroy() {} }));
};
syncBuiltinESMExports();
