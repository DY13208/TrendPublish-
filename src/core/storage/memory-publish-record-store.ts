import {
  applyPublishRecordPatch,
  type CreatePublishRecordInput,
  isAllowedPublishTransition,
  type PublishRecord,
  type PublishRecordPatch,
  type PublishRecordStatus,
  type PublishRecordStore,
} from "@src/core/ports/publish-record-store.ts";

export class MemoryPublishRecordStore implements PublishRecordStore {
  private readonly records = new Map<string, PublishRecord>();
  private readonly materials = new Map<string, string>();

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
      pollAttempts: 0,
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
      ...applyPublishRecordPatch(record, patch),
      status: to,
    });
    return Promise.resolve(true);
  }

  update(
    taskId: string,
    statuses: PublishRecordStatus[],
    patch: PublishRecordPatch,
  ): Promise<boolean> {
    const record = this.records.get(taskId);
    if (!record || !statuses.includes(record.status)) {
      return Promise.resolve(false);
    }
    this.records.set(taskId, applyPublishRecordPatch(record, patch));
    return Promise.resolve(true);
  }

  claimSubmit(taskId: string, at: string): Promise<boolean> {
    const record = this.records.get(taskId);
    if (
      !record || record.status !== "draft_created" || record.submitStartedAt
    ) {
      return Promise.resolve(false);
    }
    this.records.set(
      taskId,
      applyPublishRecordPatch(record, { submitStartedAt: at }),
    );
    return Promise.resolve(true);
  }

  listDueForPolling(now: string, limit: number): Promise<PublishRecord[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter((record) =>
          record.status === "submitted" && record.freepublishId &&
          (!record.nextPollAt || record.nextPollAt <= now)
        )
        .sort((a, b) => (a.nextPollAt ?? "").localeCompare(b.nextPollAt ?? ""))
        .slice(0, limit)
        .map((record) => ({ ...record })),
    );
  }

  getMaterial(cacheKey: string): Promise<string | null> {
    return Promise.resolve(this.materials.get(cacheKey) ?? null);
  }

  putMaterial(cacheKey: string, mediaId: string): Promise<void> {
    this.materials.set(cacheKey, mediaId);
    return Promise.resolve();
  }
}
