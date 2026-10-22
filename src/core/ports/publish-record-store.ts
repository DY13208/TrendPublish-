/**
 * 发布记录：每个 taskId 唯一，用于防止重复发布。
 *
 * 状态机：
 *   pending -> draft_created -> submitted -> published
 *   pending | draft_created | submitted -> failed
 *   failed -> pending（仅在“先查状态再重试”确认未产生草稿后）
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
  mediaId?: string;
  publishId?: string;
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
  lastError?: string | null;
  incrementAttempts?: boolean;
}

export interface PublishRecordStore {
  get(taskId: string): Promise<PublishRecord | null>;
  /** 原子插入 pending 记录；taskId 已存在时返回 false（唯一约束）。 */
  createPending(input: CreatePublishRecordInput): Promise<boolean>;
  /**
   * 带前置状态校验的状态迁移（compare-and-set）。
   * 当前状态不在 from 中或迁移非法时返回 false。
   */
  transition(
    taskId: string,
    from: PublishRecordStatus[],
    to: PublishRecordStatus,
    patch?: PublishRecordPatch,
  ): Promise<boolean>;
}

const ALLOWED_TRANSITIONS: Record<PublishRecordStatus, PublishRecordStatus[]> =
  {
    pending: ["draft_created", "failed"],
    draft_created: ["submitted", "failed"],
    submitted: ["published", "failed"],
    published: [],
    failed: ["pending"],
  };

export function isAllowedPublishTransition(
  from: PublishRecordStatus,
  to: PublishRecordStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
