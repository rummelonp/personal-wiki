import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import { type Scope, tokenHasScope } from "../auth/principal";
import type { PageWriteContext } from "../pages/operations";

/** tool がリクエストごとに受け取る値。principal は /mcp の認可で決まったもの。 */
export interface WikiToolContext extends PageWriteContext {
  /** URL を組み立てる origin。リクエストの URL から取る */
  origin: string;
}

export interface WikiToolDefinition<S extends z.ZodObject> {
  name: string;
  /**
   * 呼び出しに要る token の scope。/mcp は read で受け付けるので、write の tool は呼び出しのたびに
   * ここで判定し、足りなければ isError で返す。tools/list には scope に関係なく載せる。
   */
  scope: Scope;
  title: string;
  description: string;
  /** strictObject にして、visibility などの知らないキーを黙って捨てずに拒む */
  inputSchema: S;
  annotations: ToolAnnotations;
  run: (args: z.output<S>, ctx: WikiToolContext) => Promise<CallToolResult>;
}

export interface WikiTool {
  name: string;
  register: (server: McpServer, ctx: WikiToolContext) => void;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

type JsonSchemaOptions = Parameters<StandardSchemaWithJSON["~standard"]["jsonSchema"]["input"]>[0];

/**
 * SDK は tool を登録するたびに inputSchema を JSON Schema に変換する。zod の変換は重く、
 * リクエストごとに全 tool 分を繰り返すと CPU 時間を食うので、変換結果を初回だけ作って使い回す。
 * 共有する結果は凍結し、リクエストをまたいで書き換わらないようにする。SDK が書き換えると例外になるが、
 * SDK 側の catch で握られる経路があるので、例外で必ず気づけるわけではない（その場合は書き換えが無視される）。
 */
function memoizeJsonSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const std = schema["~standard"];
  const cache = new Map<string, Record<string, unknown>>();
  const convert = (io: "input" | "output") => (options: JsonSchemaOptions) => {
    const key = `${io}:${JSON.stringify(options)}`;
    let json = cache.get(key);
    if (json === undefined) {
      json = deepFreeze(std.jsonSchema[io](options));
      cache.set(key, json);
    }
    return json;
  };
  return {
    "~standard": {
      version: std.version,
      vendor: std.vendor,
      validate: (value) => std.validate(value),
      jsonSchema: { input: convert("input"), output: convert("output") },
    },
  };
}

const SDK_JSON_SCHEMA_TARGET = "draft-2020-12";

export function defineTool<S extends z.ZodObject>(definition: WikiToolDefinition<S>): WikiTool {
  const { name, scope, title, description, inputSchema, annotations, run } = definition;
  // 型引数 S のままでは SDK の overload を解決できないので、StandardSchemaWithJSON に包み、
  // 検証済みの args は S の出力型に戻す
  const schema = memoizeJsonSchema(inputSchema);
  // SDK が tools/list と登録で使う target を先に変換しておく。キーが外れても、初回の登録で変換するだけで結果は変わらない。
  // 変換が失敗してもモジュールの読み込みを止めない（REST と SPA まで起動しなくなる）。失敗は握り、
  // 初回の登録時に再度変換して、従来どおり SDK の経路で扱わせる
  try {
    schema["~standard"].jsonSchema.input({ target: SDK_JSON_SCHEMA_TARGET });
  } catch {}
  return {
    name,
    register(server, ctx) {
      server.registerTool(
        name,
        { title, description, inputSchema: schema, annotations },
        async (args) => {
          if (!tokenHasScope(ctx.principal, scope)) {
            return toolError({
              error: "forbidden",
              message: `この token には ${scope} の scope が無い`,
            });
          }
          try {
            return await run(args as z.output<S>, ctx);
          } catch (error) {
            // SDK は tool の例外を握り、message をそのまま isError で返す（onerror も呼ばない）。
            // D1 の例外文をクライアントに出さず、ログにだけ残す
            console.error(
              JSON.stringify({
                event: "mcp.tool_error",
                tool: name,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
            return toolError({ error: "internal_error" });
          }
        },
      );
    },
  };
}

export function toolResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/**
 * tool が返すエラーの本文は REST の応答本文と同じ形（`{ error, ... }`）にする。
 * inputSchema の検証エラーは tool に届く前に SDK が平文の isError で返すので、この形にならない。
 */
export function toolError(body: { error: string; [key: string]: unknown }): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}
