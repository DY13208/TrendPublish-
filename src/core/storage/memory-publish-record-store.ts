import {
  type CreatePublishRecordInput,
  isAllowedPublishTransition,
  type PublishRecord,
  type PublishRecordPatch,
  type PublishRecordStatus,
  type PublishRecordStore,
} from "@src/core/ports/publish-record-store.ts";

export class MemoryPublishRecordStore implements PublishRecordStore {
  private readonly records = new Map<string, PublishRecord>();

  get(taskId: string): Promise<PublishRecord | null> {
    const record = this.records.get(taskId);
    return Promise.resolve(record ? { ...record } : null);
  }

  createPending(input: CreatePublishRecordInput): Promise<boolean> {
    if (this.records.has(input.taskId)) return Promise.resolve(false);
    const now = new Date().toISOString();
    this.records.set(input.taskId, {
      ...input,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    return Promise.resolve(true);
  }

  transition(
    taskId: string,
    from: PublishRecordStatus[],
    to: PublishRecordStatus,
    patch: PublishRecordPatch = {},
  ): Promise<boolean> {
    const record = this.records.get(taskId);
    if (
      !record || !from.includes(record.status) ||
      !isAllowedPublishTransition(record.status, to)
    ) {
      return Promise.resolve(false);
    }
    this.records.set(taskId, {
      ...record,
      status: to,
      runId: patch.runId ?? record.runId,
      mediaId: patch.mediaId ?? record.mediaId,
      publishId: patch.publishId ?? record.publishId,
      lastError: patch.lastError === null
        ? undefined
        : patch.lastError ?? record.lastError,
      attempts: record.attempts + (patch.incrementAttempts ? 1 : 0),
      updatedAt: new Date().toISOString(),
    });
    return Promise.resolve(true);
  }
}
