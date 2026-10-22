import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import type { PublishResult } from "@src/core/ports/content-publisher.ts";
import type { PublishRecordStore } from "@src/core/ports/publish-record-store.ts";
import { MemoryPublishRecordStore } from "@src/core/storage/memory-publish-record-store.ts";
import { SQLitePublishRecordStore } from "@src/platform/local/sqlite-publish-record-store.ts";
import {
  computePublishTaskIdentity,
  guardedPublish,
  PublishStateUnknownError,
} from "@src/features/weixin-article/services/publish-idempotency.service.ts";

function draft(id: string): PublishResult {
  return {
    publishId: id,
    status: "draft",
    publishedAt: new Date(),
    platform: "weixin",
  };
}

const stores: Array<[string, () => PublishRecordStore]> = [
  ["memory", () => new MemoryPublishRecordStore()],
  ["sqlite", () => new SQLitePublishRecordStore(":memory:")],
];

Deno.test("taskId is deterministic per account + content", async () => {
  const a = await computePublishTaskIdentity({
    accountId: "main",
    title: "T",
    content: "C",
  });
  const b = await computePublishTaskIdentity({
    accountId: "main",
    title: " T ",
    content: "C",
  });
  const c = await computePublishTaskIdentity({
    accountId: "lab",
    title: "T",
    content: "C",
  });
  const d = await computePublishTaskIdentity({
    accountId: "main",
    title: "T",
    content: "C2",
  });
  const e = await computePublishTaskIdentity({
    accountId: "main",
    title: "X",
    content: "Y",
    businessKey: "k1",
  });
  const f = await computePublishTaskIdentity({
    accountId: "main",
    title: "Z",
    content: "W",
    businessKey: "k1",
  });
  assertEquals(a.taskId, b.taskId);
  assertNotEquals(a.taskId, c.taskId);
  assertNotEquals(a.taskId, d.taskId);
  assertEquals(e.taskId, f.taskId);
});

for (const [name, makeStore] of stores) {
  Deno.test(`[${name}] second publish of same task reuses record without writing`, async () => {
    const store = makeStore();
    const identity = await computePublishTaskIdentity({
      title: "T",
      content: "C",
    });
    let writes = 0;
    const publish = () => {
      writes++;
      return Promise.resolve(draft("media-1"));
    };
    const first = await guardedPublish({
      store,
      identity,
      title: "T",
      publish,
    });
    const second = await guardedPublish({
      store,
      identity,
      title: "T",
      publish,
    });
    assertEquals(first.action, "created");
    assertEquals(second.action, "reused");
    assertEquals(second.result.publishId, "media-1");
    assertEquals(writes, 1);
    assertEquals((await store.get(identity.taskId))?.status, "draft_created");
  });

  Deno.test(`[${name}] failed publish is retried only after status check finds no draft`, async () => {
    const store = makeStore();
    const identity = await computePublishTaskIdentity({
      title: "T",
      content: "C",
    });
    await assertRejects(() =>
      guardedPublish({
        store,
        identity,
        title: "T",
        publish: () =>
          Promise.reject(new Error("timeout access_token=SECRET1")),
      })
    );
    const failed = await store.get(identity.taskId);
    assertEquals(failed?.status, "failed");
    assertEquals(failed?.lastError?.includes("SECRET1"), false);

    let checks = 0;
    let writes = 0;
    const retried = await guardedPublish({
      store,
      identity,
      title: "T",
      publish: () => {
        writes++;
        return Promise.resolve(draft("media-2"));
      },
      findExistingDraft: () => {
        checks++;
        return Promise.resolve(null);
      },
    });
    assertEquals(checks, 1);
    assertEquals(writes, 1);
    assertEquals(retried.action, "created");
    assertEquals((await store.get(identity.taskId))?.mediaId, "media-2");
  });

  Deno.test(`[${name}] status check recovers existing draft instead of creating duplicate`, async () => {
    const store = makeStore();
    const identity = await computePublishTaskIdentity({
      title: "T",
      content: "C",
    });
    await store.createPending({ ...identity, title: "T" });
    let writes = 0;
    const outcome = await guardedPublish({
      store,
      identity,
      title: "T",
      publish: () => {
        writes++;
        return Promise.resolve(draft("dup"));
      },
      findExistingDraft: () => Promise.resolve("media-existing"),
    });
    assertEquals(writes, 0);
    assertEquals(outcome.action, "recovered");
    assertEquals(outcome.result.publishId, "media-existing");
    assertEquals((await store.get(identity.taskId))?.status, "draft_created");
  });

  Deno.test(`[${name}] unknown state without status check stops instead of retrying`, async () => {
    const store = makeStore();
    const identity = await computePublishTaskIdentity({
      title: "T",
      content: "C",
    });
    await store.createPending({ ...identity, title: "T" });
    let writes = 0;
    await assertRejects(
      () =>
        guardedPublish({
          store,
          identity,
          title: "T",
          publish: () => {
            writes++;
            return Promise.resolve(draft("x"));
          },
        }),
      PublishStateUnknownError,
    );
    assertEquals(writes, 0);
    assertEquals((await store.get(identity.taskId))?.status, "failed");
  });

  Deno.test(`[${name}] state machine rejects illegal transitions and unique taskId`, async () => {
    const store = makeStore();
    const identity = await computePublishTaskIdentity({
      title: "T",
      content: "C",
    });
    assertEquals(await store.createPending({ ...identity, title: "T" }), true);
    assertEquals(await store.createPending({ ...identity, title: "T" }), false);
    assertEquals(
      await store.transition(identity.taskId, ["pending"], "published"),
      false,
    );
    assertEquals(
      await store.transition(identity.taskId, ["pending"], "draft_created"),
      true,
    );
    assertEquals(
      await store.transition(identity.taskId, ["draft_created"], "submitted"),
      true,
    );
    assertEquals(
      await store.transition(identity.taskId, ["submitted"], "published"),
      true,
    );
    assertEquals(
      await store.transition(identity.taskId, ["published"], "pending"),
      false,
    );
    assertEquals((await store.get(identity.taskId))?.status, "published");
  });
}
