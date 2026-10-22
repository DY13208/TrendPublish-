import { reloadAppConfig } from "@src/utils/config/app-config.ts";
import { getSecretOverlayValue } from "@src/utils/config/secret-overlay.ts";
import {
  SecretsService,
  setSecretsService,
} from "@src/app/secrets/secrets-service.ts";

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
}

/** 启动时加载加密密钥存储，并把解密值放入配置覆盖层（需在加载配置之前调用）。 */
export async function initSecretsStore(): Promise<SecretsService> {
  const service = await SecretsService.create({
    secretsDir: env("TRENDPUBLISH_SECRETS_DIR") ?? "data/secrets",
    keyFile: env("TRENDPUBLISH_MASTER_KEY_FILE") ?? "data/keys/master.key",
    masterKeyEnv: env("TRENDPUBLISH_MASTER_KEY"),
    readEffective: (name) => getSecretOverlayValue(name) ?? env(name),
    reload: async () => {
      await reloadAppConfig();
    },
  });
  setSecretsService(service);
  return service;
}
