import {
  MCP_TOOLS,
  type McpContext,
  McpToolError,
} from "@src/app/mcp/mcp-tools.ts";
import {
  redactSensitiveText,
  redactValue,
} from "@src/utils/security/redact.ts";
import { PublishDisabledError } from "@src/utils/security/publish-guard.ts";
import { Logger } from "@zilla/logger";

const logger = new Logger("mcp");

export const MCP_SUPPORTED_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];
export const MCP_SERVER_INFO = {
  name: "trendpublish",
  title: "TrendPublish 公众号发布",
  version: "0.1.0",
};

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const INSTRUCTIONS = [
  "TrendPublish 服务端只提供数据与关卡，写作由你（客户端模型）完成。推荐流程：",
  "1) trendpublish_get_writing_guidelines 读规范；2) trendpublish_fetch_hot_topics / trendpublish_score_topics 选题；",
  "3) trendpublish_dedup_check 去重；4) 自己写作后 trendpublish_submit_article（附来源与摘录、图片版权声明）；",
  "5) trendpublish_run_quality_gate，按 issues 修改后重新提交；6) 通过后 upload_image → create_draft → publish；",
  "7) trendpublish_get_status 查看进度。写操作受 PUBLISH_ENABLED / PUBLISH_MODE / 质量门禁 / 幂等约束，无法绕过。",
].join("\n");

function rpcError(
  id: JsonRpcResponse["id"],
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** 处理单条 JSON-RPC 消息；通知（无 id）返回 null。 */
export async function handleMcpMessage(
  message: unknown,
  ctxFactory: () => Promise<McpContext>,
): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "Invalid Request");
  }
  const request = message as JsonRpcRequest;
  const id = request.id ?? null;
  const isNotification = request.id === undefined;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return isNotification ? null : rpcError(id, -32600, "Invalid Request");
  }
  // 客户端回复（含 result/error 无 method）忽略
  if (isNotification) return null;

  switch (request.method) {
    case "initialize": {
      const requested = String(request.params?.protocolVersion ?? "");
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_SUPPORTED_VERSIONS.includes(requested)
            ? requested
            : MCP_SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: MCP_TOOLS.map((
            { name, title, description, inputSchema, annotations },
          ) => ({
            name,
            title,
            description,
            inputSchema,
            annotations,
          })),
        },
      };
    case "tools/call": {
      const name = String(request.params?.name ?? "");
      const tool = MCP_TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const ctx = await ctxFactory();
        const output = redactValue(await tool.handler(args, ctx));
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
            isError: false,
          },
        };
      } catch (error) {
        const expected = error instanceof McpToolError ||
          error instanceof PublishDisabledError;
        const text = redactSensitiveText(
          error instanceof Error ? error.message : String(error),
        );
        if (!expected) logger.warn(`[MCP] 工具 ${name} 执行失败: ${text}`);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }], isError: true },
        };
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${request.method}`);
  }
}

/** 处理单条或批量消息。 */
export async function handleMcpPayload(
  payload: unknown,
  ctxFactory: () => Promise<McpContext>,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    const responses = (await Promise.all(payload.map((m) =>
      handleMcpMessage(m, ctxFactory)
    )))
      .filter((r): r is JsonRpcResponse => r !== null);
    return responses.length ? responses : null;
  }
  return await handleMcpMessage(payload, ctxFactory);
}
