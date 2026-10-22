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
