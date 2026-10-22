import { assert, assertEquals } from "@std/assert";
import { handleMcpPayload } from "@src/app/mcp/mcp-protocol.ts";
import { handleMcpHttpRequest } from "@src/app/mcp/mcp-http.ts";
import type { McpContext, McpPublisher } from "@src/app/mcp/mcp-tools.ts";
import { McpTaskStore } from "@src/app/mcp/mcp-task-store.ts";
import { MemoryPublishRecordStore } from "@src/core/storage/memory-publish-record-store.ts";
import { withMaterialCache } from "@src/features/weixin-article/services/material-cache.ts";
import {
  setPublishEnabledOverrideForTesting,
  setPublishModeOverrideForTesting,
} from "@src/utils/security/publish-guard.ts";
import {
  clearRegisteredSecrets,
  registerSecretValue,
} from "@src/utils/security/redact.ts";

const SOURCE_TEXT =
  "OpenAI 今日发布了新的推理模型，官方博客称其在数学与代码基准上显著提升，并同步开放 API。价格方面，输入每百万 token 收费较上一代下降，企业版将在下月提供更高的速率限制与数据驻留选项。";

function articleMarkdown(): string {
  const paragraphs = [
    "## 这次更新的关键",
    "这家公司把推理能力当成新一轮竞争的主战场：新版模型在官方给出的数学和编程测评里分数更高，同时第一天就向开发者开放接口，这和以往先给订阅用户、再逐步放开的节奏不同。",
    "## 对开发者意味着什么",
    "对正在做智能体和代码助手的团队来说，更关键的是成本。按照公开价目，输入侧单价比上一代低，长上下文任务的账单会明显下降；不过输出单价和速率限制仍需要在实际负载下测算，不能只看宣传数字。",
    "## 企业采购需要留意的点",
    "企业版承诺在下个月提供更高的调用上限和数据驻留选项，这对金融、政务等有合规要求的客户是前提条件。但在正式合同条款公布前，采购方应把可用区域、日志保留时间和退出机制写进评估清单。",
    "## 还有哪些不确定",
    "官方测评集合与第三方复现之间常有差距，尤其是在长链推理和工具调用场景。建议团队先用自己的回归用例做小流量对比，再决定是否迁移主流程；同时关注接口稳定性与限流策略的变化，避免上线后出现排队。",
    "## 怎么做一次靠谱的迁移评估",
    "第一步是把线上真实请求抽样成固定的评测集，覆盖短问答、长文档总结、多轮工具调用三类典型负载；第二步在同样的提示词和温度设置下分别跑新旧两代模型，记录正确率、平均延迟和每千次调用花费；第三步再让业务同学盲评输出质量，避免只依赖自动指标得出过于乐观的结论。",
    "## 给小团队的建议",
    "如果团队规模不大，没有精力维护复杂的评测平台，可以先挑选十几个最常见、最容易出错的场景做人工对照，把结果写进共享文档，每次模型升级都复用同一份清单。这样花费不多，却能在第一时间发现回退问题，也方便和老板解释为什么要换或者暂时不换。",
  ];
  return paragraphs.join("\n\n");
}

class FakePublisher implements McpPublisher {
  calls: string[] = [];
  uploadImage(url: string) {
    this.calls.push(`cover:${url}`);
    return Promise.resolve("cover-media-1");
  }
  uploadContentImage(url: string) {
    this.calls.push(`body:${url}`);
    return Promise.resolve("https://mmbiz.qpic.cn/x.png");
  }
  publishArticle() {
    this.calls.push("draft/add");
    return Promise.resolve({
      publishId: "draft-media-1",
      status: "draft" as const,
      publishedAt: new Date(),
      platform: "weixin",
    });
  }
  findExistingDraft() {
    return Promise.resolve(null);
  }
  submitFreePublish(mediaId: string) {
    this.calls.push(`submit:${mediaId}`);
    return Promise.resolve({ publishId: "pub-1" });
  }
  getFreePublishStatus() {
    return Promise.resolve({ publish_status: 1 });
  }
}

async function makeContext() {
  const dir = await Deno.makeTempDir();
  const publisher = new FakePublisher();
  const publishStore = new MemoryPublishRecordStore();
  const ctx: McpContext = {
    defaultAccountId: "default",
    defaultProfile: "technology",
    listSources: () =>
      Promise.resolve([{
        url: "https://news.ycombinator.com/",
        group: "default",
        kind: "url",
      }]),
    fetchContents: () =>
      Promise.resolve([{
        id: "1",
        title: "新推理模型发布",
        content: SOURCE_TEXT,
        url: "https://example.com/a",
        publishDate: new Date().toISOString(),
        metadata: {},
      }]),
    listHistory: () =>
      Promise.resolve([{
        title: "去年的旧闻：某公司裁员",
        sourceUrls: ["https://example.com/old"],
      }]),
    taskStore: new McpTaskStore(dir),
    publishStore,
    createPublisher: () =>
      withMaterialCache(publisher, publishStore, "default"),
    fetchSourceText: () => Promise.resolve(null),
  };
  return { ctx, publisher, dir };
}

