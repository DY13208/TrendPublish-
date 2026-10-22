import type { WeixinFreePublishStatus } from "@src/core/ports/content-publisher.ts";
import type { INotifier } from "@src/core/ports/notifier.ts";
import type {
  PublishRecord,
  PublishRecordStore,
} from "@src/core/ports/publish-record-store.ts";
import { redactSensitiveText } from "@src/utils/security/redact.ts";
import {
  assertPublishEnabled,
  isPublishEnabled,
} from "@src/utils/security/publish-guard.ts";
import { Logger } from "@zilla/logger";

const logger = new Logger("freepublish");

export interface FreePublishClient {
  submitFreePublish(
    mediaId: string,
  ): Promise<{ publishId: string; msgDataId?: string }>;
  getFreePublishStatus(publishId: string): Promise<WeixinFreePublishStatus>;
}

export interface FreePublishOptions {
  now?: () => Date;
  /** 首次轮询延迟与退避基数。 */
  baseDelayMs?: number;
  /** 单次轮询最大间隔。 */
  maxDelayMs?: number;
  /** 最大轮询次数，超过后标记 failed（保留 publish_id，可通过重放恢复）。 */
  maxPollAttempts?: number;
}

export const FREEPUBLISH_STATUS_TEXT: Record<number, string> = {
  0: "发布成功",
  1: "发布中",
  2: "原创声明失败",
  3: "常规失败",
  4: "平台审核不通过",
  5: "发布成功后用户删除",
  6: "发布成功后被系统封禁",
};

const WEIXIN_ERRCODE_TEXT: Record<number, string> = {
  40001: "AppSecret 错误或 access_token 无效",
  40125: "AppSecret 无效",
  40164: "调用 IP 不在公众号 IP 白名单中",
  41001: "缺少 access_token",
  42001: "access_token 已过期",
  45009: "接口调用超过每日限额",
  48001: "公众号未获得该接口权限（需已认证的公众号/服务号）",
  53503: "草稿未通过发布检查",
  53504: "需前往公众平台官网使用该草稿",
  53505: "请手动保存成功后再发表",
};

export function describeWeixinError(error: unknown): {
  message: string;
  errcode?: number;
  definitive: boolean;
} {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(/微信 API 错误 (-?\d+)/);
  const errcode = match ? Number(match[1]) : undefined;
  const hint = errcode !== undefined ? WEIXIN_ERRCODE_TEXT[errcode] : undefined;
  return {
    message: redactSensitiveText(hint ? `${raw}（${hint}）` : raw).slice(
      0,
      800,
    ),
    errcode,
    // 微信明确返回 errcode 说明请求被拒绝，没有产生发布；网络错误/超时则结果未知。
    definitive: errcode !== undefined && errcode !== -1,
  };
}

export class SubmitStateUnknownError extends Error {
  constructor(taskId: string) {
    super(
      `任务 ${taskId} 曾发起 freepublish/submit 但结果未知，为避免同一草稿被提交两次已停止自动提交。请到公众号后台“发表记录”核对：确认未发表后，调用重放接口并传 confirmNotSubmitted=true。`,
    );
    this.name = "SubmitStateUnknownError";
  }
}

export class ReplayConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayConflictError";
  }
}

export interface ReplayOutcome {
  action:
    | "noop"
    | "submitted"
    | "polled"
    | "recovered"
    | "still_failed";
  record: PublishRecord | null;
  message: string;
}

export class FreePublishService {
  private readonly now: () => Date;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxPollAttempts: number;

  constructor(
    private readonly store: PublishRecordStore,
    private readonly client: FreePublishClient,
    private readonly notifier?: Pick<INotifier, "error" | "success">,
    options: FreePublishOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.baseDelayMs = options.baseDelayMs ?? 15_000;
    this.maxDelayMs = options.maxDelayMs ?? 10 * 60_000;
    this.maxPollAttempts = options.maxPollAttempts ?? 40;
  }

