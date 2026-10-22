import { Database } from "@db/sqlite";
import { dirname } from "node:path";
import {
  applyPublishRecordPatch,
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
CREATE TABLE IF NOT EXISTS weixin_material_cache (
  cache_key TEXT PRIMARY KEY NOT NULL,
  media_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** 第 3 步新增列（对已有数据库做增量迁移）。 */
const EXTRA_COLUMNS: Array<[string, string]> = [
  ["freepublish_id", "TEXT"],
  ["submit_started_at", "TEXT"],
  ["publish_status_code", "INTEGER"],
  ["article_id", "TEXT"],
  ["article_url", "TEXT"],
  ["fail_idx", "TEXT"],
  ["poll_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["next_poll_at", "TEXT"],
];

const FIELD_COLUMNS: Array<[keyof PublishRecord, string]> = [
  ["runId", "run_id"],
  ["mediaId", "media_id"],
  ["publishId", "publish_id"],
  ["freepublishId", "freepublish_id"],
  ["submitStartedAt", "submit_started_at"],
  ["publishStatusCode", "publish_status_code"],
  ["articleId", "article_id"],
  ["articleUrl", "article_url"],
  ["failIdx", "fail_idx"],
  ["pollAttempts", "poll_attempts"],
  ["nextPollAt", "next_poll_at"],
  ["attempts", "attempts"],
  ["lastError", "last_error"],
  ["updatedAt", "updated_at"],
];

type Row = Record<string, string | number | null>;

export class SQLitePublishRecordStore implements PublishRecordStore {
  private db?: Database;

  constructor(private readonly databasePath: string) {}

  get(taskId: string): Promise<PublishRecord | null> {
    return Promise.resolve(this.read(taskId));
  }

  createPending(input: CreatePublishRecordInput): Promise<boolean> {
    const now = new Date().toISOString();
    const changes = this.getDb().prepare(
      `INSERT OR IGNORE INTO publish_records
        (task_id, account_id, business_key, content_hash, title, status, run_id, attempts, poll_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, 0, ?, ?)`,
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
    return Promise.resolve(this.writeTx(taskId, (record) => {
      if (
        !from.includes(record.status) ||
        !isAllowedPublishTransition(record.status, to)
      ) return null;
      return { ...applyPublishRecordPatch(record, patch), status: to };
    }));
  }

  update(
    taskId: string,
    statuses: PublishRecordStatus[],
    patch: PublishRecordPatch,
  ): Promise<boolean> {
    return Promise.resolve(this.writeTx(taskId, (record) => {
      if (!statuses.includes(record.status)) return null;
      return applyPublishRecordPatch(record, patch);
    }));
  }

  claimSubmit(taskId: string, at: string): Promise<boolean> {
    const changes = this.getDb().prepare(
      `UPDATE publish_records SET submit_started_at = ?, updated_at = ?
       WHERE task_id = ? AND status = 'draft_created' AND submit_started_at IS NULL`,
    ).run(at, new Date().toISOString(), taskId);
    return Promise.resolve(changes > 0);
  }

  listDueForPolling(now: string, limit: number): Promise<PublishRecord[]> {
    const rows = this.getDb().prepare(
      `SELECT * FROM publish_records
       WHERE status = 'submitted' AND freepublish_id IS NOT NULL
         AND (next_poll_at IS NULL OR next_poll_at <= ?)
       ORDER BY next_poll_at ASC LIMIT ?`,
    ).all(now, limit) as Row[];
    return Promise.resolve(rows.map(toRecord));
  }

  getMaterial(cacheKey: string): Promise<string | null> {
    const row = this.getDb().prepare(
      "SELECT media_id FROM weixin_material_cache WHERE cache_key = ?",
    ).get(cacheKey) as { media_id: string } | undefined;
    return Promise.resolve(row?.media_id ?? null);
  }

  putMaterial(cacheKey: string, mediaId: string): Promise<void> {
    this.getDb().prepare(
      `INSERT OR REPLACE INTO weixin_material_cache (cache_key, media_id, created_at)
       VALUES (?, ?, ?)`,
    ).run(cacheKey, mediaId, new Date().toISOString());
    return Promise.resolve();
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private read(taskId: string): PublishRecord | null {
    const row = this.getDb().prepare(
      "SELECT * FROM publish_records WHERE task_id = ?",
    ).get(taskId) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** 在单个 IMMEDIATE 事务中读-改-写（带状态前置校验）。 */
  private writeTx(
    taskId: string,
    mutate: (record: PublishRecord) => PublishRecord | null,
  ): boolean {
    const db = this.getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read(taskId);
      const next = current ? mutate(current) : null;
      if (!current || !next) {
        db.exec("ROLLBACK");
        return false;
      }
      const sets = ["status = ?", ...FIELD_COLUMNS.map(([, c]) => `${c} = ?`)];
      const values = [
        next.status,
        ...FIELD_COLUMNS.map(([field]) =>
          (next[field] ??
            (field === "pollAttempts" || field === "attempts" ? 0 : null)) as
              | string
              | number
              | null
        ),
      ];
      db.prepare(
        `UPDATE publish_records SET ${
          sets.join(", ")
        } WHERE task_id = ? AND status = ?`,
      ).run(...values, taskId, current.status);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private getDb(): Database {
    if (!this.db) {
      if (this.databasePath !== ":memory:") {
        Deno.mkdirSync(dirname(this.databasePath), { recursive: true });
      }
      this.db = new Database(this.databasePath);
      this.db.exec(PUBLISH_RECORD_SCHEMA_SQL);
      const existing = new Set(
        (this.db.prepare("PRAGMA table_info(publish_records)").all() as Array<
          { name: string }
        >).map((column) => column.name),
      );
      for (const [name, type] of EXTRA_COLUMNS) {
        if (!existing.has(name)) {
          this.db.exec(
            `ALTER TABLE publish_records ADD COLUMN ${name} ${type}`,
          );
        }
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_publish_records_poll ON publish_records(status, next_poll_at)",
      );
    }
    return this.db;
  }
}

function str(value: string | number | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function toRecord(row: Row): PublishRecord {
  return {
    taskId: String(row.task_id),
    accountId: String(row.account_id),
    businessKey: String(row.business_key),
    contentHash: String(row.content_hash),
    title: String(row.title),
    status: row.status as PublishRecordStatus,
    runId: str(row.run_id),
    mediaId: str(row.media_id),
    publishId: str(row.publish_id),
    freepublishId: str(row.freepublish_id),
    submitStartedAt: str(row.submit_started_at),
    publishStatusCode: row.publish_status_code === null ||
        row.publish_status_code === undefined
      ? undefined
      : Number(row.publish_status_code),
    articleId: str(row.article_id),
    articleUrl: str(row.article_url),
    failIdx: str(row.fail_idx),
    pollAttempts: Number(row.poll_attempts ?? 0),
    nextPollAt: str(row.next_poll_at),
    attempts: Number(row.attempts ?? 0),
    lastError: str(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
