import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deployArgs, extraArgs, migrateArgs } from "./deploy.mjs";
import {
  BASE_CONFIG_PATH,
  composeConfig,
  GENERATED_CONFIG_PATH,
  readDeployValues,
  stripJsonc,
  writeGeneratedConfig,
} from "./deploy-config.mjs";

const UUID = "00000000-0000-0000-0000-000000000000";
const KV_ID = "0123456789abcdef0123456789abcdef";

const VALUES = {
  hostname: "wiki.test.example",
  d1DatabaseName: "my-wiki",
  d1DatabaseId: UUID,
  r2BucketName: "my-wiki-files",
  oauthKvNamespaceId: KV_ID,
  oauthRedirectUris: undefined,
  linkRewriteCron: undefined,
  accountId: undefined,
  ownerAuth: undefined,
};

const AUD = "0123456789abcdef".repeat(4);
const OWNER_AUTH_ENV = `ACCESS_TEAM_DOMAIN=team.cloudflareaccess.com\nACCESS_AUD=${AUD}\nOWNER_EMAILS= a@example.com , b@example.com \n`;
const NO_OWNER_AUTH_WARNING =
  "ACCESS_TEAM_DOMAIN、ACCESS_AUD、OWNER_EMAILS が無いので、owner のログインは使えません（token の API と MCP は使えます）";
const NO_OAUTH_WARNING =
  "OAUTH_KV_NAMESPACE_ID が無いので、OAuth（claude.ai などのカスタムコネクタからの MCP 接続）は使えません（Bearer トークンの MCP は使えます）";
const OAUTH_WITHOUT_OWNER_WARNING =
  "OAUTH_KV_NAMESPACE_ID はありますが、owner のログインが無いので OAuth は使えません（同意画面に owner のログインが要ります）";

const BASE = {
  name: "personal-wiki",
  main: "src/index.ts",
  routes: [{ pattern: "wiki.example.com", custom_domain: true }],
  d1_databases: [
    { binding: "DB", database_name: "personal-wiki", migrations_dir: "migrations" },
    { binding: "OTHER", database_name: "other" },
  ],
  r2_buckets: [{ binding: "BUCKET", bucket_name: "personal-wiki" }],
  kv_namespaces: [{ binding: "OAUTH_KV" }],
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
    expect(config.kv_namespaces[0].binding).toBe("OAUTH_KV");
  });
});

