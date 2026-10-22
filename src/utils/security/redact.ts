const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [
    /((?:access_token|api_key|apikey|apiKey|appsecret|app_secret|secret|token|password|key)=)[^&\s"']+/gi,
    "$1[REDACTED]",
  ],
  [/(Authorization\s*:\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, "$1[REDACTED]"],
  [
    /("(?:access_token|apiKey|api_key|appSecret|app_secret|secret|token|password|bearerToken)"\s*:\s*")[^"]+(")/gi,
    "$1[REDACTED]$2",
  ],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]"],
];

const SECRET_NAME_PATTERN = /(key|secret|token|password|passwd|credential)/i;
const MIN_SECRET_LENGTH = 6;
const knownSecrets = new Set<string>();

/** 注册需要在日志中屏蔽的密钥值（只在内存中保存）。 */
export function registerSecretValue(value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return;
  knownSecrets.add(trimmed);
}

/** 递归扫描对象，字段名像密钥（key/secret/token/password）的字符串值都会被注册。 */
export function registerSecretsFromObject(value: unknown, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 8) return;
  for (
    const [name, child] of Object.entries(value as Record<string, unknown>)
  ) {
    if (typeof child === "string") {
      if (SECRET_NAME_PATTERN.test(name)) registerSecretValue(child);
    } else if (child && typeof child === "object") {
      registerSecretsFromObject(child, depth + 1);
    }
  }
}

/** 从环境变量注册密钥（变量名包含 KEY/SECRET/TOKEN/PASSWORD）。 */
export function registerSecretsFromEnv(): void {
  try {
    const env = (globalThis as { Deno?: typeof Deno }).Deno?.env?.toObject();
    if (!env) return;
    for (const [name, value] of Object.entries(env)) {
      if (SECRET_NAME_PATTERN.test(name)) registerSecretValue(value);
    }
  } catch {
    // 无 env 权限或非 Deno 运行时时忽略。
  }
}

export function clearRegisteredSecrets(): void {
  knownSecrets.clear();
}

export function redactSensitiveText(value: unknown): string {
  const text = typeof value === "string" ? value : stringifyForRedaction(value);
  let result = REDACTION_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text,
  );
  for (const secret of knownSecrets) {
    if (result.includes(secret)) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  return result;
}

/** 对日志上下文做脱敏，尽量保持原始结构。 */
export function redactValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (value instanceof Error) return redactError(value) as T;
  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      if (json === undefined) return value;
      const redacted = redactSensitiveText(json);
      return (redacted === json ? value : JSON.parse(redacted)) as T;
    } catch {
      return value;
    }
  }
  return value;
}

export function redactError(error: unknown): Error {
  if (error instanceof Error) {
    const redacted = new Error(redactSensitiveText(error.message));
    redacted.name = error.name;
    redacted.stack = error.stack ? redactSensitiveText(error.stack) : undefined;
    return redacted;
  }
  return new Error(redactSensitiveText(error));
}

let consoleInstalled = false;

/** 包装 console.*，所有直接打印到控制台的内容也经过脱敏。 */
export function installConsoleRedaction(): void {
  if (consoleInstalled) return;
  consoleInstalled = true;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) =>
      original(...args.map((arg) => redactValue(arg)));
  }
}

function stringifyForRedaction(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
