import { marked } from "npm:marked@4.2.3";
import { WXRenderer } from "@src/modules/md-converter/renderer/WXRenderer/WXRenderer.ts";
import { defaultTheme } from "@src/modules/md-converter/themes/default.ts";
import type { ScrapedContent } from "@src/core/ports/content-scraper.ts";
import type {
  PublishResult,
  WeixinFreePublishStatus,
} from "@src/core/ports/content-publisher.ts";
import type {
  PublishRecord,
  PublishRecordStore,
} from "@src/core/ports/publish-record-store.ts";
import type { INotifier } from "@src/core/ports/notifier.ts";
import { postProcessDynamicHtml } from "@src/features/weixin-article/rendering/dynamic/html-post-processor.ts";
import {
  computePublishTaskIdentity,
  guardedPublish,
} from "@src/features/weixin-article/services/publish-idempotency.service.ts";
import { FreePublishService } from "@src/features/weixin-article/services/freepublish.service.ts";
import {
  evaluateSubmissionGate,
  findDuplicates,
  type HistoryArticle,
  htmlToPlainText,
  type SubmissionImage,
  type SubmissionSource,
  titleSimilarity,
} from "@src/features/weixin-article/services/article-submission-gate.service.ts";
import {
  getChineseNewsroomStyleGuide,
  listPromptProfileNames,
  type PromptProfileName,
  resolvePromptProfile,
} from "@src/prompts/prompt-profile.ts";
import {
  getPublishMode,
  isPublishEnabled,
  PublishDisabledError,
} from "@src/utils/security/publish-guard.ts";
import type {
  McpTask,
  McpTaskImage,
  McpTaskStore,
} from "@src/app/mcp/mcp-task-store.ts";

export interface McpPublisher {
  uploadImage(imageUrl: string): Promise<string>;
  uploadContentImage(imageUrl: string): Promise<string>;
  publishArticle(request: {
    content: string;
    title: string;
    digest: string;
    coverMediaId: string;
  }): Promise<PublishResult>;
  findExistingDraft?(title: string): Promise<string | null>;
  submitFreePublish?(mediaId: string): Promise<{ publishId: string }>;
  getFreePublishStatus?(publishId: string): Promise<WeixinFreePublishStatus>;
}

/** MCP 工具运行上下文（依赖注入，便于测试；默认实现见 mcp-context.ts）。 */
export interface McpContext {
  defaultAccountId: string;
  defaultProfile: PromptProfileName;
  listSources(): Promise<Array<{ url: string; group: string; kind: string }>>;
  fetchContents(options: { sourceUrl?: string }): Promise<ScrapedContent[]>;
  listHistory(accountId: string): Promise<HistoryArticle[]>;
  taskStore: McpTaskStore;
  publishStore: PublishRecordStore;
  createPublisher(accountId: string): McpPublisher;
  notifier?: Pick<INotifier, "error" | "success">;
  /** 服务端抓取来源原文（用于事实/版权核验，可选）。 */
  fetchSourceText?(url: string): Promise<string | null>;
}

export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  handler: (args: Record<string, unknown>, ctx: McpContext) => Promise<unknown>;
}

const str = (value: unknown, name: string, required = true): string => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!required) return "";
  throw new McpToolError(`参数 ${name} 必填且必须是字符串`);
};

const num = (value: unknown, fallback: number, max: number): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
};

function requirePublishEnabled(operation: string): void {
  if (!isPublishEnabled()) throw new PublishDisabledError(operation);
}

export function renderMarkdownToWeixinHtml(markdown: string): string {
  const renderer = new WXRenderer({ theme: defaultTheme });
  marked.use({ renderer: renderer.assemble() });
  return marked(markdown) as string;
}

export function sanitizeArticleHtml(html: string): string {
  const trimmed = html.trim();
  const wrapped = /^<section\b/i.test(trimmed)
    ? trimmed
    : `<section>${trimmed}</section>`;
  return postProcessDynamicHtml(wrapped).html;
}

function excerpt(text: string, length = 280): string {
  const plain = text.replace(/\s+/g, " ").trim();
  return plain.length > length ? `${plain.slice(0, length)}…` : plain;
}

