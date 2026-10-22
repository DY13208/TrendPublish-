/**
 * 外部提交文章（MCP 客户端自行写作）的确定性质量门禁。
 *
 * 不依赖服务端大模型；任何一项 block 都会阻止建草稿/发布，且没有绕过参数。
 *  - 事实不足：来源数量/来源可核验性/正文长度不足；
 *  - 重复：与历史文章（编辑记忆、发布记录）重复；
 *  - 版权风险：正文与来源原文大段重合；图片未声明版权来源。
 */
export interface SubmissionSource {
  url: string;
  title?: string;
  excerpt?: string;
  /** 服务端抓取到的原文文本（可选）。 */
  fetchedText?: string;
}

export type ImageRights =
  | "generated"
  | "own"
  | "licensed"
  | "public_domain";

export interface SubmissionImage {
  url: string;
  role: "cover" | "body";
  rights?: ImageRights | string;
  credit?: string;
}

export interface DuplicateMatch {
  title: string;
  similarity: number;
  sharedSourceUrls: string[];
  createdAt?: string;
}

export interface SubmissionGateConfig {
  minSources: number;
  minVerifiableSources: number;
  minTextLength: number;
  duplicateTitleThreshold: number;
  maxSourceOverlap: number;
}

export const DEFAULT_SUBMISSION_GATE_CONFIG: SubmissionGateConfig = {
  minSources: 2,
  minVerifiableSources: 1,
  minTextLength: 600,
  duplicateTitleThreshold: 0.72,
  maxSourceOverlap: 0.3,
};

export interface SubmissionGateIssue {
  category: "facts" | "duplicate" | "copyright" | "format";
  severity: "block" | "warn";
  message: string;
}

export interface SubmissionGateResult {
  allowed: boolean;
  issues: SubmissionGateIssue[];
  metrics: {
    textLength: number;
    sourceCount: number;
    verifiableSources: number;
    maxSourceOverlap: number;
    duplicateMatches: DuplicateMatch[];
  };
}

const ALLOWED_RIGHTS = new Set([
  "generated",
  "own",
  "licensed",
  "public_domain",
]);

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForShingles(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function shingles(text: string, size: number): Set<string> {
  const normalized = normalizeForShingles(text);
  const result = new Set<string>();
  for (let i = 0; i + size <= normalized.length; i++) {
    result.add(normalized.slice(i, i + size));
  }
  return result;
}

/** 正文中有多少比例的 n-gram 也出现在来源文本里（包含度）。 */
export function sourceOverlapRatio(
  articleText: string,
  sourceText: string,
  size = 12,
): number {
  const articleShingles = shingles(articleText, size);
  if (articleShingles.size === 0) return 0;
  const sourceShingles = shingles(sourceText, size);
  let shared = 0;
  for (const shingle of articleShingles) {
    if (sourceShingles.has(shingle)) shared++;
  }
  return shared / articleShingles.size;
}

function bigrams(text: string): Set<string> {
  const normalized = normalizeForShingles(text);
  const result = new Set<string>();
  for (let i = 0; i + 2 <= normalized.length; i++) {
    result.add(normalized.slice(i, i + 2));
  }
  return result;
}

export function titleSimilarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return (2 * shared) / (left.size + right.size);
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_|^spm$|^from$/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.href.replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

export interface HistoryArticle {
  title: string;
  sourceUrls: string[];
  createdAt?: string;
}

export function findDuplicates(
  input: { title: string; sourceUrls: string[] },
  history: HistoryArticle[],
  threshold = DEFAULT_SUBMISSION_GATE_CONFIG.duplicateTitleThreshold,
): DuplicateMatch[] {
  const urls = new Set(input.sourceUrls.map(normalizeUrl));
  const matches: DuplicateMatch[] = [];
  for (const article of history) {
    const similarity = titleSimilarity(input.title, article.title);
    const sharedSourceUrls = article.sourceUrls
      .map(normalizeUrl)
      .filter((url) => urls.has(url));
    const sourceShareRatio = urls.size
      ? sharedSourceUrls.length / urls.size
      : 0;
    if (
      similarity >= threshold ||
      (sourceShareRatio >= 0.5 && similarity >= threshold / 2)
    ) {
      matches.push({
        title: article.title,
        similarity: Number(similarity.toFixed(3)),
        sharedSourceUrls,
        createdAt: article.createdAt,
      });
    }
  }
  return matches.sort((a, b) => b.similarity - a.similarity);
}

export function evaluateSubmissionGate(
  input: {
    title: string;
    html: string;
    sources: SubmissionSource[];
    images: SubmissionImage[];
    duplicateMatches: DuplicateMatch[];
  },
  config: SubmissionGateConfig = DEFAULT_SUBMISSION_GATE_CONFIG,
): SubmissionGateResult {
  const issues: SubmissionGateIssue[] = [];
  const text = htmlToPlainText(input.html);
  const validSources = input.sources.filter((source) =>
    /^https?:\/\//i.test(source.url)
  );
  const verifiable = validSources.filter((source) =>
    (source.fetchedText?.length ?? 0) >= 200 ||
    (source.excerpt?.length ?? 0) >= 80
  );

  if (!input.title.trim()) {
    issues.push({ category: "format", severity: "block", message: "标题为空" });
  }
  if (text.length < config.minTextLength) {
    issues.push({
      category: "facts",
      severity: "block",
      message:
        `正文过短（${text.length} 字 < ${config.minTextLength}），事实支撑不足`,
    });
  }
  if (validSources.length < config.minSources) {
    issues.push({
      category: "facts",
      severity: "block",
      message:
        `有效来源不足（${validSources.length} < ${config.minSources}），请提供可访问的来源链接`,
    });
  }
  if (verifiable.length < config.minVerifiableSources) {
    issues.push({
      category: "facts",
      severity: "block",
      message:
        "没有可核验的来源原文（需要来源摘录 excerpt ≥80 字，或服务端抓取到原文）",
    });
  }

  if (input.duplicateMatches.length > 0) {
    issues.push({
      category: "duplicate",
      severity: "block",
      message: `与历史文章重复：${
        input.duplicateMatches.slice(0, 3).map((m) =>
          `《${m.title}》(相似度 ${m.similarity})`
        ).join("、")
      }`,
    });
  }

  let maxOverlap = 0;
  for (const source of validSources) {
    const sourceText = source.fetchedText || source.excerpt || "";
    if (!sourceText) continue;
    const overlap = sourceOverlapRatio(text, sourceText);
    if (overlap > maxOverlap) maxOverlap = overlap;
    if (overlap > config.maxSourceOverlap) {
      issues.push({
        category: "copyright",
        severity: "block",
        message: `正文与来源 ${source.url} 重合度 ${
          (overlap * 100).toFixed(1)
        }%，超过 ${
          (config.maxSourceOverlap * 100).toFixed(0)
        }%，存在洗稿/搬运风险`,
      });
    }
  }
  for (const image of input.images) {
    if (!image.rights || !ALLOWED_RIGHTS.has(image.rights)) {
      issues.push({
        category: "copyright",
        severity: "block",
        message: `图片 ${image.url} 未声明合法版权来源（rights 需为 ${
          [...ALLOWED_RIGHTS].join("/")
        }）`,
      });
    }
  }

  return {
    allowed: !issues.some((issue) => issue.severity === "block"),
    issues,
    metrics: {
      textLength: text.length,
      sourceCount: validSources.length,
      verifiableSources: verifiable.length,
      maxSourceOverlap: Number(maxOverlap.toFixed(3)),
      duplicateMatches: input.duplicateMatches,
    },
  };
}
