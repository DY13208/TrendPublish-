import { useCallback, useEffect, useState } from "react";
import { apiJson } from "../api/client.ts";
import { Badge, Button, Card, Input, SectionTitle } from "../components/ui.tsx";

interface SecretField {
  name: string;
  label: string;
  group: string;
  secret: boolean;
  configured: boolean;
  source: "store" | "env" | "none";
  value?: string;
  updatedAt?: string;
  hint?: string;
}

interface TestResult {
  ok: boolean;
  message: string;
  errcode?: number;
}

interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  field?: string;
  result?: string;
}

const GROUPS: Array<[string, string]> = [
  ["weixin", "微信公众号"],
  ["llm", "大模型（OpenAI 兼容）"],
  ["image", "图片生成"],
  ["embedding", "Embedding（去重）"],
  ["notify", "告警通知"],
];

export function generateStrongKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "");
  return `tp_${base.slice(0, 20)}-${base.slice(20, 40)}#9`;
}

export function SecretsPanel(
  { apiKey, onAdminKeyRotated }: {
    apiKey: string;
    onAdminKeyRotated: () => void;
  },
) {
  const [fields, setFields] = useState<SecretField[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, TestResult | undefined>>(
    {},
  );
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [newAdminKey, setNewAdminKey] = useState("");

  const load = useCallback(async () => {
    const [list, log] = await Promise.all([
      apiJson<{ fields: SecretField[] }>("/api/secrets", apiKey),
      apiJson<{ entries: AuditEntry[] }>("/api/secrets/audit", apiKey),
    ]);
    setFields(list.fields);
    setAudit(log.entries.slice(0, 30));
  }, [apiKey]);

  useEffect(() => {
    load().catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [load]);

  async function save(values: Record<string, string | null>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await apiJson<
        { updated: string[]; fields: SecretField[] }
      >(
        "/api/secrets",
        apiKey,
        { method: "PUT", body: JSON.stringify({ values }) },
      );
      setFields(result.fields);
      setDrafts({});
      setMessage(`已保存：${result.updated.join("、")}（已热更新，无需重启）`);
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function runTest(kind: "weixin" | "llm") {
    setTests((t) => ({ ...t, [kind]: { ok: false, message: "测试中…" } }));
    try {
      const result = await apiJson<TestResult>(
        `/api/secrets/test/${kind}`,
        apiKey,
        { method: "POST" },
      );
      setTests((t) => ({ ...t, [kind]: result }));
      await load();
    } catch (e) {
      setTests((t) => ({
        ...t,
        [kind]: {
          ok: false,
          message: String(e instanceof Error ? e.message : e),
        },
      }));
    }
  }

  async function rotate() {
    setBusy(true);
    setError("");
    try {
      await apiJson("/api/secrets/admin-key", apiKey, {
        method: "POST",
        body: JSON.stringify({ newAdminKey }),
      });
      setNewAdminKey("");
      alert("管理员 key 已更新。请妥善保存新 key，现在需要用新 key 重新登录。");
      onAdminKeyRotated();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  const pending = Object.entries(drafts).filter(([, v]) => v.trim() !== "");

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          title="密钥与连接"
          description="密钥字段只写不读：保存后页面只显示“已配置/未配置”，任何接口都不会返回明文。值加密保存在服务器 data/secrets 下，保存后立即热更新。"
          action={
            <Button
              variant="primary"
              disabled={busy || pending.length === 0}
              onClick={() => save(Object.fromEntries(pending))}
            >
              保存 {pending.length ? `(${pending.length})` : ""}
            </Button>
          }
        />
        {message && (
          <div className="tp-ok mb-3 p-2 text-sm">
            {message}
          </div>
        )}
        {error && (
          <div className="tp-danger mb-3 rounded-md border p-2 text-sm">
            {error}
          </div>
        )}
        <div className="space-y-5">
          {GROUPS.map(([group, title]) => (
            <div key={group}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-semibold">{title}</span>
                {group === "weixin" && (
                  <Button
                    size="sm"
                    onClick={() => runTest("weixin")}
                  >
                    测试连接（只读）
                  </Button>
                )}
                {group === "llm" && (
                  <Button
                    size="sm"
                    onClick={() => runTest("llm")}
                  >
                    测试连接（只读）
                  </Button>
                )}
              </div>
              {(group === "weixin" || group === "llm") && tests[group] && (
                <div
                  className={`mb-2 rounded-md border p-2 text-sm ${
                    tests[group]!.ok ? "tp-ok" : "tp-danger"
                  }`}
                >
                  {tests[group]!.message}
                </div>
              )}
              <div className="grid gap-2 md:grid-cols-2">
                {fields.filter((f) => f.group === group).map((field) => (
                  <label key={field.name} className="block space-y-1">
                    <span className="flex items-center gap-2 text-xs text-[#475569]">
                      {field.label}
                      <code className="text-[10px] text-[#94a3b8]">
                        {field.name}
                      </code>
                      <Badge tone={field.configured ? "success" : "muted"}>
                        {field.configured
                          ? (field.source === "store"
                            ? "已配置（页面）"
                            : "已配置（环境变量）")
                          : "未配置"}
                      </Badge>
                    </span>
                    <div className="flex gap-2 [&>*:first-child]:flex-1">
                      <Input
                        type={field.secret ? "password" : "text"}
                        autoComplete="new-password"
                        value={drafts[field.name] ?? ""}
                        placeholder={field.secret
                          ? (field.configured
                            ? "••••••（已配置，输入新值以替换）"
                            : "输入后保存")
                          : (field.value ?? field.hint ?? "")}
                        onChange={(e) => {
                          const value = e.currentTarget.value;
                          setDrafts((d) => ({ ...d, [field.name]: value }));
                        }}
                      />
                      {field.source === "store" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            if (
                              confirm(
                                `清除页面保存的 ${field.name}？（将回退到环境变量值，如有）`,
                              )
                            ) save({ [field.name]: null });
                          }}
                        >
                          清除
                        </Button>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle
          title="管理员 key（SERVER_API_KEY）轮换"
          description="用于登录控制台、API 与 MCP。轮换后旧 key 立即失效，MCP 客户端需同步更新。"
        />
        <div className="flex flex-wrap gap-2">
          <div className="min-w-[280px] flex-1">
            <Input
              type="text"
              autoComplete="off"
              value={newAdminKey}
              placeholder="至少 24 位，含大小写/数字/符号中 3 类"
              onChange={(e) => setNewAdminKey(e.currentTarget.value)}
            />
          </div>
          <Button onClick={() => setNewAdminKey(generateStrongKey())}>
            生成随机 key
          </Button>
          <Button
            variant="danger"
            disabled={busy || !newAdminKey}
            onClick={rotate}
          >
            轮换
          </Button>
        </div>
      </Card>

      <Card>
        <SectionTitle
          title="审计日志"
          description="记录谁在何时修改了哪个字段，不记录任何值。"
        />
        <div className="max-h-72 overflow-auto text-xs">
          <table className="w-full">
            <tbody>
              {audit.map((entry, index) => (
                <tr key={index} className="border-b border-[#f1f5f9]">
                  <td className="py-1 pr-3 text-[#64748b]">
                    {new Date(entry.at).toLocaleString("zh-CN")}
                  </td>
                  <td className="py-1 pr-3">{entry.actor}</td>
                  <td className="py-1 pr-3">{entry.action}</td>
                  <td className="py-1 pr-3">{entry.field ?? ""}</td>
                  <td className="py-1">{entry.result ?? ""}</td>
                </tr>
              ))}
              {audit.length === 0 && (
                <tr>
                  <td className="py-2 text-[#94a3b8]">暂无记录</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
