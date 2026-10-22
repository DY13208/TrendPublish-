import { assertEquals, assertRejects } from "@std/assert";
import { Database } from "@db/sqlite";
import type { WeixinFreePublishStatus } from "@src/core/ports/content-publisher.ts";
import type { PublishRecordStore } from "@src/core/ports/publish-record-store.ts";
import { MemoryPublishRecordStore } from "@src/core/storage/memory-publish-record-store.ts";
import { SQLitePublishRecordStore } from "@src/platform/local/sqlite-publish-record-store.ts";
import {
  FreePublishService,
  ReplayConflictError,
  SubmitStateUnknownError,
} from "@src/features/weixin-article/services/freepublish.service.ts";
import { withMaterialCache } from "@src/features/weixin-article/services/material-cache.ts";
import { setPublishEnabledOverrideForTesting } from "@src/utils/security/publish-guard.ts";
import { ProviderError } from "@src/core/errors/provider-error.ts";

class MockWeixin {
  submits: string[] = [];
  gets: string[] = [];
  submitError?: Error;
  statuses: WeixinFreePublishStatus[] = [];
  submitFreePublish(mediaId: string) {
    this.submits.push(mediaId);
    if (this.submitError) return Promise.reject(this.submitError);
    return Promise.resolve({ publishId: `pub-${this.submits.length}` });
  }
  getFreePublishStatus(publishId: string) {
    this.gets.push(publishId);
    const next = this.statuses.length > 1
      ? this.statuses.shift()!
      : this.statuses[0];
    return Promise.resolve(next ?? { publish_status: 1 });
  }
}

class MockNotifier {
  errors: Array<{ title: string; content: string }> = [];
  successes: string[] = [];
  error(title: string, content: string) {
    this.errors.push({ title, content });
    return Promise.resolve(true);
  }
  success(title: string) {
    this.successes.push(title);
    return Promise.resolve(true);
  }
}

const stores: Array<[string, () => PublishRecordStore]> = [
  ["memory", () => new MemoryPublishRecordStore()],
  ["sqlite", () => new SQLitePublishRecordStore(":memory:")],
];

async function seedDraft(store: PublishRecordStore, taskId = "wx-task") {
  await store.createPending({
    taskId,
    accountId: "default",
    businessKey: "k",
    contentHash: "h",
    title: "标题",
  });
  await store.transition(taskId, ["pending"], "draft_created", {
    mediaId: "media-1",
    publishId: "media-1",
  });
}

function setup(store: PublishRecordStore) {
  const weixin = new MockWeixin();
  const notifier = new MockNotifier();
  let clock = new Date("2026-10-22T00:00:00Z").getTime();
  const service = new FreePublishService(store, weixin, notifier, {
    now: () => new Date(clock),
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    maxPollAttempts: 4,
  });
  return { weixin, notifier, service, tick: (ms: number) => (clock += ms) };
}

function withPublish(fn: () => Promise<void>) {
  return async () => {
    setPublishEnabledOverrideForTesting(true);
    try {
      await fn();
    } finally {
      setPublishEnabledOverrideForTesting(undefined);
    }
  };
}

Deno.test("freepublish submit is blocked when PUBLISH_ENABLED is off", async () => {
  setPublishEnabledOverrideForTesting(false);
  try {
    const store = new MemoryPublishRecordStore();
    await seedDraft(store);
    const { weixin, service } = setup(store);
    await assertRejects(() => service.submit("wx-task"));
    assertEquals(weixin.submits.length, 0);
    assertEquals(await service.pollDue(), []);
  } finally {
    setPublishEnabledOverrideForTesting(undefined);
  }
});

