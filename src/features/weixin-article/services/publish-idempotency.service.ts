import type {
  PublishRecord,
  PublishRecordStore,
} from "@src/core/ports/publish-record-store.ts";
import type { PublishResult } from "@src/core/ports/content-publisher.ts";
import { redactSensitiveText } from "@src/utils/security/redact.ts";
import { Logger } from "@zilla/logger";

const logger = new Logger("publish-idempotency");

export interface PublishTaskIdentity {
  taskId: string;
  accountId: string;
  businessKey: string;
  contentHash: string;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 生成确定性的 taskId：同一账号 + 同一业务键（默认取标题+正文的内容哈希）永远得到同一个 taskId。
 */
export async function computePublishTaskIdentity(input: {
  accountId?: string;
  title: string;
  content: string;
  businessKey?: string;
}): Promise<PublishTaskIdentity> {
  const accountId = input.accountId?.trim() || "default";
  const normalizedTitle = input.title.trim().replace(/\s+/g, " ");
  const contentHash = await sha256Hex(
    `${normalizedTitle}\n${input.content.trim()}`,
  );
  const businessKey = input.businessKey?.trim() || `content:${contentHash}`;
  const taskId = `wx-${
    (await sha256Hex(`${accountId}|${businessKey}`)).slice(0, 32)
  }`;
  return { taskId, accountId, businessKey, contentHash };
}

export class PublishStateUnknownError extends Error {
  constructor(taskId: string, detail: string) {
    super(
      `发布任务 ${taskId} 状态未知（${detail}），为避免重复发布已停止自动重试，请人工核对公众号草稿箱后处理。`,
    );
    this.name = "PublishStateUnknownError";
  }
}

export interface GuardedPublishInput {
  store: PublishRecordStore;
  identity: PublishTaskIdentity;
  title: string;
  runId?: string;
  /** 真正的写操作（创建草稿）。 */
  publish: () => Promise<PublishResult>;
  /**
   * 只读状态检查：在平台侧按标题查找已存在的草稿，返回 media_id。
   * 不提供时，遇到状态未知的记录会拒绝自动重试。
   */
  findExistingDraft?: (title: string) => Promise<string | null>;
}

export interface GuardedPublishOutcome {
  result: PublishResult;
  record: PublishRecord | null;
  /** created=本次新写入；reused=已有记录直接复用；recovered=经状态检查发现平台已有草稿。 */
  action: "created" | "reused" | "recovered";
}

const DONE_STATUSES = new Set(["draft_created", "submitted", "published"]);

/**
 * 先查后写的幂等发布：
 * 1. 已有成功记录 -> 直接复用，不再调用微信写接口；
 * 2. 记录处于 pending/failed（上次结果未知）-> 先做只读状态检查，平台已有草稿则补记录，
 *    确认没有才重新写入；无法检查时停止并要求人工处理；
 * 3. 新任务 -> 原子插入 pending（唯一约束防并发）后再写入。
 */
export async function guardedPublish(
  input: GuardedPublishInput,
): Promise<GuardedPublishOutcome> {
  const { store, identity } = input;
  let record = await store.get(identity.taskId);

  if (!record) {
    const created = await store.createPending({
      taskId: identity.taskId,
      accountId: identity.accountId,
      businessKey: identity.businessKey,
      contentHash: identity.contentHash,
      title: input.title,
      runId: input.runId,
    });
    record = await store.get(identity.taskId);
    if (created) {
      return await performWrite(input, record);
    }
    if (!record) {
      throw new PublishStateUnknownError(identity.taskId, "记录插入冲突");
    }
  }

  if (DONE_STATUSES.has(record.status)) {
    logger.info(
      `[幂等] 任务 ${record.taskId} 已是 ${record.status}，跳过重复发布`,
    );
    return { result: resultFromRecord(record), record, action: "reused" };
  }

  // pending 或 failed：上次结果未知，先查状态再决定是否重试。
  if (!input.findExistingDraft) {
    if (record.status === "pending") {
      await store.transition(record.taskId, ["pending"], "failed", {
        lastError: "上次发布中断且无法查询平台状态",
      });
    }
    throw new PublishStateUnknownError(
      record.taskId,
      `当前状态 ${record.status}，发布通道不支持只读状态检查`,
    );
  }

  const existingMediaId = await input.findExistingDraft(input.title);
  if (existingMediaId) {
    if (record.status === "failed") {
      await store.transition(record.taskId, ["failed"], "pending");
    }
    await store.transition(record.taskId, ["pending"], "draft_created", {
      mediaId: existingMediaId,
      publishId: existingMediaId,
      lastError: null,
    });
    const recovered = await store.get(record.taskId);
    logger.warn(
      `[幂等] 任务 ${record.taskId} 平台已存在草稿，补记录后不再重复创建`,
    );
    return {
      result: resultFromRecord(recovered ?? record),
      record: recovered,
      action: "recovered",
    };
  }

  if (record.status === "failed") {
    const reset = await store.transition(record.taskId, ["failed"], "pending", {
      runId: input.runId,
    });
    if (!reset) {
      throw new PublishStateUnknownError(record.taskId, "重置为 pending 失败");
    }
  }
  return await performWrite(input, await store.get(record.taskId));
}

async function performWrite(
  input: GuardedPublishInput,
  record: PublishRecord | null,
): Promise<GuardedPublishOutcome> {
  const { store, identity } = input;
  try {
    const result = await input.publish();
    const ok = await store.transition(
      identity.taskId,
      ["pending"],
      "draft_created",
      {
        mediaId: result.publishId,
        publishId: result.publishId,
        runId: input.runId,
        lastError: null,
        incrementAttempts: true,
      },
    );
    if (!ok) {
      logger.warn(
        `[幂等] 任务 ${identity.taskId} 状态迁移到 draft_created 失败`,
      );
    }
    return {
      result,
      record: await store.get(identity.taskId) ?? record,
      action: "created",
    };
  } catch (error) {
    await store.transition(identity.taskId, ["pending"], "failed", {
      lastError: redactSensitiveText(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 1000),
      incrementAttempts: true,
    });
    throw error;
  }
}

function resultFromRecord(record: PublishRecord): PublishResult {
  const id = record.mediaId ?? record.publishId ?? record.taskId;
  return {
    publishId: id,
    status: record.status === "published" ? "published" : "draft",
    publishedAt: new Date(record.updatedAt),
    platform: "weixin",
    accountId: record.accountId,
    url: record.mediaId
      ? `https://mp.weixin.qq.com/s/${record.mediaId}`
      : undefined,
  };
}
