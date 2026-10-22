import { join } from "node:path";
import {
  EncryptedSecretStore,
  loadOrCreateMasterKey,
} from "@src/app/secrets/encrypted-secret-store.ts";
import {
  ADMIN_KEY_FIELD,
  findSecretField,
  isPlaceholderAdminKey,
  SECRET_FIELDS,
  validateAdminKeyStrength,
} from "@src/app/secrets/secret-fields.ts";
import { setSecretOverlay } from "@src/utils/config/secret-overlay.ts";
import { registerSecretValue } from "@src/utils/security/redact.ts";
import { Logger } from "@zilla/logger";

const logger = new Logger("secrets");

export class SecretsError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "SecretsError";
  }
}

export interface SecretsServiceOptions {
  secretsDir?: string;
  keyFile?: string;
  masterKeyEnv?: string;
  /** 读取当前生效配置值（env + 覆盖层）。 */
  readEffective: (name: string) => string | undefined;
  /** 保存后热重载配置。 */
  reload: () => Promise<void>;
}

export interface SecretFieldStatus {
  name: string;
  label: string;
  group: string;
  secret: boolean;
  configured: boolean;
  source: "store" | "env" | "none";
  /** 仅非密钥字段返回值。 */
  value?: string;
  updatedAt?: string;
  hint?: string;
}

export class SecretsService {
  private constructor(
    private readonly store: EncryptedSecretStore,
    private readonly options: SecretsServiceOptions,
    readonly keySource: string,
    private values: Record<string, string>,
  ) {}

  static async create(options: SecretsServiceOptions): Promise<SecretsService> {
    const secretsDir = options.secretsDir ?? "data/secrets";
    const { key, source } = await loadOrCreateMasterKey({
      envValue: options.masterKeyEnv,
      keyFile: options.keyFile ?? "data/keys/master.key",
    });
    const store = new EncryptedSecretStore(
      join(secretsDir, "secrets.enc.json"),
      join(secretsDir, "audit.log.jsonl"),
      key,
    );
    const values = await store.loadAll();
    const service = new SecretsService(store, options, source, values);
    service.applyOverlay();
    if (source === "generated") {
      logger.warn("已生成新的主密钥文件，请单独备份（不要与加密存储放在一起）");
    }
    return service;
  }

  private applyOverlay(): void {
    for (const [name, value] of Object.entries(this.values)) {
      if (name === ADMIN_KEY_FIELD || findSecretField(name)?.secret !== false) {
        registerSecretValue(value);
      }
    }
    setSecretOverlay(this.values);
  }

  private async persist(name: string, value: string | null): Promise<void> {
    await this.store.set(name, value);
    if (value) this.values[name] = value;
    else delete this.values[name];
    this.applyOverlay();
    await this.options.reload();
  }

  isBootstrapRequired(): boolean {
    return isPlaceholderAdminKey(this.options.readEffective(ADMIN_KEY_FIELD));
  }

  async bootstrap(adminKey: string, actor: string): Promise<void> {
    if (!this.isBootstrapRequired()) {
      throw new SecretsError("已完成初始化", 409);
    }
    const problem = validateAdminKeyStrength(adminKey);
    if (problem) throw new SecretsError(problem);
    registerSecretValue(adminKey.trim());
    await this.persist(ADMIN_KEY_FIELD, adminKey.trim());
    await this.store.audit({
      actor,
      action: "bootstrap",
      field: ADMIN_KEY_FIELD,
    });
    logger.info(`[密钥] 管理员 key 已初始化（${actor}）`);
  }

  async rotateAdminKey(newKey: string, actor: string): Promise<void> {
    const problem = validateAdminKeyStrength(newKey);
    if (problem) throw new SecretsError(problem);
    if (newKey.trim() === this.options.readEffective(ADMIN_KEY_FIELD)) {
      throw new SecretsError("新 key 不能与当前 key 相同");
    }
    registerSecretValue(newKey.trim());
    await this.persist(ADMIN_KEY_FIELD, newKey.trim());
    await this.store.audit({
      actor,
      action: "rotate_admin_key",
      field: ADMIN_KEY_FIELD,
    });
    logger.info(`[密钥] 管理员 key 已轮换（${actor}）`);
  }

  async list(): Promise<SecretFieldStatus[]> {
    const meta = await this.store.meta();
    return SECRET_FIELDS.map((field) => {
      const inStore = Boolean(this.values[field.name]);
      const effective = this.options.readEffective(field.name) ?? "";
      const configured = Boolean(effective.trim());
      return {
        name: field.name,
        label: field.label,
        group: field.group,
        secret: field.secret,
        configured,
        source: inStore ? "store" : configured ? "env" : "none",
        value: field.secret ? undefined : effective || undefined,
        updatedAt: meta[field.name]?.updatedAt,
        hint: field.hint,
      };
    });
  }

  /** 批量更新：值为 null/"" 表示清除存储中的值（回退到环境变量）。 */
  async update(
    values: Record<string, unknown>,
    actor: string,
  ): Promise<string[]> {
    const changes: Array<[string, string | null]> = [];
    for (const [name, raw] of Object.entries(values)) {
      const field = findSecretField(name);
      if (!field) throw new SecretsError(`不允许设置的字段: ${name}`);
      if (raw !== null && typeof raw !== "string") {
        throw new SecretsError(`${name} 必须是字符串或 null`);
      }
      const value = typeof raw === "string" ? raw.trim() : null;
      if (value && value.length > 4096) throw new SecretsError(`${name} 过长`);
      if (value && field.pattern && !field.pattern.test(value)) {
        throw new SecretsError(
          `${field.label} 格式不正确${field.hint ? `（${field.hint}）` : ""}`,
        );
      }
      changes.push([name, value || null]);
    }
    for (const [name, value] of changes) {
      if (value) registerSecretValue(value);
      await this.store.set(name, value);
      if (value) this.values[name] = value;
      else delete this.values[name];
      await this.store.audit({
        actor,
        action: value ? "set" : "clear",
        field: name,
      });
    }
    this.applyOverlay();
    await this.options.reload();
    if (changes.length) {
      logger.info(
        `[密钥] ${actor} 更新字段: ${changes.map(([n]) => n).join(", ")}`,
      );
    }
    return changes.map(([name]) => name);
  }

  async recordTest(
    action: "test_weixin" | "test_llm",
    actor: string,
    ok: boolean,
  ) {
    await this.store.audit({ actor, action, result: ok ? "ok" : "failed" });
  }

  readAudit(limit?: number) {
    return this.store.readAudit(limit);
  }
}

let instance: SecretsService | undefined;

export function setSecretsService(service: SecretsService | undefined): void {
  instance = service;
}

export function getSecretsService(): SecretsService | undefined {
  return instance;
}
