/**
 * 发布记录：每个 taskId 唯一，用于防止重复发布。
 *
 * 状态机：
 *   pending -> draft_created -> submitted -> published
 *   pending | draft_created | submitted -> failed
 *   failed -> pending        （草稿未创建，经状态检查确认后重试）
 *   failed -> draft_created  （草稿已存在，人工确认未提交后重新提交）
 *   failed -> submitted      （已拿到 publish_id，经 freepublish/get 确认仍在发布/恢复轮询）
 */
export type PublishRecordStatus =
  | "pending"
  | "draft_created"
  | "submitted"
  | "published"
  | "failed";

export interface PublishRecord {
  taskId: string;
  accountId: string;
  businessKey: string;
  contentHash: string;
  title: string;
  status: PublishRecordStatus;
  runId?: string;
  /** 草稿 media_id（draft/add 返回）。 */
  mediaId?: string;
  /** 兼容字段：草稿阶段等于 mediaId。 */
  publishId?: string;
  /** freepublish/submit 返回的 publish_id。 */
  freepublishId?: string;
  /** 已发起 freepublish/submit 的时间（用于识别“提交结果未知”）。 */
  submitStartedAt?: string;
  publishStatusCode?: number;
  articleId?: string;
  articleUrl?: string;
  failIdx?: string;
  pollAttempts: number;
  nextPollAt?: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePublishRecordInput {
  taskId: string;
  accountId: string;
  businessKey: string;
  contentHash: string;
  title: string;
  runId?: string;
}

export interface PublishRecordPatch {
  runId?: string;
  mediaId?: string;
  publishId?: string;
  freepublishId?: string;
  publishStatusCode?: number;
  articleId?: string;
  articleUrl?: string;
  failIdx?: string;
  pollAttempts?: number;
  /** null 表示清空。 */
  nextPollAt?: string | null;
  /** null 表示清空。 */
  submitStartedAt?: string | null;
  /** null 表示清空。 */
  lastError?: string | null;
  incrementAttempts?: boolean;
}

export interface PublishRecordStore {
  get(taskId: string): Promise<PublishRecord | null>;
  /** 原子插入 pending 记录；taskId 已存在时返回 false（唯一约束）。 */
  createPending(input: CreatePublishRecordInput): Promise<boolean>;
  /** 带前置状态校验的状态迁移（compare-and-set）。 */
  transition(
    taskId: string,
    from: PublishRecordStatus[],
    to: PublishRecordStatus,
    patch?: PublishRecordPatch,
  ): Promise<boolean>;
  /** 不改变状态，仅在当前状态属于 statuses 时更新字段。 */
  update(
    taskId: string,
    statuses: PublishRecordStatus[],
    patch: PublishRecordPatch,
  ): Promise<boolean>;
  /**
   * 原子占用“提交”动作：仅当状态为 draft_created 且尚未发起提交时成功。
   * 保证同一个 media_id 永远不会被 freepublish/submit 两次。
   */
  claimSubmit(taskId: string, at: string): Promise<boolean>;
  /** 列出到期需要轮询的 submitted 记录（持久化，重启后继续）。 */
  listDueForPolling(now: string, limit: number): Promise<PublishRecord[]>;
  /** 素材上传缓存（封面 add_material 幂等）。 */
  getMaterial(cacheKey: string): Promise<string | null>;
  putMaterial(cacheKey: string, mediaId: string): Promise<void>;
}

const ALLOWED_TRANSITIONS: Record<PublishRecordStatus, PublishRecordStatus[]> =
  {
    pending: ["draft_created", "failed"],
    draft_created: ["submitted", "failed"],
    submitted: ["published", "failed"],
    published: [],
    failed: ["pending", "draft_created", "submitted"],
  };

export function isAllowedPublishTransition(
  from: PublishRecordStatus,
  to: PublishRecordStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function applyPublishRecordPatch(
  record: PublishRecord,
  patch: PublishRecordPatch,
): PublishRecord {
  const next: PublishRecord = { ...record };
  const keys = [
    "runId",
    "mediaId",
    "publishId",
    "freepublishId",
    "publishStatusCode",
    "articleId",
    "articleUrl",
    "failIdx",
    "pollAttempts",
  ] as const;
  for (const key of keys) {
    if (patch[key] !== undefined) {
      (next as unknown as Record<string, unknown>)[key] = patch[key];
    }
  }
  for (const key of ["nextPollAt", "submitStartedAt", "lastError"] as const) {
    if (patch[key] === null) delete next[key];
    else if (patch[key] !== undefined) next[key] = patch[key] as string;
  }
  if (patch.incrementAttempts) next.attempts += 1;
  next.updatedAt = new Date().toISOString();
  return next;
}