async function call(
  ctx: McpContext,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await handleMcpPayload(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    () => Promise.resolve(ctx),
  );
  // deno-lint-ignore no-explicit-any
  const result = (response as any).result;
  return {
    isError: result.isError as boolean,
    text: result.content[0].text as string,
    data: result.structuredContent,
  };
}

Deno.test("mcp initialize, tools/list and notifications", async () => {
  const { ctx } = await makeContext();
  const init = await handleMcpPayload(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    },
    () => Promise.resolve(ctx),
  );
  // deno-lint-ignore no-explicit-any
  assertEquals((init as any).result.protocolVersion, "2025-03-26");
  const note = await handleMcpPayload({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }, () => Promise.resolve(ctx));
  assertEquals(note, null);
  const list = await handleMcpPayload({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  }, () => Promise.resolve(ctx));
  // deno-lint-ignore no-explicit-any
  const names = (list as any).result.tools.map((t: { name: string }) => t.name);
  for (
    const expected of [
      "trendpublish_list_sources",
      "trendpublish_fetch_hot_topics",
      "trendpublish_score_topics",
      "trendpublish_dedup_check",
      "trendpublish_get_writing_guidelines",
      "trendpublish_submit_article",
      "trendpublish_run_quality_gate",
      "trendpublish_upload_image",
      "trendpublish_create_draft",
      "trendpublish_publish",
      "trendpublish_get_status",
    ]
  ) {
    assert(names.includes(expected), expected);
  }
  const unknown = await handleMcpPayload({
    jsonrpc: "2.0",
    id: 3,
    method: "nope",
  }, () => Promise.resolve(ctx));
  // deno-lint-ignore no-explicit-any
  assertEquals((unknown as any).error.code, -32601);
});

Deno.test("mcp http transport: 202 for notifications, 405 for GET", async () => {
  const { ctx } = await makeContext();
  const factory = () => Promise.resolve(ctx);
  const notify = await handleMcpHttpRequest(
    new Request("http://x/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    }),
    factory,
  );
  assertEquals(notify.status, 202);
  const get = await handleMcpHttpRequest(new Request("http://x/mcp"), factory);
  assertEquals(get.status, 405);
  const ok = await handleMcpHttpRequest(
    new Request("http://x/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
    }),
    factory,
  );
  assertEquals((await ok.json()).result, {});
});

Deno.test("mcp read tools: sources, hot topics, scoring, dedup, guidelines", async () => {
  const { ctx } = await makeContext();
  assertEquals(
    (await call(ctx, "trendpublish_list_sources", {})).data.sources.length,
    1,
  );
  const hot = await call(ctx, "trendpublish_fetch_hot_topics", { limit: 5 });
  assertEquals(hot.data.items[0].title, "新推理模型发布");
  const scored = await call(ctx, "trendpublish_score_topics", {
    items: [
      { title: "去年的旧闻：某公司裁员", url: "https://example.com/old" },
      {
        title: "新推理模型发布，API 价格下降",
        publishDate: new Date().toISOString(),
      },
    ],
  });
  assertEquals(scored.data.ranked[0].title, "新推理模型发布，API 价格下降");
  assertEquals(scored.data.ranked[1].duplicate, true);
  const dedup = await call(ctx, "trendpublish_dedup_check", {
    title: "去年的旧闻：某公司裁员",
  });
  assertEquals(dedup.data.duplicate, true);
  const guide = await call(ctx, "trendpublish_get_writing_guidelines", {});
  assert(guide.data.styleGuide.length > 0);
  assertEquals(guide.data.writeOperations.publishEnabled, false);
});

