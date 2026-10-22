import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "node:path";
import {
  getSecretOverlayValue,
  setSecretOverlay,
} from "@src/utils/config/secret-overlay.ts";
import {
  EncryptedSecretStore,
  loadOrCreateMasterKey,
} from "@src/app/secrets/encrypted-secret-store.ts";
import {
  SecretsService,
  setSecretsService,
} from "@src/app/secrets/secrets-service.ts";
import {
  handleSecretsRequest,
  isTrustedLocalAddress,
} from "@src/app/secrets/secrets-api.ts";
import {
  isPlaceholderAdminKey,
  validateAdminKeyStrength,
} from "@src/app/secrets/secret-fields.ts";
import {
  testLlmConnection,
  testWeixinConnection,
} from "@src/app/secrets/connection-tests.ts";
import { redactSensitiveText } from "@src/utils/security/redact.ts";

const STRONG = "Adm1n-Key_Strong#2026-xyzQ";
const SECRET = "abcdef0123456789abcdef0123456789";

async function makeService(env: Record<string, string> = {}) {
  const dir = await Deno.makeTempDir();
  let reloads = 0;
  const service = await SecretsService.create({
    secretsDir: join(dir, "secrets"),
    keyFile: join(dir, "keys", "master.key"),
    readEffective: (name) => getSecretOverlayValue(name) ?? env[name],
    reload: () => {
      reloads++;
      return Promise.resolve();
    },
  });
  return { dir, service, reloads: () => reloads };
}

Deno.test("secrets: master key file created with 0600 and reused", async () => {
  const dir = await Deno.makeTempDir();
  const keyFile = join(dir, "k", "master.key");
  const first = await loadOrCreateMasterKey({ keyFile });
  assertEquals(first.source, "generated");
  if (Deno.build.os !== "windows") {
    assertEquals((await Deno.stat(keyFile)).mode! & 0o777, 0o600);
  }
  const store1 = new EncryptedSecretStore(
    join(dir, "s.json"),
    join(dir, "a.log"),
    first.key,
  );
  await store1.set("AI_API_KEY", SECRET);
  const second = await loadOrCreateMasterKey({ keyFile });
  const store2 = new EncryptedSecretStore(
    join(dir, "s.json"),
    join(dir, "a.log"),
    second.key,
  );
  assertEquals((await store2.loadAll()).AI_API_KEY, SECRET);
  setSecretOverlay({});
});

Deno.test("secrets: file contains no plaintext; AAD binds field name", async () => {
  const dir = await Deno.makeTempDir();
  const { key } = await loadOrCreateMasterKey({ keyFile: join(dir, "m.key") });
  const path = join(dir, "s.json");
  const store = new EncryptedSecretStore(path, join(dir, "a.log"), key);
  await store.set("AI_API_KEY", SECRET);
  const raw = await Deno.readTextFile(path);
  assertFalse(raw.includes(SECRET));
  // 把密文挪到另一个字段名下，解密必须失败（不返回值）
  const parsed = JSON.parse(raw);
  parsed.entries.DASHSCOPE_API_KEY = parsed.entries.AI_API_KEY;
  delete parsed.entries.AI_API_KEY;
  await Deno.writeTextFile(path, JSON.stringify(parsed));
  const loaded = await store.loadAll().catch(
    () => ({} as Record<string, string>),
  );
  assertEquals(loaded.DASHSCOPE_API_KEY, undefined);
  // 错误的 master key 无法解密
  const other = await loadOrCreateMasterKey({
    keyFile: join(dir, "other.key"),
  });
  const wrong = new EncryptedSecretStore(path, join(dir, "a.log"), other.key);
  const wrongLoaded = await wrong.loadAll().catch(
    () => ({} as Record<string, string>),
  );
  assertEquals(Object.keys(wrongLoaded).length, 0);
});

