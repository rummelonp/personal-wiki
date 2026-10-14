# 添付（R2）

画像の添付は R2 に置きます。
バケットの作り方と `R2_BUCKET_NAME` の設定は [deploy.md](./deploy.md) の「添付（R2）」にあります。

`R2_BUCKET_NAME` が空のあいだは、R2 の binding を付けずにデプロイします。
添付の保存は 503、配信は 404 になり、画面は貼り付けの導線を出しません。

## 保存

画像は `POST /api/attachments` に、本文を画像のバイト列、`Content-Type` を画像の種類にして送ります。
`Content-Length` は必須で、無ければ 411 を返します。

## 参照と配信

- 本文の `![[<名前>]]` は、`/api/pages/<page id>/attachments/<名前>` で配信します
- 匿名は、削除されていないそのページが本文で参照する添付だけを読めます
- 画像の URL は page id を含みます。
  draft は id の URL で匿名に読めるので、draft の画像の URL を共有すると、その draft の本文も読めるようになります

## バックアップ

`pnpm backup` は R2 を対象にしません。
添付の名前と種類（`attachments` の表）は入りますが、画像の中身は入らないので、R2 のバケットを残しておきます。
復元の手順は [operations.md](./operations.md) の「バックアップと復元」にあります。
