import { handleMcpPayload } from "@src/app/mcp/mcp-protocol.ts";
import type { McpContext } from "@src/app/mcp/mcp-tools.ts";

/**
 * MCP Streamable HTTP（无状态）：
 *  - POST /mcp：JSON-RPC 请求，返回 application/json；仅通知/响应时返回 202。
 *  - GET /mcp：不提供服务端推送流，返回 405。
 * 认证由调用方（server.ts）通过 Bearer SERVER_API_KEY 完成。
 */
export async function handleMcpHttpRequest(
  req: Request,
  ctxFactory: () => Promise<McpContext>,
): Promise<Response> {
  if (req.method === "GET" || req.method === "DELETE") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      { status: 400 },
    );
  }
  const response = await handleMcpPayload(payload, ctxFactory);
  if (response === null) return new Response(null, { status: 202 });
  return Response.json(response, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