Deno.test("mcp write flow enforces gate, PUBLISH_ENABLED, PUBLISH_MODE and idempotency", async () => {
  const { ctx, publisher } = await makeContext();
  setPublishEnabledOverrideForTesting(false);
  setPublishModeOverrideForTesting("draft");
  try {
    // 门禁不通过：来源不足 + 图片没有版权声明
    const bad = await call(ctx, "trendpublish_submit_article", {
      title: "短文",
      markdown: "太短了",
      sources: [{ url: "https://example.com/a" }],
      images: [{ url: "https://img/x.png", role: "cover" }],
    });
    const badGate = await call(ctx, "trendpublish_run_quality_gate", {
      taskId: bad.data.task.taskId,
    });
    assertEquals(badGate.data.allowed, false);
    const cats = badGate.data.issues.map((i: { category: string }) =>
      i.category
    );
    assert(cats.includes("facts") && cats.includes("copyright"));

    // 搬运原文 -> 版权风险拦截
    const copied = await call(ctx, "trendpublish_submit_article", {
      title: "搬运",
      markdown: (SOURCE_TEXT + "\n\n").repeat(6),
      sources: [{ url: "https://example.com/a", excerpt: SOURCE_TEXT }, {
        url: "https://example.com/b",
      }],
    });
    const copiedGate = await call(ctx, "trendpublish_run_quality_gate", {
      taskId: copied.data.task.taskId,
    });
    assertEquals(copiedGate.data.allowed, false);
    assert(
      copiedGate.data.issues.some((i: { message: string }) =>
        i.message.includes("重合度")
      ),
    );

    const args = {
      title: "推理模型降价之后，开发者该怎么算账",
      markdown: articleMarkdown() +
        "\n\n![配图](https://img.example.com/body.png)",
      sources: [{ url: "https://example.com/a", excerpt: SOURCE_TEXT }, {
        url: "https://example.com/b",
        title: "官方定价",
      }],
      images: [{
        url: "https://img.example.com/cover.png",
        role: "cover",
        rights: "generated",
      }, {
        url: "https://img.example.com/body.png",
        role: "body",
        rights: "own",
      }],
    };
    const submitted = await call(ctx, "trendpublish_submit_article", args);
    assertEquals(submitted.isError, false, submitted.text);
    const taskId = submitted.data.task.taskId;
    const again = await call(ctx, "trendpublish_submit_article", args);
    assertEquals(again.data.created, false);
    assertEquals(again.data.task.taskId, taskId);

    // 门禁未运行前不能建草稿
    const early = await call(ctx, "trendpublish_create_draft", { taskId });
    assertEquals(early.isError, true);

    const gate = await call(ctx, "trendpublish_run_quality_gate", { taskId });
    assertEquals(gate.data.allowed, true, JSON.stringify(gate.data.issues));

    // 总开关关闭：任何写操作被拒绝，且没有调用微信
    for (
      const tool of [
        "trendpublish_upload_image",
        "trendpublish_create_draft",
        "trendpublish_publish",
      ]
    ) {
      const r = await call(ctx, tool, {
        taskId,
        url: "https://img.example.com/cover.png",
      });
      assertEquals(r.isError, true);
      assert(r.text.includes("PUBLISH_ENABLED"));
    }
    assertEquals(publisher.calls.length, 0);

    setPublishEnabledOverrideForTesting(true);
    const noCover = await call(ctx, "trendpublish_create_draft", { taskId });
    assertEquals(noCover.isError, true);
    await call(ctx, "trendpublish_upload_image", {
      taskId,
      url: "https://img.example.com/cover.png",
    });
    await call(ctx, "trendpublish_upload_image", {
      taskId,
      url: "https://img.example.com/cover.png",
    });
    await call(ctx, "trendpublish_upload_image", {
      taskId,
      url: "https://img.example.com/body.png",
    });
    const undeclared = await call(ctx, "trendpublish_upload_image", {
      taskId,
      url: "https://evil/x.png",
    });
    assertEquals(undeclared.isError, true);

    const draft = await call(ctx, "trendpublish_create_draft", { taskId });
    assertEquals(draft.data.action, "created", draft.text);
    const draft2 = await call(ctx, "trendpublish_create_draft", { taskId });
    assertEquals(draft2.data.action, "reused");
    assertEquals(publisher.calls.filter((c) => c === "draft/add").length, 1);
    assertEquals(
      publisher.calls.filter((c) => c.startsWith("cover:")).length,
      1,
    );

    const blockedMode = await call(ctx, "trendpublish_publish", { taskId });
    assertEquals(blockedMode.isError, true);
    assert(blockedMode.text.includes("PUBLISH_MODE"));

    setPublishModeOverrideForTesting("publish");
    const pub = await call(ctx, "trendpublish_publish", { taskId });
    assertEquals(pub.data.record.status, "submitted", pub.text);
    await call(ctx, "trendpublish_publish", { taskId });
    assertEquals(
      publisher.calls.filter((c) => c.startsWith("submit:")).length,
      1,
    );

    const status = await call(ctx, "trendpublish_get_status", { taskId });
    assertEquals(status.data.publish.status, "submitted");
    assertEquals(status.data.task.gate.allowed, true);
  } finally {
    setPublishEnabledOverrideForTesting(undefined);
    setPublishModeOverrideForTesting(undefined);
  }
});

Deno.test("mcp tool output is redacted", async () => {
  const { ctx } = await makeContext();
  clearRegisteredSecrets();
  registerSecretValue("super-secret-key-123");
  ctx.listSources = () =>
    Promise.resolve([{
      url: "https://x/?access_token=abc123456&k=super-secret-key-123",
      group: "g",
      kind: "url",
    }]);
  const r = await call(ctx, "trendpublish_list_sources", {});
  assertEquals(r.text.includes("super-secret-key-123"), false);
  assertEquals(r.text.includes("abc123456"), false);
  clearRegisteredSecrets();
});
