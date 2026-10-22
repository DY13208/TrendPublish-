/**
 * TrendPublish MCP stdio 入口（本地客户端直接拉起进程时使用）。
 *   deno run -A scripts/mcp-stdio.ts [--config path]
 * stdout 只输出 JSON-RPC 消息；日志全部写到 stderr。
 */
import {
  initializeAppConfig,
  parseConfigArgs,
} from "@src/utils/config/app-config.ts";
import { handleMcpPayload } from "@src/app/mcp/mcp-protocol.ts";
import { createDefaultMcpContext } from "@src/app/mcp/mcp-context.ts";
import type { McpContext } from "@src/app/mcp/mcp-tools.ts";
import {
  installConsoleRedaction,
  registerSecretsFromEnv,
  registerSecretsFromObject,
} from "@src/utils/security/redact.ts";

// 所有 console 输出改走 stderr，避免污染 stdio 协议通道。
for (const method of ["log", "info", "warn", "debug"] as const) {
  console[method] = (...args: unknown[]) => console.error(...args);
}
installConsoleRedaction();
registerSecretsFromEnv();

const parsed = parseConfigArgs(Deno.args);
const config = await initializeAppConfig({ configPath: parsed.configPath });
registerSecretsFromObject(config);
let ctx: McpContext | undefined;
const ctxFactory = () =>
  Promise.resolve(ctx ??= createDefaultMcpContext(config));

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk, { stream: true });
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      await Deno.stdout.write(encoder.encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }) + "\n",
      ));
      continue;
    }
    const response = await handleMcpPayload(payload, ctxFactory);
    if (response !== null) {
      await Deno.stdout.write(encoder.encode(JSON.stringify(response) + "\n"));
    }
  }
}