function publicRecord(record: PublishRecord | null) {
  if (!record) return null;
  return {
    taskId: record.taskId,
    status: record.status,
    mediaId: record.mediaId,
    freepublishId: record.freepublishId,
    publishStatusCode: record.publishStatusCode,
    articleUrl: record.articleUrl,
    failIdx: record.failIdx,
    pollAttempts: record.pollAttempts,
    nextPollAt: record.nextPollAt,
    submitStarted: Boolean(record.submitStartedAt),
    attempts: record.attempts,
    lastError: record.lastError,
    updatedAt: record.updatedAt,
  };
}

function publicTask(task: McpTask) {
  return {
    taskId: task.taskId,
    accountId: task.accountId,
    title: task.title,
    digest: task.digest,
    status: task.status,
    contentHash: task.contentHash,
    sources: task.sources.map((s) => ({ url: s.url, title: s.title })),
    images: task.images.map((i) => ({
      url: i.url,
      role: i.role,
      rights: i.rights,
      uploaded: Boolean(i.weixinMediaId || i.weixinUrl),
    })),
    gate: task.gate
      ? {
        allowed: task.gate.allowed,
        issues: task.gate.issues,
        metrics: task.gate.metrics,
        evaluatedAt: task.gate.evaluatedAt,
      }
      : null,
    updatedAt: task.updatedAt,
  };
}

async function requireTask(ctx: McpContext, taskId: string): Promise<McpTask> {
  const task = await ctx.taskStore.get(taskId);
  if (!task) throw new McpToolError(`任务不存在: ${taskId}`);
  return task;
}

function requireGatePassed(task: McpTask): void {
  if (
    task.status !== "gate_passed" || !task.gate?.allowed ||
    task.gate.contentHash !== task.contentHash
  ) {
    throw new McpToolError(
      "质量门禁未通过或未运行（不可绕过）。请先调用 trendpublish_run_quality_gate 并修正所有 block 问题后重新提交。",
    );
  }
}

const KEYWORD_STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "what",
  "how",
  "new",
]);

