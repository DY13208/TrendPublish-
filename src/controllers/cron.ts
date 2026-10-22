import { pollDuePublishRecords } from "@src/app/weixin-article/publish-ops.ts";
import cron from "npm:node-cron@3.0.3";
import { Logger } from "@zilla/logger";
import { isPublishEnabled } from "@src/utils/security/publish-guard.ts";
import { LocalWorkflowRuntime } from "@src/core/workflow/local-workflow-runtime.ts";
import {
  createLocalWeixinArticleWorkflowDefinition,
} from "@src/app/weixin-article/local-workflow.definition.ts";
import { getAppConfig } from "@src/utils/config/app-config.ts";
import { createArticleNotifier } from "@src/app/weixin-article/notifications.ts";
import { createLocalArticleRuntimeStores } from "@src/app/weixin-article/local-runtime-stores.ts";
import { seedArticleRuntimeConfig } from "@src/app/weixin-article/runtime/article-runtime-config.service.ts";
const logger = new Logger("cron");
export enum WorkflowType {
  WeixinArticle = "weixin-article-workflow",
}

export function getWorkflow(type: WorkflowType) {
  if (type !== WorkflowType.WeixinArticle) {
    throw new Error(`未知的工作流类型: ${type}`);
  }
  return createLocalWeixinArticleWorkflowDefinition();
}

export const startCronJobs = async () => {
  // 每次触发都重新读取配置，Dashboard 更新密钥后无需重启即可生效。
  createArticleNotifier(await getAppConfig()).notify(
    "定时任务启动",
    "定时任务启动",
  );
  logger.info("初始化定时任务...");

  // 正式发布状态轮询：每分钟检查到期的 submitted 记录（PUBLISH_ENABLED 未开启时不做任何事）。
  cron.schedule("* * * * *", async () => {
    try {
      const polled = await pollDuePublishRecords(await getAppConfig());
      if (polled > 0) logger.info(`[正式发布] 本轮轮询 ${polled} 条记录`);
    } catch (error) {
      logger.error("发布状态轮询失败:", error);
    }
  }, { timezone: "Asia/Shanghai" });

  // Heartbeat 调度：具体业务时间由 Dashboard runtime config 控制。
  cron.schedule(
    "*/5 * * * *",
    async () => {
      const config = await getAppConfig();
      const notifier = createArticleNotifier(config);
      try {
        logger.info("检查到期微信文章工作流...");
        const runtimeStores = createLocalArticleRuntimeStores(config);
        await seedArticleRuntimeConfig(
          runtimeStores.runtimeConfigStore,
          config,
        );
        const dueSchedules = await runtimeStores.runtimeConfigStore
          .listDueSchedules(new Date());
        const runtime = new LocalWorkflowRuntime();
        for (const due of dueSchedules) {
          if (
            !await runtimeStores.runtimeConfigStore.markScheduleTriggered(
              due.schedule.id,
              due.slot,
            )
          ) {
            continue;
          }
          const runId = `cron-${crypto.randomUUID()}`;
          await runtime.run(createLocalWeixinArticleWorkflowDefinition(), {
            payload: {
              runId,
              trigger: "cron",
              // PUBLISH_ENABLED 未开启时，所有计划强制 dry-run。
              dryRun: due.schedule.dryRun || !isPublishEnabled(),
              profileId: due.schedule.profileId,
            },
            id: runId,
            timestamp: Date.now(),
          });
        }
      } catch (error) {
        logger.error(`工作流执行失败:`, error);
        notifier.notify("工作流执行失败", String(error));
      }
    },
    {
      timezone: "Asia/Shanghai",
    },
  );
};
