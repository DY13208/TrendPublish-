import { WeixinApiClient } from "@src/integrations/publish/providers/weixin-api-client.ts";
import { redactSensitiveText } from "@src/utils/security/redact.ts";

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  errcode?: number;
  detail?: Record<string, unknown>;
}

/** 只读：仅获取 access_token（不返回 token），不触发任何微信写操作。 */
export async function testWeixinConnection(
  appId: string | undefined,
  appSecret: string | undefined,
  client = new WeixinApiClient({ timeoutMs: 10000 }),
): Promise<ConnectionTestResult> {
  if (!appId || !appSecret) {
    return { ok: false, message: "AppID 或 AppSecret 未配置" };
  }
  try {
    const response = await client.getAccessToken(appId, appSecret);
    if (!response.access_token) {
      return { ok: false, message: "未返回 access_token" };
    }
    return {
      ok: true,
      message: "已成功获取 access_token（未保存、未返回）",
      detail: { expiresIn: response.expires_in },
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const errcode = Number(raw.match(/微信 API 错误 (-?\d+)/)?.[1] ?? NaN);
    const ipMatch = raw.match(/invalid ip ([0-9a-fA-F.:]+)/i);
    let message = redactSensitiveText(raw);
    if (errcode === 40164) {
      message = `调用 IP${
        ipMatch ? ` ${ipMatch[1]}` : ""
      } 不在公众号 IP 白名单中：请到 公众平台 → 设置与开发 → 基本配置 → IP白名单 添加该 IP 后重试。`;
    } else if (errcode === 40001 || errcode === 40125) {
      message = "AppSecret 错误或已重置，请核对后重新保存";
    } else if (errcode === 40013) {
      message = "AppID 无效，请核对";
    }
    return {
      ok: false,
      message,
      errcode: Number.isFinite(errcode) ? errcode : undefined,
      detail: ipMatch ? { callerIp: ipMatch[1] } : undefined,
    };
  }
}

/** 只读：GET {baseUrl}/models，不消耗生成 token。 */
export async function testLlmConnection(
  baseUrl: string | undefined,
  apiKey: string | undefined,
  model: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionTestResult> {
  if (!baseUrl || !apiKey) {
    return { ok: false, message: "Base URL 或 API Key 未配置" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: `认证失败（HTTP ${response.status}），请检查 API Key`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        message:
          `HTTP ${response.status}：该服务可能不支持 /models，或 Base URL 不正确`,
      };
    }
    const body = await response.json().catch(() => ({})) as {
      data?: Array<{ id?: string }>;
    };
    const ids = (body.data ?? []).map((m) => m.id).filter(Boolean) as string[];
    return {
      ok: true,
      message: `连接成功，可用模型 ${ids.length} 个${
        model
          ? (ids.includes(model)
            ? `，包含 ${model}`
            : `，未在列表中找到 ${model}（部分服务不完整列出）`)
          : ""
      }`,
      detail: {
        modelCount: ids.length,
        modelFound: model ? ids.includes(model) : undefined,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: redactSensitiveText(
        error instanceof Error && error.name === "AbortError"
          ? "连接超时（10 秒）"
          : String(error instanceof Error ? error.message : error),
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}
