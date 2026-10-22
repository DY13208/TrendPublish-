import { initSecretsStore } from "@src/app/secrets/init-secrets.ts";
import { startCronJobs } from "@src/controllers/cron.ts";
import {
  initializeAppConfig,
  parseConfigArgs,
  validateAppConfig,
} from "@src/utils/config/app-config.ts";
import { Logger, LogLevel } from "@zilla/logger";
import startServer from "@src/server.ts";
import {
  installConsoleRedaction,
  registerSecretsFromEnv,
  registerSecretsFromObject,
} from "@src/utils/security/redact.ts";
import { isPublishEnabled } from "@src/utils/security/publish-guard.ts";
async function bootstrap() {
  installConsoleRedaction();
  registerSecretsFromEnv();
  const parsedArgs = parseConfigArgs(Deno.args);
  await initSecretsStore();
  const config = await initializeAppConfig({
    configPath: parsedArgs.configPath,
  });
  registerSecretsFromObject(config);
  await validateAppConfig({ requireLLM: true });

  Logger.level = LogLevel.INFO;
  new Logger("bootstrap").info(
    isPublishEnabled()
      ? "PUBLISH_ENABLED=true：允许真实微信写操作"
      : "PUBLISH_ENABLED 未开启：全局强制 dry-run，禁止任何微信写操作",
  );

  await startCronJobs();
  startServer(config.server.port);
}

bootstrap().catch(console.error);
