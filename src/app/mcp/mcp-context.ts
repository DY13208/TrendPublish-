import { join } from "node:path";
import type { ResolvedTrendPublishConfig } from "@src/utils/config/define-config.ts";
import { parseArticleSources } from "@src/features/weixin-article/domain/article-source.ts";
import { createLocalWeixinArticleDependencies } from "@src/app/weixin-article/create-local-weixin-article-dependencies.ts";
import { createPublisher } from "@src/app/weixin-article/create-weixin-article-dependencies.ts";
import { getLocalPublishRecordStore } from "@src/app/weixin-article/publish-ops.ts";
import { createArticleNotifier } from "@src/app/weixin-article/notifications.ts";
import { SQLiteEditorialMemoryStore } from "@src/platform/local/sqlite-editorial-memory-store.ts";
import { withMaterialCache } from "@src/features/weixin-article/services/material-cache.ts";
import { htmlToPlainText } from "@src/features/weixin-article/services/article-submission-gate.service.ts";
import type { McpContext } from "@src/app/mcp/mcp-tools.ts";
import { McpTaskStore } from "@src/app/mcp/mcp-task-store.ts";
import type { PromptProfileName } from "@src/prompts/prompt-profile.ts";

const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

/** 服务端抓取来源原文（仅公网 http(s)，限时限量），用于事实/版权核验。 */
export async function fetchPublicSourceText(
  url: string,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    !/^https?:$/.test(parsed.protocol) || PRIVATE_HOST.test(parsed.hostname)
  ) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(parsed, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "TrendPublish-SourceCheck/1.0" },
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < 1_000_000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    await reader.cancel().catch(() => {});
    const text = new TextDecoder().decode(
      chunks.reduce((acc, c) => {
        const merged = new Uint8Array(acc.byteLength + c.byteLength);
        merged.set(acc);
        merged.set(c, acc.byteLength);
        return merged;
      }, new Uint8Array()),
    );
    return htmlToPlainText(text).slice(0, 50_000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createDefaultMcpContext(
  config: ResolvedTrendPublishConfig,
): McpContext {
  const outputDir = config.storage.artifacts.outputDir || "src/temp";
  const publishStore = getLocalPublishRecordStore(config);
  const editorialMemory = new SQLiteEditorialMemoryStore(
    config.storage.runtimeConfig.sqlitePath,
  );
  const defaultAccountId = config.features.article.publisher.accountId ||
    "default";
  return {
    defaultAccountId,
    defaultProfile: (config.features.article.renderer.promptProfile ??
      "technology") as PromptProfileName,
    listSources: () =>
      Promise.resolve(
        parseArticleSources(config.features.article.sources).map((s) => ({
          url: s.url,
          group: s.group,
          kind: s.kind,
        })),
      ),
    fetchContents: async ({ sourceUrl }) => {
      const deps = await createLocalWeixinArticleDependencies(config);
      const loaded = await deps.scrapeService.loadSources();
      const sources = sourceUrl
        ? loaded.sources.filter((s) => s.url === sourceUrl)
        : loaded.sources;
      if (sourceUrl && sources.length === 0) {
        throw new Error("该数据源不在已配置列表中");
      }
      const result = await deps.scrapeService.scrapeAllDetailed({
        sources,
        totalSources: sources.length,
      });
      return result.contents;
    },
    listHistory: async (accountId) => {
      const context = await editorialMemory.getContext({
        accountId,
        recentLimit: 200,
      });
      return context.recentArticles.map((a) => ({
        title: a.title,
        sourceUrls: a.sourceUrls ?? [],
        createdAt: a.createdAt,
      }));
    },
    taskStore: new McpTaskStore(join(Deno.cwd(), outputDir, "mcp-tasks")),
    publishStore,
    createPublisher: (accountId) =>
      withMaterialCache(
        createPublisher(
          config,
          accountId === "default" ? undefined : accountId,
        ),
        publishStore,
        accountId,
      ),
    notifier: createArticleNotifier(config),
    fetchSourceText: fetchPublicSourceText,
  };
}
