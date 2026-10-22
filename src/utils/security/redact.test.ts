import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  clearRegisteredSecrets,
  redactSensitiveText,
  redactValue,
  registerSecretsFromObject,
  registerSecretValue,
} from "@src/utils/security/redact.ts";

Deno.test("redact masks access_token in URLs and bearer tokens", () => {
  const text = redactSensitiveText(
    "POST https://api.weixin.qq.com/cgi-bin/draft/add?access_token=ABC123xyz&x=1 Authorization: Bearer abcdefghijklmnop",
  );
  assertEquals(text.includes("ABC123xyz"), false);
  assertEquals(text.includes("abcdefghijklmnop"), false);
  assertStringIncludes(text, "access_token=[REDACTED]");
});

Deno.test("redact masks registered secret values anywhere", () => {
  clearRegisteredSecrets();
  registerSecretValue("my-server-api-key-123");
  assertEquals(
    redactSensitiveText("api key: my-server-api-key-123"),
    "api key: [REDACTED]",
  );
  clearRegisteredSecrets();
});

Deno.test("redact registers secrets from config-like objects", () => {
  clearRegisteredSecrets();
  registerSecretsFromObject({
    server: { apiKey: "server-secret-value" },
    providers: {
      ai: { apiKey: "sk-ai-secret-value", baseUrl: "https://example.com" },
      publish: {
        weixin: { appId: "wx123456", appSecret: "weixin-app-secret" },
      },
    },
  });
  const out = redactSensitiveText(
    "server-secret-value sk-ai-secret-value weixin-app-secret https://example.com wx123456",
  );
  assertEquals(out.includes("server-secret-value"), false);
  assertEquals(out.includes("sk-ai-secret-value"), false);
  assertEquals(out.includes("weixin-app-secret"), false);
  assertStringIncludes(out, "https://example.com");
  assertStringIncludes(out, "wx123456");
  const ctx = redactValue({ nested: { msg: "token server-secret-value" } });
  assertEquals(JSON.stringify(ctx).includes("server-secret-value"), false);
  clearRegisteredSecrets();
});