function extractKeywords(text: string): string[] {
  const latin = (text.toLowerCase().match(/[a-z][a-z0-9.+-]{2,}/g) ?? [])
    .filter((w) => !KEYWORD_STOP.has(w));
  const cjk = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const grams: string[] = [];
  for (const run of cjk) {
    for (let i = 0; i + 2 <= run.length; i++) grams.push(run.slice(i, i + 2));
  }
  return [...latin, ...grams];
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "trendpublish_list_sources",
    title: "列出数据源",
    description: "列出服务端配置的行业数据源（URL/RSS/搜索词）。只读。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: async (_args, ctx) => ({ sources: await ctx.listSources() }),
  },
  {
    name: "trendpublish_fetch_hot_topics",
    title: "抓取热点",
    description:
      "用服务端已配置的抓取通道抓取数据源最新内容，返回标题/链接/时间/摘要。只读（不调用大模型，不写微信）。",
    inputSchema: {
      type: "object",
      properties: {
        sourceUrl: {
          type: "string",
          description: "只抓取这个数据源（可选，需在已配置列表中）",
        },
        limit: {
          type: "number",
          description: "最多返回条数，默认 20，最大 100",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args, ctx) => {
      const limit = num(args.limit, 20, 100);
      const contents = await ctx.fetchContents({
        sourceUrl: str(args.sourceUrl, "sourceUrl", false) || undefined,
      });
      return {
        total: contents.length,
        items: contents.slice(0, limit).map((item) => ({
          id: item.id,
          title: item.title,
          url: item.url,
          publishDate: item.publishDate,
          excerpt: excerpt(item.content),
        })),
      };
    },
  },
  {
    name: "trendpublish_score_topics",
    title: "选题打分",
    description:
      "对候选选题做确定性打分（时效、跨来源热度、与写作方案的匹配度、与历史文章的新颖度），并标记与历史重复的候选。不调用大模型。",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              publishDate: { type: "string" },
              summary: { type: "string" },
            },
            required: ["title"],
          },
        },
        accountId: { type: "string" },
        profile: { type: "string", enum: listPromptProfileNames() },
      },
      required: ["items"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, ctx) => {
      if (!Array.isArray(args.items) || args.items.length === 0) {
        throw new McpToolError("items 不能为空");
      }
      const items = (args.items as Array<Record<string, unknown>>).slice(
        0,
        200,
      );
      const accountId = str(args.accountId, "accountId", false) ||
        ctx.defaultAccountId;
      const profile = resolvePromptProfile(
        (str(args.profile, "profile", false) ||
          ctx.defaultProfile) as PromptProfileName,
      );
      const history = await ctx.listHistory(accountId);
      const profileKeywords = new Set(
        extractKeywords(
          [...profile.preferredTopics, ...profile.selectionFocus].join(" "),
        ),
      );
      const lowValue = profile.lowValueSignals.join(" ");
      const keywordSets = items.map((item) =>
        new Set(extractKeywords(`${item.title ?? ""} ${item.summary ?? ""}`))
      );
      const frequency = new Map<string, number>();
      for (const set of keywordSets) {
        for (const k of set) frequency.set(k, (frequency.get(k) ?? 0) + 1);
      }
      const now = Date.now();
      const scored = items.map((item, index) => {
        const title = String(item.title ?? "");
        const keywords = [...keywordSets[index]];
        const heat = keywords.length
          ? keywords.reduce(
            (sum, k) => sum + ((frequency.get(k) ?? 1) - 1),
            0,
          ) / keywords.length
          : 0;
        const fit = keywords.length
          ? keywords.filter((k) => profileKeywords.has(k)).length /
            keywords.length
          : 0;
        const published = Date.parse(String(item.publishDate ?? ""));
        const ageHours = Number.isFinite(published)
          ? Math.max(0, (now - published) / 3_600_000)
          : 72;
        const recency = Math.max(0, 1 - ageHours / 168);
        const duplicates = findDuplicates(
          { title, sourceUrls: item.url ? [String(item.url)] : [] },
          history,
        );
        const maxHistorySimilarity = history.reduce(
          (max, h) => Math.max(max, titleSimilarity(title, h.title)),
          0,
        );
        const lowValuePenalty = titleSimilarity(title, lowValue) > 0.2 ? 10 : 0;
        const score = Math.round(
          35 * recency + 25 * Math.min(1, heat / 2) +
            25 * Math.min(1, fit * 3) +
            15 * (1 - maxHistorySimilarity) - lowValuePenalty,
        );
        return {
          title,
          url: item.url,
          score: duplicates.length ? 0 : Math.max(0, Math.min(100, score)),
          duplicate: duplicates.length > 0,
          duplicateOf: duplicates.slice(0, 2).map((d) => d.title),
          signals: {
            recency: Number(recency.toFixed(2)),
            crossSourceHeat: Number(heat.toFixed(2)),
            profileFit: Number(fit.toFixed(2)),
            novelty: Number((1 - maxHistorySimilarity).toFixed(2)),
          },
        };
      });
      return {
        profile: profile.id,
        ranked: scored.sort((a, b) => b.score - a.score),
      };
    },
  },
  {
    name: "trendpublish_dedup_check",
    title: "历史去重检查",
    description:
      "检查标题/来源是否与该账号历史文章重复（编辑记忆 + 发布记录）。只读。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        sourceUrls: { type: "array", items: { type: "string" } },
        accountId: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, ctx) => {
      const accountId = str(args.accountId, "accountId", false) ||
        ctx.defaultAccountId;
      const matches = findDuplicates(
        {
          title: str(args.title, "title"),
          sourceUrls: Array.isArray(args.sourceUrls)
            ? args.sourceUrls.map(String)
            : [],
        },
        await ctx.listHistory(accountId),
      );
      return { duplicate: matches.length > 0, matches };
    },
  },
  {
    name: "trendpublish_get_writing_guidelines",
    title: "写作规范",
    description:
      "返回账号写作方案（受众、语气、选题偏好、标题/排版/配图要求）、中文编辑风格指南，以及服务端质量门禁规则。写作前先读。",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", enum: listPromptProfileNames() },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: (args, ctx) => {
      const name = (str(args.profile, "profile", false) ||
        ctx.defaultProfile) as PromptProfileName;
      return Promise.resolve({
        profile: resolvePromptProfile(name),
        availableProfiles: listPromptProfileNames(),
        styleGuide: getChineseNewsroomStyleGuide(name),
        submissionRules: [
          "至少 2 个 http(s) 来源；至少 1 个来源附 excerpt（≥80 字原文摘录）或可被服务端抓取，用于事实与版权核验。",
          "正文纯文本 ≥ 600 字。",
          "正文与任一来源原文 12-gram 重合度 ≤ 30%（必须用自己的话改写，禁止搬运）。",
          "所有图片必须声明 rights：generated / own / licensed / public_domain。",
          "与该账号历史文章重复（标题相似或来源大量重合）会被拦截。",
          "门禁不通过不能建草稿或发布，且没有任何绕过参数。",
          "支持 markdown（服务端转为微信兼容 HTML）或 html（服务端清洗：去掉 script/style/外链等）。",
        ],
        writeOperations: {
          publishEnabled: isPublishEnabled(),
          publishMode: getPublishMode(),
        },
      });
    },
  },
  {
    name: "trendpublish_submit_article",
    title: "提交文章",
    description:
      "提交客户端写好的文章，服务端生成确定性 taskId（账号 + 业务键/内容哈希）并持久化 HTML/Markdown/来源/图片/日志。重复提交同一内容返回同一任务。不会写微信。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        markdown: { type: "string", description: "与 html 二选一" },
        html: { type: "string", description: "与 markdown 二选一" },
        digest: {
          type: "string",
          description: "摘要（≤120 字），默认取正文开头",
        },
        author: { type: "string" },
        accountId: { type: "string" },
        businessKey: {
          type: "string",
          description: "可选业务键；同一业务键视为同一任务",
        },
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              title: { type: "string" },
              excerpt: {
                type: "string",
                description: "来源原文摘录，用于核验",
              },
            },
            required: ["url"],
          },
        },
        images: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              role: { type: "string", enum: ["cover", "body"] },
              rights: {
                type: "string",
                enum: ["generated", "own", "licensed", "public_domain"],
              },
              credit: { type: "string" },
            },
            required: ["url", "role"],
          },
        },
      },
      required: ["title", "sources"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (args, ctx) => {
      const title = str(args.title, "title");
      const markdown = typeof args.markdown === "string"
        ? args.markdown
        : undefined;
      const rawHtml = typeof args.html === "string" ? args.html : undefined;
      if (!markdown && !rawHtml) {
        throw new McpToolError("markdown 与 html 必须提供一个");
      }
      let html: string;
      try {
        html = sanitizeArticleHtml(
          markdown ? renderMarkdownToWeixinHtml(markdown) : rawHtml!,
        );
      } catch (error) {
        throw new McpToolError(
          `HTML 不符合微信要求: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const accountId = str(args.accountId, "accountId", false) ||
        ctx.defaultAccountId;
      const businessKey = str(args.businessKey, "businessKey", false) ||
        undefined;
      const identity = await computePublishTaskIdentity({
        accountId,
        title,
        content: html,
        businessKey,
      });
      const existing = await ctx.taskStore.get(identity.taskId);
      if (existing) {
        if (existing.contentHash !== identity.contentHash) {
          throw new McpToolError(
            `业务键 ${businessKey} 已对应另一篇内容（taskId=${identity.taskId}），为防止重复发布拒绝覆盖`,
          );
        }
        return { created: false, task: publicTask(existing) };
      }
      const sources: SubmissionSource[] =
        (Array.isArray(args.sources) ? args.sources : [])
          .slice(0, 30)
          .map((s: Record<string, unknown>) => ({
            url: String(s.url ?? ""),
            title: s.title ? String(s.title) : undefined,
            excerpt: s.excerpt ? String(s.excerpt).slice(0, 20_000) : undefined,
          }));
      const images: McpTaskImage[] =
        (Array.isArray(args.images) ? args.images : [])
          .slice(0, 30)
          .map((i: Record<string, unknown>) => ({
            url: String(i.url ?? ""),
            role: i.role === "cover" ? "cover" : "body",
            rights: i.rights ? String(i.rights) : undefined,
            credit: i.credit ? String(i.credit) : undefined,
          }));
      const now = new Date().toISOString();
      const task: McpTask = {
        ...identity,
        title,
        digest: (str(args.digest, "digest", false) ||
          excerpt(htmlToPlainText(html), 110)).slice(0, 120),
        author: str(args.author, "author", false) || undefined,
        sources,
        images,
        status: "submitted",
        createdAt: now,
        updatedAt: now,
      };
      await ctx.taskStore.create(task, { html, markdown });
      await ctx.taskStore.log(task.taskId, "submitted", {
        title,
        sources: sources.length,
      });
      return { created: true, task: publicTask(task) };
    },
  },
  {
    name: "trendpublish_run_quality_gate",
    title: "运行质量门禁",
    description:
      "对已提交任务运行服务端确定性质量门禁：事实不足、历史重复、版权风险（与来源重合度、图片版权声明）。结果持久化；未通过的任务不能建草稿/发布。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        fetchSources: {
          type: "boolean",
          description: "是否由服务端抓取来源原文核验（默认 true）",
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (args, ctx) => {
      const task = await requireTask(ctx, str(args.taskId, "taskId"));
      const html = await ctx.taskStore.getHtml(task.taskId);
      const sources = [...task.sources];
      if (args.fetchSources !== false && ctx.fetchSourceText) {
        for (const source of sources) {
          if (/^https?:\/\//i.test(source.url)) {
            source.fetchedText =
              (await ctx.fetchSourceText(source.url).catch(() => null)) ??
                undefined;
          }
        }
      }
      const duplicateMatches = findDuplicates(
        { title: task.title, sourceUrls: task.sources.map((s) => s.url) },
        await ctx.listHistory(task.accountId),
      );
      const result = evaluateSubmissionGate({
        title: task.title,
        html,
        sources,
        images: task.images as SubmissionImage[],
        duplicateMatches,
      });
      task.gate = {
        ...result,
        evaluatedAt: new Date().toISOString(),
        contentHash: task.contentHash,
      };
      task.status = result.allowed ? "gate_passed" : "gate_blocked";
      await ctx.taskStore.save(task);
      await ctx.taskStore.log(task.taskId, "quality_gate", {
        allowed: result.allowed,
        issues: result.issues,
      });
      return {
        taskId: task.taskId,
        allowed: result.allowed,
        issues: result.issues,
        metrics: result.metrics,
      };
    },
  },
  {
    name: "trendpublish_upload_image",
    title: "上传图片到微信",
    description:
      "把任务中声明过的图片上传到微信：cover 走永久素材 add_material（按账号+URL 缓存，幂等），body 走 media/uploadimg。需要 PUBLISH_ENABLED=true 且门禁已通过。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        url: {
          type: "string",
          description: "必须是提交任务时 images 中声明过的 URL",
        },
      },
      required: ["taskId", "url"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    handler: async (args, ctx) => {
      requirePublishEnabled("mcp upload_image");
      const task = await requireTask(ctx, str(args.taskId, "taskId"));
      requireGatePassed(task);
      const url = str(args.url, "url");
      const image = task.images.find((i) => i.url === url);
      if (!image) {
        throw new McpToolError(
          "该图片未在任务中声明（需带 rights 版权声明重新提交）",
        );
      }
      if (image.weixinMediaId || image.weixinUrl) {
        return { taskId: task.taskId, url, role: image.role, reused: true };
      }
      const publisher = ctx.createPublisher(task.accountId);
      if (image.role === "cover") {
        image.weixinMediaId = await publisher.uploadImage(url);
      } else image.weixinUrl = await publisher.uploadContentImage(url);
      await ctx.taskStore.save(task);
      await ctx.taskStore.log(task.taskId, "image_uploaded", {
        url,
        role: image.role,
      });
      return { taskId: task.taskId, url, role: image.role, reused: false };
    },
  },
  {
    name: "trendpublish_create_draft",
    title: "创建公众号草稿",
    description:
      "用官方 draft/add 创建草稿。强制：PUBLISH_ENABLED=true、质量门禁通过（不可绕过）、封面已上传、正文图片已上传；按 taskId 幂等（重复调用不会重复建草稿）。",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, ctx) => {
      requirePublishEnabled("mcp create_draft");
      const task = await requireTask(ctx, str(args.taskId, "taskId"));
      requireGatePassed(task);
      const cover = task.images.find((i) => i.role === "cover");
      if (!cover?.weixinMediaId) {
        throw new McpToolError(
          "需要先声明并上传封面图（images 中 role=cover，再调用 trendpublish_upload_image）",
        );
      }
      let html = await ctx.taskStore.getHtml(task.taskId);
      for (const image of task.images.filter((i) => i.role === "body")) {
        if (!image.weixinUrl) {
          throw new McpToolError(`正文图片未上传: ${image.url}`);
        }
        html = html.split(image.url).join(image.weixinUrl);
      }
      const publisher = ctx.createPublisher(task.accountId);
      const outcome = await guardedPublish({
        store: ctx.publishStore,
        identity: task,
        title: task.title,
        runId: `mcp-${task.taskId}`,
        publish: () =>
          publisher.publishArticle({
            content: html,
            title: task.title,
            digest: task.digest,
            coverMediaId: cover.weixinMediaId!,
          }),
        findExistingDraft: publisher.findExistingDraft
          ? (title) => publisher.findExistingDraft!(title)
          : undefined,
      });
      await ctx.taskStore.log(task.taskId, "draft", { action: outcome.action });
      return {
        taskId: task.taskId,
        action: outcome.action,
        record: publicRecord(await ctx.publishStore.get(task.taskId)),
      };
    },
  },
  {
    name: "trendpublish_publish",
    title: "正式发布",
    description:
      "对已建草稿调用官方 freepublish/submit 正式发布，之后由服务端定时轮询 freepublish/get。强制：PUBLISH_ENABLED=true 且 PUBLISH_MODE=publish；同一草稿永不重复提交。",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: true,
      openWorldHint: true,
    },
    handler: async (args, ctx) => {
      requirePublishEnabled("mcp publish");
      if (getPublishMode() !== "publish") {
        throw new McpToolError(
          "PUBLISH_MODE 不是 publish，正式发布被拒绝（当前只允许建草稿）",
        );
      }
      const task = await requireTask(ctx, str(args.taskId, "taskId"));
      requireGatePassed(task);
      const publisher = ctx.createPublisher(task.accountId);
      if (!publisher.submitFreePublish || !publisher.getFreePublishStatus) {
        throw new McpToolError("当前发布通道不支持正式发布");
      }
      const service = new FreePublishService(
        ctx.publishStore,
        {
          submitFreePublish: (id) => publisher.submitFreePublish!(id),
          getFreePublishStatus: (id) => publisher.getFreePublishStatus!(id),
        },
        ctx.notifier,
      );
      const record = await service.submit(task.taskId);
      await ctx.taskStore.log(task.taskId, "freepublish_submit", {
        status: record.status,
      });
      return { taskId: task.taskId, record: publicRecord(record) };
    },
  },
  {
    name: "trendpublish_get_status",
    title: "查询任务与发布状态",
    description:
      "返回任务（门禁结果、图片上传情况）与发布记录（草稿/提交/发布/失败、文章链接）。refresh=true 且已开启发布时立即查询一次 freepublish/get。",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, refresh: { type: "boolean" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, ctx) => {
      const taskId = str(args.taskId, "taskId");
      const task = await ctx.taskStore.get(taskId);
      let record = await ctx.publishStore.get(taskId);
      if (!task && !record) throw new McpToolError(`任务不存在: ${taskId}`);
      if (
        args.refresh === true && record?.status === "submitted" &&
        isPublishEnabled()
      ) {
        const publisher = ctx.createPublisher(record.accountId);
        if (publisher.submitFreePublish && publisher.getFreePublishStatus) {
          record = await new FreePublishService(
            ctx.publishStore,
            {
              submitFreePublish: (id) => publisher.submitFreePublish!(id),
              getFreePublishStatus: (id) => publisher.getFreePublishStatus!(id),
            },
            ctx.notifier,
          ).pollOnce(taskId);
        }
      }
      return {
        task: task ? publicTask(task) : null,
        publish: publicRecord(record),
        writeOperations: {
          publishEnabled: isPublishEnabled(),
          publishMode: getPublishMode(),
        },
      };
    },
  },
];
