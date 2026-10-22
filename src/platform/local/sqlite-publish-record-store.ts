import { Database } from "@db/sqlite";
import { dirname } from "node:path";
import {
  type CreatePublishRecordInput,
  isAllowedPublishTransition,
  type PublishRecord,
  type PublishRecordPatch,
  type PublishRecordStatus,
  type PublishRecordStore,
} from "@src/core/ports/publish-record-store.ts";

export const PUBLISH_RECORD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS publish_records (
  task_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  business_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','draft_created','submitted','published','failed')),
  run_id TEXT,
  media_id TEXT,
  publish_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_publish_records_account_business
  ON publish_records(account_id, business_key);
`;

interface PublishRecordRow {
  task_id: string;
  account_id: string;
  business_key: string;
  content_hash: string;
  title: string;
  status: PublishRecordStatus;
  run_id: string | null;
  media_id: string | null;
  publish_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export class SQLitePublishRecordStore implements PublishRecordStore {
  private db?: Database;

  constructor(private readonly databasePath: string) {}

  get(taskId: string): Promise<PublishRecord | null> {
    const row = this.getDb().prepare(
      "SELECT * FROM publish_records WHERE task_id = ?",
    ).get(taskId) as PublishRecordRow | undefined;
    return Promise.resolve(row ? toRecord(row) : null);
  }

  createPending(input: CreatePublishRecordInput): Promise<boolean> {
    const now = new Date().toISOString();
    const changes = this.getDb().prepare(
      `INSERT OR IGNORE INTO publish_records
        (task_id, account_id, business_key, content_hash, title, status, run_id, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)`,
    ).run(
      input.taskId,
      input.accountId,
      input.businessKey,
      input.contentHash,
      input.title,
      input.runId ?? null,
      now,
      now,
    );
    return Promise.resolve(changes > 0);
  }

  transition(
    taskId: string,
    from: PublishRecordStatus[],
    to: PublishRecordStatus,
    patch: PublishRecordPatch = {},
  ): Promise<boolean> {
    const allowedFrom = from.filter((status) =>
      isAllowedPublishTransition(status, to)
    );
    if (allowedFrom.length === 0) return Promise.resolve(false);
    const placeholders = allowedFrom.map(() => "?").join(",");
    const changes = this.getDb().prepare(
      `UPDATE publish_records SET
         status = ?,
         run_id = COALESCE(?, run_id),
         media_id = COALESCE(?, media_id),
         publish_id = COALESCE(?, publish_id),
         last_error = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, last_error) END,
         attempts = attempts + ?,
         updated_at = ?
       WHERE task_id = ? AND status IN (${placeholders})`,
    ).run(
      to,
      patch.runId ?? null,
      patch.mediaId ?? null,
      patch.publishId ?? null,
      patch.lastError === null ? 1 : 0,
      patch.lastError ?? null,
      patch.incrementAttempts ? 1 : 0,
      new Date().toISOString(),
      taskId,
      ...allowedFrom,
    );
    return Promise.resolve(changes > 0);
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private getDb(): Database {
    if (!this.db) {
      if (this.databasePath !== ":memory:") {
        Deno.mkdirSync(dirname(this.databasePath), { recursive: true });
      }
      this.db = new Database(this.databasePath);
      this.db.exec(PUBLISH_RECORD_SCHEMA_SQL);
    }
    return this.db;
  }
}

function toRecord(row: PublishRecordRow): PublishRecord {
  return {
    taskId: row.task_id,
    accountId: row.account_id,
    businessKey: row.business_key,
    contentHash: row.content_hash,
    title: row.title,
    status: row.status,
    runId: row.run_id ?? undefined,
    mediaId: row.media_id ?? undefined,
    publishId: row.publish_id ?? undefined,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
