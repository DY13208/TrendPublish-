import { useEffect, useState } from "react";
import { Button, Card, Input } from "./ui.tsx";
import { generateStrongKey } from "../pages/secrets.tsx";

interface BootstrapStatus {
  bootstrapRequired: boolean;
  clientIsLocal: boolean;
}

export function LoginView(
  { onLogin, error }: { onLogin: (apiKey: string) => void; error?: string },
) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [adminKey, setAdminKey] = useState("");
  const [confirmKey, setConfirmKey] = useState("");
  const [setupError, setSetupError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/secrets/bootstrap-status")
      .then((r) => r.ok ? r.json() : null)
      .then((s) => setStatus(s))
      .catch(() => setStatus(null));
  }, []);

  async function bootstrap() {
    setSetupError("");
    if (adminKey !== confirmKey) {
      setSetupError("两次输入不一致");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/secrets/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminKey }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      onLogin(adminKey);
    } catch (e) {
      setSetupError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  if (status?.bootstrapRequired) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f8fafc] px-4">
        <Card className="w-full max-w-md p-6">
          <div className="mb-4">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-[#f38020]">
              TrendPublish
            </div>
            <h1 className="tp-title text-2xl font-semibold">
              首次初始化：设置管理员 key
            </h1>
            <p className="tp-muted mt-2 text-sm leading-6">
              当前管理员 key
              为空或仍是占位值，所有接口已锁定。请先设置一个强管理员
              key（用于登录控制台、API 和 MCP）。 初始化只能在服务器本机上进行。
            </p>
          </div>
          {!status.clientIsLocal
            ? (
              <div className="tp-danger rounded-md border p-3 text-sm">
                当前访问不是来自服务器本机，无法初始化。请在服务器上打开
                http://127.0.0.1:18600/dashboard 。
              </div>
            )
            : (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  bootstrap();
                }}
              >
                <Input
                  type="text"
                  autoComplete="off"
                  value={adminKey}
                  placeholder="管理员 key（≥24 位，含 3 类字符）"
                  onChange={(e) => setAdminKey(e.currentTarget.value)}
                />
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={confirmKey}
                  placeholder="再次输入确认"
                  onChange={(e) => setConfirmKey(e.currentTarget.value)}
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={() => {
                      const k = generateStrongKey();
                      setAdminKey(k);
                      setConfirmKey(k);
                    }}
                  >
                    生成随机 key
                  </Button>
                  <Button
                    className="flex-1"
                    variant="primary"
                    type="submit"
                    disabled={busy || !adminKey}
                  >
                    保存并进入
                  </Button>
                </div>
                <p className="tp-muted text-xs">
                  请先把 key 复制保存到密码管理器；保存后页面不会再显示它。
                </p>
                {setupError && (
                  <div className="tp-danger rounded-md border p-3 text-sm">
                    {setupError}
                  </div>
                )}
              </form>
            )}
        </Card>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#f8fafc] px-4">
      <Card className="w-full max-w-md p-6">
        <div className="mb-6">
          <div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-[#f38020]">
            TrendPublish
          </div>
          <h1 className="tp-title text-2xl font-semibold">
            TrendPublish 控制台
          </h1>
          <p className="tp-muted mt-2 text-sm leading-6">
            输入 API key 后查看运行记录、产物和配置。
          </p>
        </div>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) onLogin(value.trim());
          }}
        >
          <label className="space-y-2">
            <span className="tp-muted text-sm">API key</span>
            <Input
              type="password"
              autoFocus
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
              placeholder="Bearer token"
            />
          </label>
          {error && (
            <div className="tp-danger rounded-md border p-3 text-sm">
              {error}
            </div>
          )}
          <Button className="w-full" variant="primary" type="submit">
            进入控制台
          </Button>
        </form>
      </Card>
    </main>
  );
}