  /** 对 draft_created 记录发起正式发布。幂等：同一 media_id 最多提交一次。 */
  async submit(taskId: string): Promise<PublishRecord> {
    assertPublishEnabled("freepublish/submit");
    const record = await this.requireRecord(taskId);
    if (record.status === "published" || record.status === "submitted") {
      return record;
    }
    if (record.status !== "draft_created" || !record.mediaId) {
      throw new ReplayConflictError(
        `任务 ${taskId} 当前状态 ${record.status}，没有可提交的草稿`,
      );
    }
    if (record.submitStartedAt && !record.freepublishId) {
      await this.store.transition(taskId, ["draft_created"], "failed", {
        lastError: "freepublish/submit 结果未知",
      });
      await this.alert(record, "提交结果未知，已停止自动提交，需人工核对");
      throw new SubmitStateUnknownError(taskId);
    }
    const claimed = await this.store.claimSubmit(
      taskId,
      this.now().toISOString(),
    );
    if (!claimed) {
      const latest = await this.requireRecord(taskId);
      if (latest.status === "submitted" || latest.status === "published") {
        return latest;
      }
      throw new SubmitStateUnknownError(taskId);
    }

    let publishId: string;
    try {
      ({ publishId } = await this.client.submitFreePublish(record.mediaId));
    } catch (error) {
      const info = describeWeixinError(error);
      await this.store.transition(taskId, ["draft_created"], "failed", {
        lastError: info.message,
        // 微信明确拒绝 -> 未产生发布，可安全重试；否则保留提交标记，禁止自动重提。
        submitStartedAt: info.definitive ? null : undefined,
        incrementAttempts: true,
      });
      await this.alert(
        record,
        `freepublish/submit 失败：${info.message}${
          info.definitive ? "" : "（结果未知，已禁止自动重提）"
        }`,
      );
      throw error;
    }

    await this.store.transition(taskId, ["draft_created"], "submitted", {
      freepublishId: publishId,
      publishStatusCode: 1,
      pollAttempts: 0,
      nextPollAt: this.after(this.baseDelayMs),
      lastError: null,
      incrementAttempts: true,
    });
    logger.info(`[正式发布] 任务 ${taskId} 已提交，publish_id=${publishId}`);
    return await this.requireRecord(taskId);
  }

  /** 轮询一条 submitted 记录。 */
  async pollOnce(taskId: string): Promise<PublishRecord> {
    const record = await this.requireRecord(taskId);
    if (record.status !== "submitted" || !record.freepublishId) return record;
    const attempts = record.pollAttempts + 1;
    let status: WeixinFreePublishStatus;
    try {
      status = await this.client.getFreePublishStatus(record.freepublishId);
    } catch (error) {
      const info = describeWeixinError(error);
      if (attempts >= this.maxPollAttempts) {
        await this.store.transition(taskId, ["submitted"], "failed", {
          pollAttempts: attempts,
          nextPollAt: null,
          lastError: `轮询失败次数过多：${info.message}`,
        });
        await this.alert(record, `发布状态查询多次失败：${info.message}`);
      } else {
        await this.store.update(taskId, ["submitted"], {
          pollAttempts: attempts,
          nextPollAt: this.after(this.backoff(attempts)),
          lastError: info.message,
        });
      }
      return await this.requireRecord(taskId);
    }
    await this.applyStatus(record, status, attempts, ["submitted"]);
    return await this.requireRecord(taskId);
  }

  /** 轮询所有到期记录（由定时任务调用，状态持久化，重启后继续）。 */
  async pollDue(limit = 10): Promise<PublishRecord[]> {
    if (!isPublishEnabled()) return [];
    const due = await this.store.listDueForPolling(
      this.now().toISOString(),
      limit,
    );
    const results: PublishRecord[] = [];
    for (const record of due) {
      try {
        results.push(await this.pollOnce(record.taskId));
      } catch (error) {
        logger.warn(
          `[正式发布] 轮询 ${record.taskId} 异常: ${
            redactSensitiveText(error instanceof Error ? error.message : error)
          }`,
        );
      }
    }
    return results;
  }

  /**
   * 安全的人工重放：
   * - published：不做任何事；
   * - submitted：立即查询一次状态；
   * - failed 且已有 publish_id：先 freepublish/get 查状态再决定，不会重新提交；
   * - draft_created / failed 且只有草稿：若曾发起提交但结果未知，必须 confirmNotSubmitted=true 才会重新提交；
   * - 没有草稿：需要重新运行工作流（草稿创建本身已幂等）。
   */
  async replay(
    taskId: string,
    options: { confirmNotSubmitted?: boolean } = {},
  ): Promise<ReplayOutcome> {
    assertPublishEnabled("replay");
    const record = await this.requireRecord(taskId);
    if (record.status === "published") {
      return { action: "noop", record, message: "已发布，无需重放" };
    }
    if (record.status === "submitted") {
      const polled = await this.pollOnce(taskId);
      return { action: "polled", record: polled, message: "已查询发布状态" };
    }
    if (record.freepublishId) {
      const status = await this.client.getFreePublishStatus(
        record.freepublishId,
      );
      await this.applyStatus(record, status, record.pollAttempts + 1, [
        "failed",
      ]);
      const latest = await this.requireRecord(taskId);
      return {
        action: latest.status === "failed" ? "still_failed" : "recovered",
        record: latest,
        message: `freepublish/get: ${
          FREEPUBLISH_STATUS_TEXT[status.publish_status] ??
            status.publish_status
        }`,
      };
    }
    if (!record.mediaId) {
      throw new ReplayConflictError(
        "草稿尚未创建成功，请重新运行工作流（草稿创建已按 taskId 幂等）",
      );
    }
    if (record.submitStartedAt && !options.confirmNotSubmitted) {
      throw new ReplayConflictError(
        "该草稿曾发起提交但结果未知。请先在公众号后台确认未发表，再传 confirmNotSubmitted=true 重放",
      );
    }
    if (record.status === "failed") {
      const reset = await this.store.transition(
        taskId,
        ["failed"],
        "draft_created",
        { submitStartedAt: null, lastError: null },
      );
      if (!reset) throw new ReplayConflictError("状态已变化，请刷新后重试");
    } else if (options.confirmNotSubmitted && record.submitStartedAt) {
      await this.store.update(taskId, ["draft_created"], {
        submitStartedAt: null,
      });
    }
    const submitted = await this.submit(taskId);
    return { action: "submitted", record: submitted, message: "已重新提交" };
  }

