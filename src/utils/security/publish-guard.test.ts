import { assertEquals, assertThrows } from "@std/assert";
import {
  assertPublishEnabled,
  isPublishEnabled,
  PublishDisabledError,
  setPublishEnabledOverrideForTesting,
} from "@src/utils/security/publish-guard.ts";

Deno.test("publish is disabled by default", () => {
  setPublishEnabledOverrideForTesting(undefined);
  const previous = Deno.env.get("PUBLISH_ENABLED");
  Deno.env.delete("PUBLISH_ENABLED");
  try {
    assertEquals(isPublishEnabled(), false);
    assertThrows(() => assertPublishEnabled("draft/add"), PublishDisabledError);
    Deno.env.set("PUBLISH_ENABLED", "1");
    assertEquals(isPublishEnabled(), false, "only literal true enables");
    Deno.env.set("PUBLISH_ENABLED", "true");
    assertEquals(isPublishEnabled(), true);
  } finally {
    if (previous === undefined) Deno.env.delete("PUBLISH_ENABLED");
    else Deno.env.set("PUBLISH_ENABLED", previous);
  }
});

Deno.test("WeixinPublisher blocks draft write when publish disabled", async () => {
  setPublishEnabledOverrideForTesting(false);
  try {
    const { WeixinPublisher } = await import(
      "@src/integrations/publish/providers/weixin-publisher.ts"
    );
    let called = false;
    const fakeClient = {
      getAccessToken: () => {
        called = true;
        return Promise.resolve({ access_token: "t", expires_in: 7200 });
      },
      postJson: () => {
        called = true;
        return Promise.resolve({ media_id: "m" });
      },
    };
    const publisher = new WeixinPublisher(
      // deno-lint-ignore no-explicit-any
      { appId: "a", appSecret: "b", author: "x", accounts: {} } as any,
      undefined,
      // deno-lint-ignore no-explicit-any
      fakeClient as any,
    );
    let error: unknown;
    try {
      await publisher.publishArticle({
        content: "<p>x</p>",
        title: "t",
        digest: "d",
        coverMediaId: "c",
      });
    } catch (e) {
      error = e;
    }
    assertEquals(error instanceof PublishDisabledError, true);
    assertEquals(called, false);
    let imgError: unknown;
    try {
      await publisher.uploadImage("https://example.com/a.png");
    } catch (e) {
      imgError = e;
    }
    assertEquals(imgError instanceof PublishDisabledError, true);
  } finally {
    setPublishEnabledOverrideForTesting(undefined);
  }
});

Deno.test("WeixinPublisher freepublish submit/get use official endpoints and guard", async () => {
  const { WeixinPublisher } = await import(
    "@src/integrations/publish/providers/weixin-publisher.ts"
  );
  const calls: Array<{ path: string; body: unknown }> = [];
  const fakeClient = {
    getAccessToken: () =>
      Promise.resolve({ access_token: "t", expires_in: 7200 }),
    postJson: (path: string, _token: string, body: unknown) => {
      calls.push({ path, body });
      if (path === "/cgi-bin/freepublish/submit") {
        return Promise.resolve({ errcode: 0, publish_id: 2247483647 });
      }
      return Promise.resolve({ publish_status: 0, article_id: "a" });
    },
  };
  const publisher = new WeixinPublisher(
    // deno-lint-ignore no-explicit-any
    { appId: "a", appSecret: "b", author: "x", accounts: {} } as any,
    undefined,
    // deno-lint-ignore no-explicit-any
    fakeClient as any,
  );
  setPublishEnabledOverrideForTesting(false);
  let blocked: unknown;
  try {
    await publisher.submitFreePublish("m1");
  } catch (e) {
    blocked = e;
  }
  assertEquals(blocked instanceof PublishDisabledError, true);
  assertEquals(calls.length, 0);
  setPublishEnabledOverrideForTesting(true);
  try {
    const submitted = await publisher.submitFreePublish("m1");
    assertEquals(submitted.publishId, "2247483647");
    const status = await publisher.getFreePublishStatus("2247483647");
    assertEquals(status.publish_status, 0);
    assertEquals(calls.map((c) => c.path), [
      "/cgi-bin/freepublish/submit",
      "/cgi-bin/freepublish/get",
    ]);
    assertEquals(calls[0].body, { media_id: "m1" });
  } finally {
    setPublishEnabledOverrideForTesting(undefined);
  }
});