for (const [name, makeStore] of stores) {
  Deno.test(
    `[${name}] submit then poll -> published`,
    withPublish(async () => {
      const store = makeStore();
      await seedDraft(store);
      const { weixin, notifier, service, tick } = setup(store);
      weixin.statuses = [
        { publish_status: 1 },
        {
          publish_status: 0,
          article_id: "art-1",
          article_detail: {
            item: [{ idx: 1, article_url: "https://mp.weixin.qq.com/s/x" }],
          },
        },
      ];
      const submitted = await service.submit("wx-task");
      assertEquals(submitted.status, "submitted");
      assertEquals(submitted.freepublishId, "pub-1");

      // 未到期不轮询
      assertEquals((await service.pollDue()).length, 0);
      tick(1000);
      const first = await service.pollDue();
      assertEquals(first[0].status, "submitted");
      assertEquals(first[0].pollAttempts, 1);
      tick(1000);
      const second = await service.pollDue();
      assertEquals(second[0].status, "published");
      assertEquals(second[0].articleUrl, "https://mp.weixin.qq.com/s/x");
      assertEquals(notifier.successes.length, 1);

      // 再次 submit 不会重复提交
      await service.submit("wx-task");
      assertEquals(weixin.submits, ["media-1"]);
    }),
  );

  Deno.test(
    `[${name}] never submits the same media_id twice`,
    withPublish(async () => {
      const store = makeStore();
      await seedDraft(store);
      const { weixin, service } = setup(store);
      await Promise.allSettled([
        service.submit("wx-task"),
        service.submit("wx-task"),
      ]);
      await service.submit("wx-task");
      assertEquals(weixin.submits.length, 1);
    }),
  );

  Deno.test(
    `[${name}] maps publish failure status and fail_idx, alerts with redaction`,
    withPublish(async () => {
      const store = makeStore();
      await seedDraft(store);
      const { weixin, notifier, service, tick } = setup(store);
      weixin.statuses = [{ publish_status: 4, fail_idx: [1] }];
      await service.submit("wx-task");
      tick(1000);
      const [record] = await service.pollDue();
      assertEquals(record.status, "failed");
      assertEquals(record.publishStatusCode, 4);
      assertEquals(record.failIdx, "1");
      assertEquals(record.lastError?.includes("平台审核不通过"), true);
      assertEquals(notifier.errors.length, 1);
      assertEquals(notifier.errors[0].content.includes("pub-1"), true);
    }),
  );

  Deno.test(
    `[${name}] bounded polling marks failed after max attempts`,
    withPublish(async () => {
      const store = makeStore();
      await seedDraft(store);
      const { weixin, notifier, service, tick } = setup(store);
      weixin.statuses = [{ publish_status: 1 }];
      await service.submit("wx-task");
      const delays: number[] = [];
      let last = (await store.get("wx-task"))!;
      for (let i = 0; i < 4; i++) {
        const due = new Date(last.nextPollAt!).getTime();
        tick(due - new Date(last.updatedAt).getTime() + 10_000);
        await service.pollOnce("wx-task");
        const next = (await store.get("wx-task"))!;
        if (next.nextPollAt && last.nextPollAt) {
          delays.push(new Date(next.nextPollAt).getTime());
        }
        last = next;
      }
      assertEquals(last.status, "failed");
      assertEquals(last.lastError?.includes("轮询超时"), true);
      assertEquals(notifier.errors.length, 1);
    }),
  );

  Deno.test(
    `[${name}] definitive submit error is safely retryable via replay`,
    withPublish(async () => {
      const store = makeStore();
      await seedDraft(store);
      const { weixin, notifier, service } = setup(store);
      weixin.submitError = new ProviderError({
        provider: "weixin",
        kind: "auth",
        message:
          "微信 API 错误 48001: api unauthorized access_token=SECRETTOKEN",
      });
      await assertRejects(() => service.submit("wx-task"));
      const failed = (await store.get("wx-task"))!;
      assertEquals(failed.status, "failed");
      assertEquals(failed.submitStartedAt, undefined);
      assertEquals(notifier.errors[0].content.includes("SECRETTOKEN"), false);
      weixin.submitError = undefined;
      const outcome = await service.replay("wx-task");
      assertEquals(outcome.action, "submitted");
      assertEquals(outcome.record?.status, "submitted");
      assertEquals(weixin.submits.length, 2);
    }),
  );

  Deno.test(
    `[${name}] unknown submit result requires confirmation before resubmit`,
    withPublish(async () => {
      const store = makeStore();
      await seedDraft(store);
      const { weixin, service } = setup(store);
      weixin.submitError = new Error("network timeout");
      await assertRejects(() => service.submit("wx-task"));
      const failed = (await store.get("wx-task"))!;
      assertEquals(failed.status, "failed");
      assertEquals(Boolean(failed.submitStartedAt), true);
      weixin.submitError = undefined;
      await assertRejects(() => service.replay("wx-task"), ReplayConflictError);
      assertEquals(weixin.submits.length, 1);
      const outcome = await service.replay("wx-task", {
        confirmNotSubmitted: true,
      });
      assertEquals(outcome.action, "submitted");
      assertEquals(weixin.submits.length, 2);
    }),
  );

  Deno.test(
    `[${name}] crash after claim blocks automatic resubmit`,
    withPublish(async () => {
      const store = makeStore();
      await seedDraft(store);
      await store.claimSubmit("wx-task", new Date().toISOString());
      const { weixin, service } = setup(store);
      await assertRejects(
        () => service.submit("wx-task"),
        SubmitStateUnknownError,
      );
      assertEquals(weixin.submits.length, 0);
    }),
  );

  Deno.test(
    `[${name}] replay of failed record with publish_id checks status instead of resubmitting`,
    withPublish(async () => {
      const store = makeStore();
      await seedDraft(store);
      const { weixin, service, tick } = setup(store);
      weixin.statuses = [{ publish_status: 1 }];
      await service.submit("wx-task");
      await store.transition("wx-task", ["submitted"], "failed", {
        lastError: "poll timeout",
      });
      weixin.statuses = [{ publish_status: 0, article_id: "a" }];
      tick(1000);
      const outcome = await service.replay("wx-task");
      assertEquals(outcome.action, "recovered");
      assertEquals(outcome.record?.status, "published");
      assertEquals(weixin.submits.length, 1);
      const noop = await service.replay("wx-task");
      assertEquals(noop.action, "noop");
    }),
  );

  Deno.test(`[${name}] cover add_material is cached per account + url`, async () => {
    const store = makeStore();
    let uploads = 0;
    const publisher = withMaterialCache(
      {
        uploadImage: (url: string) => {
          uploads++;
          return Promise.resolve(`m-${url.length}-${uploads}`);
        },
      },
      store,
      "main",
    );
    const a = await publisher.uploadImage("https://img/a.png");
    const b = await publisher.uploadImage("https://img/a.png");
    await publisher.uploadImage("https://img/b.png");
    assertEquals(a, b);
    assertEquals(uploads, 2);
  });
}

Deno.test("sqlite store migrates an existing step-2 publish_records table", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite3" });
  try {
    const db = new Database(path);
    db.exec(`CREATE TABLE publish_records (
      task_id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, business_key TEXT NOT NULL,
      content_hash TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT,
      media_id TEXT, publish_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.exec(
      `INSERT INTO publish_records VALUES ('t1','default','k','h','T','draft_created',NULL,'m1','m1',1,NULL,'2026','2026')`,
    );
    db.close();
    const store = new SQLitePublishRecordStore(path);
    const record = await store.get("t1");
    assertEquals(record?.status, "draft_created");
    assertEquals(record?.pollAttempts, 0);
    assertEquals(await store.claimSubmit("t1", "now"), true);
    store.close();
  } finally {
    await Deno.remove(path);
  }
});