  private async applyStatus(
    record: PublishRecord,
    status: WeixinFreePublishStatus,
    attempts: number,
    from: Array<"submitted" | "failed">,
  ): Promise<void> {
    const code = Number(status.publish_status);
    const text = FREEPUBLISH_STATUS_TEXT[code] ?? `未知状态 ${code}`;
    if (code === 0) {
      if (from.includes("failed")) {
        await this.store.transition(record.taskId, ["failed"], "submitted", {});
      }
      await this.store.transition(record.taskId, ["submitted"], "published", {
        publishStatusCode: 0,
        pollAttempts: attempts,
        nextPollAt: null,
        articleId: status.article_id,
        articleUrl: status.article_detail?.item?.[0]?.article_url,
        lastError: null,
      });
      logger.info(`[正式发布] 任务 ${record.taskId} 发布成功`);
      await this.notifier?.success(
        "公众号文章发布成功",
        redactSensitiveText(
          `${record.title}\n${
            status.article_detail?.item?.[0]?.article_url ?? ""
          }`,
        ),
      ).catch(() => false);
      return;
    }
    if (code === 1) {
      if (from.includes("failed")) {
        await this.store.transition(record.taskId, ["failed"], "submitted", {
          publishStatusCode: 1,
          pollAttempts: 0,
          nextPollAt: this.after(this.baseDelayMs),
          lastError: null,
        });
        return;
      }
      if (attempts >= this.maxPollAttempts) {
        await this.store.transition(record.taskId, ["submitted"], "failed", {
          publishStatusCode: 1,
          pollAttempts: attempts,
          nextPollAt: null,
          lastError: "发布状态长时间为“发布中”，轮询超时",
        });
        await this.alert(record, "轮询超时：微信长时间返回“发布中”");
        return;
      }
      await this.store.update(record.taskId, ["submitted"], {
        publishStatusCode: 1,
        pollAttempts: attempts,
        nextPollAt: this.after(this.backoff(attempts)),
      });
      return;
    }
    const failIdx = status.fail_idx?.length
      ? status.fail_idx.join(",")
      : undefined;
    const reason = `${text}${
      failIdx ? `（失败文章序号 fail_idx=${failIdx}）` : ""
    }`;
    if (from.includes("submitted")) {
      await this.store.transition(record.taskId, ["submitted"], "failed", {
        publishStatusCode: code,
        pollAttempts: attempts,
        nextPollAt: null,
        failIdx,
        lastError: reason,
      });
    } else {
      await this.store.update(record.taskId, ["failed"], {
        publishStatusCode: code,
        failIdx,
        lastError: reason,
      });
    }
    await this.alert(record, `正式发布失败：${reason}`);
  }

  private backoff(attempts: number): number {
    return Math.min(
      this.baseDelayMs * 2 ** Math.max(0, attempts - 1),
      this.maxDelayMs,
    );
  }

  private after(ms: number): string {
    return new Date(this.now().getTime() + ms).toISOString();
  }

  private async requireRecord(taskId: string): Promise<PublishRecord> {
    const record = await this.store.get(taskId);
    if (!record) throw new ReplayConflictError(`发布记录不存在: ${taskId}`);
    return record;
  }

  private async alert(record: PublishRecord, detail: string): Promise<void> {
    const content = redactSensitiveText(
      [
        `任务: ${record.taskId}`,
        `账号: ${record.accountId}`,
        `标题: ${record.title}`,
        record.mediaId ? `草稿 media_id: ${record.mediaId}` : "",
        record.freepublishId ? `publish_id: ${record.freepublishId}` : "",
        `详情: ${detail}`,
      ].filter(Boolean).join("\n"),
    );
    logger.error(`[发布告警] ${content.replace(/\n/g, " | ")}`);
    try {
      await this.notifier?.error("公众号发布失败告警", content);
    } catch {
      // 告警失败不影响主流程。
    }
  }
}
