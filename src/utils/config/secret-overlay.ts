/**
 * 运行时密钥覆盖层：Dashboard 密钥设置页保存的值（解密后，仅在内存中）。
 * 配置解析时优先读取这里，再回退到 /run/secrets 与环境变量。
 */
let overlay = new Map<string, string>();

export function setSecretOverlay(values: Record<string, string>): void {
  overlay = new Map(
    Object.entries(values).filter(([, value]) =>
      typeof value === "string" && value !== ""
    ),
  );
}

export function getSecretOverlayValue(name: string): string | undefined {
  return overlay.get(name);
}

export function hasSecretOverlayValue(name: string): boolean {
  return overlay.has(name);
}
