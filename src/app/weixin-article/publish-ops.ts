import { isPublishEnabled } from "@src/utils/security/publish-guard.ts";
import type { ResolvedTrendPublishConfig } from "@src/utils/config/define-config.ts";
import { createPublisher } from "@src/app/weixin-article/create-weixin-article-dependencies.ts";
import { createArticleNotifier } from "@src/app/weixin-article/notifications.ts";
import { SQLitePublishRecordStore } from "@src/platform/local/sqlite-publish-record-store.ts";
import { FreePublishService } from "@src/features/weixin-article/services/freepublish.service.ts";
import type { PublishRecordStore } from "@src/core/ports/publish-record-store.ts";

let sharedStore: SQLitePublishRecordStore | undefined;

export function getLocalPublishRecordStore(
  config: ResolvedTrendPublishConfig,
): PublishRecordStore {
  sharedStore ??= new SQLitePublishRecordStore(
    config.storage.runtimeConfig.sqlitePath,
  );
  return sharedStore;
}

/** 为指定账号创建正式发布服务（发布器只在实际调用时才会请求微信）。 */
export function createFreePublishService(
  config: ResolvedTrendPublishConfig,
  accountId?: string,
): FreePublishService | null {
  const publisher = createPublisher(
    config,
    accountId && accountId !== "default" ? accountId : undefined,
  );
  if (!publisher.submitFreePublish || !publisher.getFreePublishStatus) {
    return null;
  }
  return new FreePublishService(
    getLocalPublishRecordStore(config),
    {
      submitFreePublish: (id) => publisher.submitFreePublish!(id),
      getFreePublishStatus: (id) => publisher.getFreePublishStatus!(id),
    },
    createArticleNotifier(config),
  );
}

/** 定时轮询到期的 submitted 记录（状态持久化在 SQLite，重启后继续）。 */
export async function pollDuePublishRecords(
  config: ResolvedTrendPublishConfig,
  limit = 20,
): Promise<number> {
  if (!isPublishEnabled()) return 0;
  const store = getLocalPublishRecordStore(config);
  const due = await store.listDueForPolling(new Date().toISOString(), limit);
  const services = new Map<string, FreePublishService | null>();
  let polled = 0;
  for (const record of due) {
    if (!services.has(record.accountId)) {
      services.set(
        record.accountId,
        createFreePublishService(config, record.accountId),
      );
    }
    const service = services.get(record.accountId);
    if (!service) continue;
    await service.pollOnce(record.taskId);
    polled++;
  }
  return polled;
}
