import { getAppConfig } from "@src/utils/config/app-config.ts";
import { resolveWeixinPublishAccount } from "@src/utils/config/define-config.ts";
import {
  getSecretsService,
  SecretsError,
} from "@src/app/secrets/secrets-service.ts";
import {
  testLlmConnection,
  testWeixinConnection,
} from "@src/app/secrets/connection-tests.ts";
import { redactSensitiveText } from "@src/utils/security/redact.ts";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** 是否为本机回环地址（或显式信任的地址，如 Docker 端口映射网关）。 */
export function isTrustedLocalAddress(
  ip: string | undefined,
  extraAllowed: string[] = [],
): boolean {
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/i, "").replace(/^\[|\]$/g, "");
  if (normalized === "::1" || /^127\./.test(normalized)) return true;
  return extraAllowed.includes(normalized);
}

export function bootstrapAllowedIps(): string[] {
  try {
    return (Deno.env.get("BOOTSTRAP_ALLOWED_IPS") ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 密钥设置 API：
 *  GET  /api/secrets/bootstrap-status   公开：是否需要初始化、当前请求是否来自本机
 *  POST /api/secrets/bootstrap          仅初始化阶段 + 仅本机：设置管理员 key
 *  GET  /api/secrets                    Bearer：字段状态（密钥只返回是否已配置）
 *  PUT  /api/secrets                    Bearer：{ values: { NAME: string|null } }
 *  POST /api/secrets/admin-key          Bearer：{ newAdminKey } 轮换管理员 key
 *  POST /api/secrets/test/weixin|llm    Bearer：只读连接测试
 *  GET  /api/secrets/audit              Bearer：审计日志（不含值）
 */
export async function handleSecretsRequest(
  req: Request,
  url: URL,
  clientIp: string | undefined,
  verifyAuth: (req: Request) => Promise<Response | null>,
): Promise<Response> {
  const service = getSecretsService();
  if (!service) return json({ error: "密钥存储未初始化" }, 503);
  const local = isTrustedLocalAddress(clientIp, bootstrapAllowedIps());
  const path = url.pathname;

  try {
    if (req.method === "GET" && path === "/api/secrets/bootstrap-status") {
      return json({
        bootstrapRequired: service.isBootstrapRequired(),
        clientIsLocal: local,
        clientIp: clientIp ?? null,
      });
    }
    if (req.method === "POST" && path === "/api/secrets/bootstrap") {
      if (!service.isBootstrapRequired()) {
        return json({ error: "已完成初始化，请使用管理员 key 登录" }, 409);
      }
      if (!local) {
        return json(
          { error: "初始化只能在服务器本机（127.0.0.1）上进行" },
          403,
        );
      }
      const body = await req.json().catch(() => ({})) as { adminKey?: string };
      await service.bootstrap(String(body.adminKey ?? ""), `local:${clientIp}`);
      return json({ ok: true });
    }
    if (service.isBootstrapRequired()) {
      return json({
        error: "请先在本机完成初始化（设置管理员 key）",
        code: "bootstrap_required",
      }, 403);
    }
    const unauthorized = await verifyAuth(req);
    if (unauthorized) return unauthorized;
    const actor = `admin@${clientIp ?? "unknown"}`;

    if (req.method === "GET" && path === "/api/secrets") {
      return json({
        fields: await service.list(),
        keySource: service.keySource,
      });
    }
    if (req.method === "PUT" && path === "/api/secrets") {
      const body = await req.json().catch(() => ({})) as {
        values?: Record<string, unknown>;
      };
      if (!body.values || typeof body.values !== "object") {
        return json({ error: "values 必填" }, 400);
      }
      const updated = await service.update(body.values, actor);
      return json({ ok: true, updated, fields: await service.list() });
    }
    if (req.method === "POST" && path === "/api/secrets/admin-key") {
      const body = await req.json().catch(() => ({})) as {
        newAdminKey?: string;
      };
      await service.rotateAdminKey(String(body.newAdminKey ?? ""), actor);
      return json({
        ok: true,
        message: "管理员 key 已更新，请用新 key 重新登录",
      });
    }
    if (req.method === "POST" && path === "/api/secrets/test/weixin") {
      const config = await getAppConfig();
      const account = resolveWeixinPublishAccount(
        config.providers.publish.weixin,
        config.features.article.publisher.accountId,
      );
      const result = await testWeixinConnection(
        account?.account.appId,
        account?.account.appSecret,
      );
      await service.recordTest("test_weixin", actor, result.ok);
      return json(result);
    }
    if (req.method === "POST" && path === "/api/secrets/test/llm") {
      const config = await getAppConfig();
      const result = await testLlmConnection(
        config.providers.ai.baseUrl,
        config.providers.ai.apiKey,
        config.providers.ai.model,
      );
      await service.recordTest("test_llm", actor, result.ok);
      return json(result);
    }
    if (req.method === "GET" && path === "/api/secrets/audit") {
      return json({ entries: await service.readAudit(200) });
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof SecretsError) {
      return json({ error: error.message }, error.status);
    }
    return json({
      error: redactSensitiveText(
        error instanceof Error ? error.message : String(error),
      ),
    }, 500);
  }
}
