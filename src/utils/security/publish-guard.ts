/**
 * 全局发布总开关。
 *
 * PUBLISH_ENABLED 必须显式设置为 "true" 才允许任何微信写操作（草稿、素材、图片、发布）。
 * 默认关闭：此时所有工作流（包括 Dashboard 定时计划、forcePublish 请求）都强制 dry-run。
 */
export class PublishDisabledError extends Error {
  constructor(operation: string) {
    super(
      `PUBLISH_ENABLED 未开启，已阻止微信写操作: ${operation}。如需真实发布请显式设置 PUBLISH_ENABLED=true。`,
    );
    this.name = "PublishDisabledError";
  }
}

let override: boolean | undefined;

export function isPublishEnabled(): boolean {
  if (override !== undefined) return override;
  try {
    const value = (globalThis as { Deno?: typeof Deno }).Deno?.env?.get(
      "PUBLISH_ENABLED",
    );
    return value?.trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

export function assertPublishEnabled(operation: string): void {
  if (!isPublishEnabled()) throw new PublishDisabledError(operation);
}

/** 仅测试使用。传 undefined 恢复读取环境变量。 */
export function setPublishEnabledOverrideForTesting(value?: boolean): void {
  override = value;
}