Deno.test("secrets: admin key placeholder & strength rules", () => {
  assert(isPlaceholderAdminKey(undefined));
  assert(isPlaceholderAdminKey("PLACEHOLDER_CHANGE_ME"));
  assert(isPlaceholderAdminKey("short"));
  assertFalse(isPlaceholderAdminKey(STRONG));
  assert(validateAdminKeyStrength("aaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  assert(validateAdminKeyStrength("Short1!"));
  assertEquals(validateAdminKeyStrength(STRONG), null);
});

Deno.test("secrets: bootstrap, list hides values, whitelist, audit without values", async () => {
  const { dir, service, reloads } = await makeService({
    SERVER_API_KEY: "PLACEHOLDER_CHANGE_ME",
  });
  assert(service.isBootstrapRequired());
  await assertRejects(() => service.bootstrap("weak", "local"));
  await service.bootstrap(STRONG, "local");
  assertFalse(service.isBootstrapRequired());
  await assertRejects(() => service.bootstrap(STRONG, "local"));

  await service.update({ AI_API_KEY: SECRET, AI_MODEL: "gpt-x" }, "admin");
  assert(reloads() >= 1);
  assertEquals(getSecretOverlayValue("AI_API_KEY"), SECRET);
  const list = await service.list();
  const listed = JSON.stringify(list);
  assertFalse(listed.includes(SECRET));
  assertFalse(listed.includes(STRONG));
  const ai = list.find((f) => f.name === "AI_API_KEY")!;
  assert(ai.configured);
  assertEquals(ai.source, "store");
  assertEquals(list.find((f) => f.name === "AI_MODEL")!.value, "gpt-x");
  assertEquals(redactSensitiveText(`key=${SECRET}`).includes(SECRET), false);

  await assertRejects(() =>
    service.update({ PUBLISH_ENABLED: "true" }, "admin")
  );
  await assertRejects(() =>
    service.update({ WEIXIN_APP_ID: "not-an-appid" }, "admin")
  );
  await service.update({ AI_API_KEY: null }, "admin");
  assertEquals(getSecretOverlayValue("AI_API_KEY"), undefined);

  const audit = await Deno.readTextFile(
    join(dir, "secrets", "audit.log.jsonl"),
  );
  assertFalse(audit.includes(SECRET));
  assertFalse(audit.includes(STRONG));
  assertStringIncludes(audit, "AI_API_KEY");
  setSecretOverlay({});
});

function req(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`http://x${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

Deno.test("secrets api: bootstrap only from loopback, then bearer required, no echo", async () => {
  const { service } = await makeService({
    SERVER_API_KEY: "PLACEHOLDER_CHANGE_ME",
  });
  setSecretsService(service);
  const verify = (r: Request) =>
    Promise.resolve(
      r.headers.get("Authorization") ===
          `Bearer ${getSecretOverlayValue("SERVER_API_KEY")}`
        ? null
        : new Response("no", { status: 401 }),
    );
  const call = (r: Request, ip: string) =>
    handleSecretsRequest(r, new URL(r.url), ip, verify);

  const status = await (await call(
    req("GET", "/api/secrets/bootstrap-status"),
    "172.17.0.1",
  )).json();
  assertEquals(status.bootstrapRequired, true);
  assertEquals(status.clientIsLocal, false);
  assertEquals(
    (await call(req("GET", "/api/secrets"), "127.0.0.1")).status,
    403,
  );
  assertEquals(
    (await call(
      req("POST", "/api/secrets/bootstrap", { adminKey: STRONG }),
      "10.0.0.5",
    )).status,
    403,
  );
  const ok = await call(
    req("POST", "/api/secrets/bootstrap", { adminKey: STRONG }),
    "127.0.0.1",
  );
  assertEquals(ok.status, 200);
  assertFalse((await ok.text()).includes(STRONG));
  assertEquals(
    (await call(
      req("POST", "/api/secrets/bootstrap", { adminKey: STRONG }),
      "127.0.0.1",
    )).status,
    409,
  );

  assertEquals(
    (await call(req("GET", "/api/secrets"), "127.0.0.1")).status,
    401,
  );
  const put = await call(
    req(
      "PUT",
      "/api/secrets",
      { values: { WEIXIN_APP_SECRET: SECRET } },
      STRONG,
    ),
    "1.2.3.4",
  );
  assertEquals(put.status, 200);
  const putText = await put.text();
  assertFalse(putText.includes(SECRET));
  const get = await call(
    req("GET", "/api/secrets", undefined, STRONG),
    "1.2.3.4",
  );
  assertEquals(get.headers.get("Cache-Control"), "no-store");
  const getText = await get.text();
  assertFalse(getText.includes(SECRET));
  assertFalse(getText.includes(STRONG));
  setSecretOverlay({});
});

Deno.test("secrets api: loopback detection", () => {
  assert(isTrustedLocalAddress("127.0.0.1"));
  assert(isTrustedLocalAddress("::1"));
  assert(isTrustedLocalAddress("::ffff:127.0.0.1"));
  assertFalse(isTrustedLocalAddress("172.17.0.1"));
  assert(isTrustedLocalAddress("172.17.0.1", ["172.17.0.1"]));
  assertFalse(isTrustedLocalAddress(undefined));
});

Deno.test("connection tests: weixin maps 40164 and never returns token", async () => {
  const fail = {
    getAccessToken: () =>
      Promise.reject(
        new Error(
          "微信 API 错误 40164: invalid ip 1.2.3.4 ipv6 ::ffff:1.2.3.4, not in whitelist",
        ),
      ),
  };
  // deno-lint-ignore no-explicit-any
  const r1 = await testWeixinConnection(
    "wx1234567890abcdef",
    SECRET,
    fail as any,
  );
  assertFalse(r1.ok);
  assertEquals(r1.errcode, 40164);
  assertStringIncludes(r1.message, "IP 白名单");
  assertStringIncludes(r1.message, "1.2.3.4");
  const ok = {
    getAccessToken: () =>
      Promise.resolve({
        access_token: "TOKEN_SHOULD_NOT_LEAK_123",
        expires_in: 7200,
      }),
  };
  // deno-lint-ignore no-explicit-any
  const r2 = await testWeixinConnection(
    "wx1234567890abcdef",
    SECRET,
    ok as any,
  );
  assert(r2.ok);
  assertFalse(JSON.stringify(r2).includes("TOKEN_SHOULD_NOT_LEAK_123"));
  assertFalse((await testWeixinConnection(undefined, undefined)).ok);
});

Deno.test("connection tests: llm lists models via GET only", async () => {
  let method = "";
  let url = "";
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    url = String(input);
    method = init?.method ?? "GET";
    return Promise.resolve(
      new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), {
        status: 200,
      }),
    );
  }) as typeof fetch;
  const result = await testLlmConnection(
    "https://api.example.com/v1/",
    SECRET,
    "m2",
    fetchImpl,
  );
  assert(result.ok);
  assertEquals(method, "GET");
  assertStringIncludes(url, "/models");
  assertFalse(JSON.stringify(result).includes(SECRET));
  const bad =
    (() =>
      Promise.resolve(new Response("{}", { status: 401 }))) as typeof fetch;
  assertFalse(
    (await testLlmConnection("https://api.example.com/v1", SECRET, "m2", bad))
      .ok,
  );
});
