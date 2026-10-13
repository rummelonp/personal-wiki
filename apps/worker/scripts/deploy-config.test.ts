import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deployArgs, migrateArgs } from "./deploy.mjs";
import { composeConfig, readDeployValues, stripJsonc } from "./deploy-config.mjs";

const VALUES = {
  hostname: "wiki.test.example",
  d1DatabaseName: "my-wiki",
  d1DatabaseId: "00000000-0000-0000-0000-000000000000",
  r2BucketName: "my-wiki-files",
  accountId: undefined,
};

const BASE = {
  name: "personal-wiki",
  main: "src/index.ts",
  routes: [{ pattern: "wiki.example.com", custom_domain: true }],
  d1_databases: [
    { binding: "DB", database_name: "personal-wiki", migrations_dir: "migrations" },
    { binding: "OTHER", database_name: "other" },
  ],
  r2_buckets: [{ binding: "BUCKET", bucket_name: "personal-wiki" }],
};

describe("stripJsonc", () => {
  it("コメントと末尾カンマを除き、文字列の中の // や /* は残す", () => {
    const text = `// 先頭
{
  /* ブロック */
  "url": "https://example.com/a//b",
  "glob": "/*.ts",
  "list": [1, 2,],
  "esc": "a\\"//b", // 行末
}`;
    expect(JSON.parse(stripJsonc(text))).toEqual({
      url: "https://example.com/a//b",
      glob: "/*.ts",
      list: [1, 2],
      esc: 'a"//b',
    });
  });

  it("コミットされた wrangler.jsonc を JSON として読める", () => {
    const text = readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8");
    const config = JSON.parse(stripJsonc(text));
    expect(config.d1_databases[0].binding).toBe("DB");
    expect(config.r2_buckets[0].binding).toBe("BUCKET");
  });
});

describe("readDeployValues", () => {
  it("必須の値と任意の値を読み、名前は既定値で補う", () => {
    const result = readDeployValues(
      "WIKI_HOSTNAME=wiki.test.example\nD1_DATABASE_ID=abc\n# コメント\nCLOUDFLARE_ACCOUNT_ID=acct\n",
    );
    expect(result).toEqual({
      values: {
        hostname: "wiki.test.example",
        d1DatabaseId: "abc",
        d1DatabaseName: "personal-wiki",
        r2BucketName: "personal-wiki",
        accountId: "acct",
      },
    });
  });

  it("足りない必須の値をすべて挙げる。空の値は無いものとして扱う", () => {
    expect(readDeployValues("")).toEqual({ missing: ["WIKI_HOSTNAME", "D1_DATABASE_ID"] });
    expect(readDeployValues("WIKI_HOSTNAME=h\nD1_DATABASE_ID=  \n")).toEqual({
      missing: ["D1_DATABASE_ID"],
    });
  });
});

describe("composeConfig", () => {
  it("ホスト名、D1、R2 を差し替え、それ以外は元のまま残す", () => {
    const config = composeConfig(BASE, VALUES);
    expect(config.routes).toEqual([{ pattern: "wiki.test.example", custom_domain: true }]);
    expect(config.d1_databases[0]).toEqual({
      binding: "DB",
      database_name: "my-wiki",
      database_id: "00000000-0000-0000-0000-000000000000",
      migrations_dir: "migrations",
    });
    expect(config.d1_databases[1]).toEqual(BASE.d1_databases[1]);
    expect(config.r2_buckets).toEqual([{ binding: "BUCKET", bucket_name: "my-wiki-files" }]);
    expect(config.main).toBe("src/index.ts");
    expect(config).not.toHaveProperty("account_id");
  });

  it("入力を書き換えない", () => {
    const before = structuredClone(BASE);
    composeConfig(BASE, VALUES);
    expect(BASE).toEqual(before);
  });

  it("account_id は指定されたときだけ入れる", () => {
    expect(composeConfig(BASE, { ...VALUES, accountId: "acct" }).account_id).toBe("acct");
  });

  it("binding の順序に依存せず名前で探す", () => {
    const reordered = { ...BASE, d1_databases: [...BASE.d1_databases].reverse() };
    const config = composeConfig(reordered, VALUES);
    expect(config.d1_databases[1].database_id).toBe(VALUES.d1DatabaseId);
    expect(config.d1_databases[0].database_id).toBeUndefined();
  });

  it("対象の binding が無ければ例外にする", () => {
    expect(() => composeConfig({ ...BASE, d1_databases: [] }, VALUES)).toThrow(/"DB"/);
    expect(() => composeConfig({ ...BASE, r2_buckets: [] }, VALUES)).toThrow(/"BUCKET"/);
  });
});

describe("wrangler の引数", () => {
  it("deploy は自動プロビジョニングを止め、生成した設定を使う", () => {
    expect(deployArgs("/w/c.json", ["--dry-run"])).toEqual([
      "deploy",
      "--config",
      "/w/c.json",
      "--x-provision=false",
      "--dry-run",
    ]);
  });

  it("migrate は remote の D1 に適用する", () => {
    expect(migrateArgs("/w/c.json", [])).toEqual([
      "d1",
      "migrations",
      "apply",
      "DB",
      "--remote",
      "--config",
      "/w/c.json",
    ]);
  });
});
