export interface SecretFieldDefinition {
  name: string;
  label: string;
  group: "weixin" | "llm" | "image" | "embedding" | "notify";
  /** true：只写，API/UI 永不返回值。 */
  secret: boolean;
  /** 简单格式校验。 */
  pattern?: RegExp;
  hint?: string;
}

/** 可在 Dashboard 设置的字段白名单（PUBLISH_ENABLED 等开关故意不在其中）。 */
export const SECRET_FIELDS: SecretFieldDefinition[] = [
  {
    name: "WEIXIN_APP_ID",
    label: "公众号 AppID",
    group: "weixin",
    secret: false,
    pattern: /^wx[0-9a-zA-Z]{8,32}$/,
    hint: "以 wx 开头",
  },
  {
    name: "WEIXIN_APP_SECRET",
    label: "公众号 AppSecret",
    group: "weixin",
    secret: true,
    pattern: /^[0-9a-zA-Z]{16,64}$/,
  },
  { name: "WEIXIN_AUTHOR", label: "文章作者", group: "weixin", secret: false },
  {
    name: "AI_BASE_URL",
    label: "LLM Base URL（OpenAI 兼容）",
    group: "llm",
    secret: false,
    pattern: /^https?:\/\/\S+$/,
  },
  { name: "AI_API_KEY", label: "LLM API Key", group: "llm", secret: true },
  { name: "AI_MODEL", label: "LLM 模型", group: "llm", secret: false },
  {
    name: "DASHSCOPE_API_KEY",
    label: "DashScope（阿里云）图片/Embedding Key",
    group: "image",
    secret: true,
  },
  {
    name: "MINIMAX_API_KEY",
    label: "MiniMax 图片 Key",
    group: "image",
    secret: true,
  },
  {
    name: "EMBEDDING_BASE_URL",
    label: "Embedding Base URL（OpenAI 兼容）",
    group: "embedding",
    secret: false,
    pattern: /^https?:\/\/\S+$/,
  },
  {
    name: "EMBEDDING_API_KEY",
    label: "Embedding API Key",
    group: "embedding",
    secret: true,
  },
  {
    name: "EMBEDDING_MODEL",
    label: "Embedding 模型",
    group: "embedding",
    secret: false,
  },
  {
    name: "FEISHU_WEBHOOK_URL",
    label: "飞书机器人 Webhook",
    group: "notify",
    secret: true,
    pattern: /^https:\/\/\S+$/,
  },
  {
    name: "DINGTALK_WEBHOOK",
    label: "钉钉机器人 Webhook",
    group: "notify",
    secret: true,
    pattern: /^https:\/\/\S+$/,
  },
  {
    name: "BARK_URL",
    label: "Bark URL",
    group: "notify",
    secret: true,
    pattern: /^https:\/\/\S+$/,
  },
];

export const ADMIN_KEY_FIELD = "SERVER_API_KEY";

export function findSecretField(
  name: string,
): SecretFieldDefinition | undefined {
  return SECRET_FIELDS.find((field) => field.name === name);
}

const PLACEHOLDER_KEYS = new Set([
  "",
  "change-me",
  "changeme",
  "your-api-key",
  "placeholder",
]);

/** 管理员 key 为空/占位/过弱时需要先完成初始化。 */
export function isPlaceholderAdminKey(value: string | undefined): boolean {
  const key = (value ?? "").trim();
  return PLACEHOLDER_KEYS.has(key.toLowerCase()) || /^placeholder/i.test(key) ||
    key.length < 16;
}

export function validateAdminKeyStrength(value: string): string | null {
  const key = value.trim();
  if (isPlaceholderAdminKey(key)) {
    return "管理员 key 不能是占位值，且至少 16 位";
  }
  if (key.length < 24) return "管理员 key 至少 24 位";
  if (/\s/.test(key)) return "管理员 key 不能包含空白字符";
  const classes =
    [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(key)).length;
  if (key.length < 40 && classes < 3) {
    return "管理员 key 需包含大写、小写、数字、符号中的至少 3 类（或长度 ≥ 40）";
  }
  if (new Set(key).size < 10) return "管理员 key 重复字符过多";
  return null;
}
