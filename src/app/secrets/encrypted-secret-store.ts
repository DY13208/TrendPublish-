import { dirname } from "node:path";

/**
 * 加密密钥存储：每个值单独 AES-256-GCM 加密（随机 12 字节 IV，字段名作为 AAD）。
 * 文件只含密文；主密钥来自环境变量 TRENDPUBLISH_MASTER_KEY（base64 32 字节）
 * 或单独的密钥文件（默认 data/keys/master.key，首次自动生成，权限 600）。
 */
interface StoredEntry {
  iv: string;
  ct: string;
  updatedAt: string;
}

interface StoreFile {
  version: 1;
  entries: Record<string, StoredEntry>;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action:
    | "bootstrap"
    | "set"
    | "clear"
    | "rotate_admin_key"
    | "test_weixin"
    | "test_llm";
  field?: string;
  result?: "ok" | "failed";
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function loadOrCreateMasterKey(options: {
  envValue?: string;
  keyFile: string;
}): Promise<{ key: CryptoKey; source: "env" | "file" | "generated" }> {
  let raw: Uint8Array<ArrayBuffer> | undefined;
  let source: "env" | "file" | "generated" = "env";
  if (options.envValue?.trim()) {
    raw = unb64(options.envValue.trim());
  } else {
    try {
      raw = unb64((await Deno.readTextFile(options.keyFile)).trim());
      source = "file";
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      raw = crypto.getRandomValues(new Uint8Array(32));
      await Deno.mkdir(dirname(options.keyFile), { recursive: true });
      await Deno.writeTextFile(options.keyFile, b64(raw) + "\n", {
        mode: 0o600,
      });
      try {
        await Deno.chmod(options.keyFile, 0o600);
      } catch {
        // Windows 绑定挂载等环境可能不支持 chmod
      }
      source = "generated";
    }
  }
  if (raw.byteLength !== 32) {
    throw new Error("主密钥必须是 base64 编码的 32 字节");
  }
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  raw.fill(0);
  return { key, source };
}

export class EncryptedSecretStore {
  constructor(
    private readonly filePath: string,
    private readonly auditPath: string,
    private readonly key: CryptoKey,
  ) {}

  private async readFile(): Promise<StoreFile> {
    try {
      const parsed = JSON.parse(
        await Deno.readTextFile(this.filePath),
      ) as StoreFile;
      return parsed.version === 1 && parsed.entries
        ? parsed
        : { version: 1, entries: {} };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { version: 1, entries: {} };
      }
      throw error;
    }
  }

  private async writeFile(data: StoreFile): Promise<void> {
    await Deno.mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(data, null, 2), {
      mode: 0o600,
    });
    await Deno.rename(tmp, this.filePath);
  }

  /** 解密全部值（仅供进程内覆盖层使用，绝不返回给 API）。 */
  async loadAll(): Promise<Record<string, string>> {
    const data = await this.readFile();
    const result: Record<string, string> = {};
    for (const [name, entry] of Object.entries(data.entries)) {
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: unb64(entry.iv),
          additionalData: new TextEncoder().encode(name),
        },
        this.key,
        unb64(entry.ct),
      );
      result[name] = new TextDecoder().decode(plain);
    }
    return result;
  }

  async meta(): Promise<Record<string, { updatedAt: string }>> {
    const data = await this.readFile();
    return Object.fromEntries(
      Object.entries(data.entries).map((
        [name, entry],
      ) => [name, { updatedAt: entry.updatedAt }]),
    );
  }

  async set(name: string, value: string | null): Promise<void> {
    const data = await this.readFile();
    if (value === null || value === "") {
      delete data.entries[name];
    } else {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: new TextEncoder().encode(name),
          },
          this.key,
          new TextEncoder().encode(value),
        ),
      );
      data.entries[name] = {
        iv: b64(iv),
        ct: b64(ct),
        updatedAt: new Date().toISOString(),
      };
    }
    await this.writeFile(data);
  }

  async audit(entry: Omit<AuditEntry, "at">): Promise<void> {
    await Deno.mkdir(dirname(this.auditPath), { recursive: true });
    await Deno.writeTextFile(
      this.auditPath,
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
      { append: true, mode: 0o600 },
    );
  }

  async readAudit(limit = 100): Promise<AuditEntry[]> {
    try {
      const lines = (await Deno.readTextFile(this.auditPath)).trim().split("\n")
        .filter(Boolean);
      return lines.slice(-limit).reverse().map((line) =>
        JSON.parse(line) as AuditEntry
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  }
}
