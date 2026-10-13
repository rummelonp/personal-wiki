import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
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

export function defineTool<S extends z.ZodObject>(definition: WikiToolDefinition<S>): WikiTool {
  const { name, scope, title, description, inputSchema, annotations, run } = definition;
  return {
    name,
    register(server, ctx) {
      // 型引数 S のままでは SDK の overload を解決できないので、検証済みの args を S の出力型に戻す
      const schema: StandardSchemaWithJSON = inputSchema;
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

/** エラーの本文は REST の応答本文と同じ形（`{ error, ... }`）にする。 */
export function toolError(body: { error: string; [key: string]: unknown }): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}