describe("readDeployValues", () => {
  it("必須の値と任意の値を読み、D1 の名前は既定値で補う。R2 と OAuth の KV は空なら使わない", () => {
    const result = readDeployValues(
      `WIKI_HOSTNAME=wiki.test.example\nD1_DATABASE_ID=${UUID}\n# コメント\nR2_BUCKET_NAME=\nCLOUDFLARE_ACCOUNT_ID=acct\n`,
    );
    expect(result).toEqual({
      values: {
        hostname: "wiki.test.example",
        d1DatabaseId: UUID,
        d1DatabaseName: "personal-wiki",
        r2BucketName: undefined,
        oauthKvNamespaceId: undefined,
        oauthRedirectUris: undefined,
        accountId: "acct",
        ownerAuth: undefined,
      },
      warnings: [NO_OAUTH_WARNING, NO_OWNER_AUTH_WARNING],
    });
  });

  it("owner のログインの値を読み、メールの前後の空白を除く", () => {
    const result = readDeployValues(
      `WIKI_HOSTNAME=h.example\nD1_DATABASE_ID=${UUID}\nOAUTH_KV_NAMESPACE_ID=${KV_ID}\n${OWNER_AUTH_ENV}`,
    );
    expect(result).toEqual({
      values: expect.objectContaining({
        ownerAuth: {
          teamDomain: "team.cloudflareaccess.com",
          audience: AUD,
          ownerEmails: "a@example.com,b@example.com",
        },
      }),
      warnings: [],
    });
  });

  it("owner のログインの値が一部だけ、または形式が誤っていれば弾く", () => {
    const base = `WIKI_HOSTNAME=h.example\nD1_DATABASE_ID=${UUID}\n`;
    expect(readDeployValues(`${base}ACCESS_AUD=${AUD}\n`)).toEqual({
      problems: [
        "ACCESS_TEAM_DOMAIN がありません（owner のログインに要ります）",
        "OWNER_EMAILS がありません（owner のログインに要ります）",
      ],
    });
    for (const line of [
      "ACCESS_TEAM_DOMAIN=https://team.cloudflareaccess.com",
      "ACCESS_TEAM_DOMAIN=team.cloudflareaccess.com/",
      "ACCESS_AUD=a b",
      "OWNER_EMAILS=owner",
      "OWNER_EMAILS=a@example.com b@example.com",
      "OWNER_EMAILS=,",
    ]) {
      expect(readDeployValues(`${base}${OWNER_AUTH_ENV}${line}\n`), line).toHaveProperty(
        "problems",
      );
    }
  });

  it("R2_BUCKET_NAME があれば使う", () => {
    const result = readDeployValues(
      `WIKI_HOSTNAME=h.example\nD1_DATABASE_ID=${UUID}\nR2_BUCKET_NAME=files\n`,
    );
    expect(result).toMatchObject({ values: { r2BucketName: "files" } });
  });

  it("OAUTH_KV_NAMESPACE_ID があれば使い、32 桁の 16 進でなければ弾く", () => {
    const base = `WIKI_HOSTNAME=h.example\nD1_DATABASE_ID=${UUID}\n`;
    expect(readDeployValues(`${base}OAUTH_KV_NAMESPACE_ID=${KV_ID}\n`)).toMatchObject({
      values: { oauthKvNamespaceId: KV_ID },
      warnings: [NO_OWNER_AUTH_WARNING, OAUTH_WITHOUT_OWNER_WARNING],
    });
    for (const id of ["OAUTH_KV", UUID, `${KV_ID}0`]) {
      expect(readDeployValues(`${base}OAUTH_KV_NAMESPACE_ID=${id}\n`), id).toHaveProperty(
        "problems",
      );
    }
  });

  it("OAUTH_REDIRECT_URIS は空白を除いて並べ直し、https かループバックの http の正規化した URL だけを許す", () => {
    const base = `WIKI_HOSTNAME=h.example\nD1_DATABASE_ID=${UUID}\n`;
    expect(
      readDeployValues(
        `${base}OAUTH_REDIRECT_URIS= https://a.example/cb , http://127.0.0.1:8765/callback ,\n`,
      ),
    ).toMatchObject({
      values: { oauthRedirectUris: "https://a.example/cb,http://127.0.0.1:8765/callback" },
    });
    for (const uri of [
      "http://a.example/cb",
      "https://A.example/cb",
      "https://a.example",
      "https://a.example/x/../cb",
      "https://user@a.example/cb",
      "a.example/cb",
    ]) {
      expect(readDeployValues(`${base}OAUTH_REDIRECT_URIS=${uri}\n`), uri).toHaveProperty(
        "problems",
      );
    }
  });

  it("LINK_REWRITE_CRON は 5 フィールドの cron 式だけを許し、空なら使わない", () => {
    const base = `WIKI_HOSTNAME=h.example\nD1_DATABASE_ID=${UUID}\n`;
    expect(readDeployValues(base)).toMatchObject({ values: { linkRewriteCron: undefined } });
    expect(readDeployValues(`${base}LINK_REWRITE_CRON=\n`)).toMatchObject({
      values: { linkRewriteCron: undefined },
    });
    for (const [raw, expected] of [
      ["*/5 * * * *", "*/5 * * * *"],
      ["  *   * * *  * ", "* * * * *"],
      ["0 3 * * MON-FRI", "0 3 * * MON-FRI"],
      ['"0,30 */2 1-15 * *"', "0,30 */2 1-15 * *"],
    ] as const) {
      expect(readDeployValues(`${base}LINK_REWRITE_CRON=${raw}\n`), raw).toMatchObject({
        values: { linkRewriteCron: expected },
      });
    }
    for (const raw of [
      "* * * *",
      "* * * * * *",
      "every minute",
      "*/5 * * * *; * * * * *",
      "@daily",
    ]) {
      expect(readDeployValues(`${base}LINK_REWRITE_CRON=${raw}\n`), raw).toHaveProperty("problems");
    }
  });

  it("足りない必須の値をすべて挙げる。空の値は無いものとして扱う", () => {
    expect(readDeployValues("")).toEqual({
      problems: ["WIKI_HOSTNAME がありません", "D1_DATABASE_ID がありません"],
    });
    expect(readDeployValues("WIKI_HOSTNAME=h.example\nD1_DATABASE_ID=  \n")).toEqual({
      problems: ["D1_DATABASE_ID がありません"],
    });
  });

  it("スキームやパスを含むホスト名と、UUID でない D1_DATABASE_ID を弾く", () => {
    for (const hostname of ["https://wiki.example.com", "wiki.example.com/", "a b", "-x.example"]) {
      expect(
        readDeployValues(`WIKI_HOSTNAME=${hostname}\nD1_DATABASE_ID=${UUID}\n`),
      ).toHaveProperty("problems");
    }
    expect(readDeployValues("WIKI_HOSTNAME=h.example\nD1_DATABASE_ID=abc\n")).toHaveProperty(
      "problems",
    );
  });

  it("先頭の BOM を無視し、未知のキーは警告する", () => {
    const result = readDeployValues(
      `\uFEFFWIKI_HOSTNAME=h.example\nD1_DATABASE_ID=${UUID}\nR2_BUCKET=typo\n`,
    );
    expect(result).toMatchObject({
      values: { hostname: "h.example" },
      warnings: ["未知のキー R2_BUCKET は使われません", NO_OAUTH_WARNING, NO_OWNER_AUTH_WARNING],
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

  it("r2BucketName が無ければ BUCKET を外し、他の R2 binding は残す。無くなれば r2_buckets ごと外す", () => {
    const config = composeConfig(BASE, { ...VALUES, r2BucketName: undefined });
    expect(config).not.toHaveProperty("r2_buckets");
    const withOther = {
      ...BASE,
      r2_buckets: [...BASE.r2_buckets, { binding: "OTHER", bucket_name: "o" }],
    };
    expect(composeConfig(withOther, { ...VALUES, r2BucketName: undefined }).r2_buckets).toEqual([
      { binding: "OTHER", bucket_name: "o" },
    ]);
    expect(() =>
      composeConfig({ ...BASE, r2_buckets: [] }, { ...VALUES, r2BucketName: undefined }),
    ).not.toThrow();
  });

  it("oauthKvNamespaceId があれば OAUTH_KV に id を入れ、無ければ OAUTH_KV を外す", () => {
    expect(composeConfig(BASE, VALUES).kv_namespaces).toEqual([{ binding: "OAUTH_KV", id: KV_ID }]);
    expect(composeConfig(BASE, { ...VALUES, oauthKvNamespaceId: undefined })).not.toHaveProperty(
      "kv_namespaces",
    );
    const withOther = { ...BASE, kv_namespaces: [...BASE.kv_namespaces, { binding: "OTHER" }] };
    expect(
      composeConfig(withOther, { ...VALUES, oauthKvNamespaceId: undefined }).kv_namespaces,
    ).toEqual([{ binding: "OTHER" }]);
  });

  it("入力を書き換えない", () => {
    const before = structuredClone(BASE);
    composeConfig(BASE, VALUES);
    expect(BASE).toEqual(before);
  });

  it("owner のログインの値は指定されたときだけ vars に入れ、既存の vars は残す", () => {
    expect(composeConfig(BASE, VALUES)).not.toHaveProperty("vars");
    const ownerAuth = { teamDomain: "t.example", audience: AUD, ownerEmails: "a@example.com" };
    const config = composeConfig({ ...BASE, vars: { OTHER: "x" } }, { ...VALUES, ownerAuth });
    expect(config.vars).toEqual({
      OTHER: "x",
      ACCESS_TEAM_DOMAIN: "t.example",
      ACCESS_AUD: AUD,
      OWNER_EMAILS: "a@example.com",
    });
  });

  it("oauthRedirectUris は指定されたときだけ vars の OAUTH_REDIRECT_URIS に入れる", () => {
    const config = composeConfig(BASE, { ...VALUES, oauthRedirectUris: "https://a.example/cb" });
    expect(config.vars).toEqual({ OAUTH_REDIRECT_URIS: "https://a.example/cb" });
  });

  it("linkRewriteCron は triggers.crons に入れ、無ければ空の配列で deploy 済みの Cron を外す", () => {
    expect(composeConfig(BASE, { ...VALUES, linkRewriteCron: "*/5 * * * *" }).triggers).toEqual({
      crons: ["*/5 * * * *"],
    });
    expect(composeConfig(BASE, VALUES).triggers).toEqual({ crons: [] });
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
    expect(() => composeConfig({ ...BASE, kv_namespaces: [] }, VALUES)).toThrow(/"OAUTH_KV"/);
  });
});

describe("writeGeneratedConfig", () => {
  const setup = (envText: string | undefined, baseText = JSON.stringify(BASE)) => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-config-"));
    const envPath = join(dir, "deploy.env");
    const basePath = join(dir, "wrangler.jsonc");
    const outPath = join(dir, "out.json");
    if (envText !== undefined) writeFileSync(envPath, envText);
    writeFileSync(basePath, baseText);
    const warnings: string[] = [];
    return { envPath, basePath, outPath, warn: (m: string) => warnings.push(m), warnings };
  };

  it("合成した設定を outPath に書き、そのパスを返す", () => {
    const opts = setup(`WIKI_HOSTNAME=h.example\nD1_DATABASE_ID=${UUID}\nX=1\n${OWNER_AUTH_ENV}`);
    expect(writeGeneratedConfig(opts)).toBe(opts.outPath);
    const written = JSON.parse(readFileSync(opts.outPath, "utf8"));
    expect(written.routes[0].pattern).toBe("h.example");
    expect(written).not.toHaveProperty("r2_buckets");
    expect(written.vars.ACCESS_AUD).toBe(AUD);
    expect(written).not.toHaveProperty("kv_namespaces");
    expect(opts.warnings).toHaveLength(2);
    expect(opts.warnings[0]).toContain(opts.envPath);
  });

  it("deploy.env が無い・値が足りない・形式が誤りのとき、パスと内容を含む例外にする", () => {
    const none = setup(undefined);
    expect(() => writeGeneratedConfig(none)).toThrow(none.envPath);
    const missing = setup("WIKI_HOSTNAME=h.example\n");
    expect(() => writeGeneratedConfig(missing)).toThrow(/D1_DATABASE_ID がありません/);
    expect(() => writeGeneratedConfig(missing)).toThrow(missing.envPath);
  });

  it("wrangler.jsonc が壊れているとき、そのパスを含む例外にする", () => {
    const opts = setup(`WIKI_HOSTNAME=h.example\nD1_DATABASE_ID=${UUID}\n`, "{ not json");
    expect(() => writeGeneratedConfig(opts)).toThrow(opts.basePath);
  });

  it("生成物は wrangler.jsonc と同じディレクトリにある（main と migrations_dir の相対パスのため）", () => {
    expect(dirname(GENERATED_CONFIG_PATH)).toBe(dirname(BASE_CONFIG_PATH));
  });
});

describe("extraArgs", () => {
  it("pnpm が渡す先頭の -- だけを除く", () => {
    expect(extraArgs(["--", "--dry-run"])).toEqual(["--dry-run"]);
    expect(extraArgs(["--dry-run", "--", "x"])).toEqual(["--dry-run", "--", "x"]);
    expect(extraArgs([])).toEqual([]);
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
