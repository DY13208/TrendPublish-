import { assert, assertEquals } from "@std/assert";
import {
  evaluateSubmissionGate,
  findDuplicates,
  sourceOverlapRatio,
} from "@src/features/weixin-article/services/article-submission-gate.service.ts";

Deno.test("overlap ratio detects copied text", () => {
  const source =
    "这是一段相当长的来源原文，用来测试正文是否大段搬运了来源内容，而不是用自己的话重新组织。";
  assert(sourceOverlapRatio(source, source) > 0.9);
  assert(
    sourceOverlapRatio(
      "完全不同的一句话，讲述另外一件事情，和来源没有任何关系的表达方式。",
      source,
    ) < 0.1,
  );
});

Deno.test("duplicate detection by title and shared sources", () => {
  const history = [{
    title: "OpenAI 发布新推理模型",
    sourceUrls: ["https://a.com/x?utm_source=1"],
  }];
  assertEquals(
    findDuplicates({ title: "OpenAI 发布新推理模型", sourceUrls: [] }, history)
      .length,
    1,
  );
  assertEquals(
    findDuplicates({
      title: "新推理模型发布：OpenAI 的价格",
      sourceUrls: ["https://a.com/x"],
    }, history).length,
    1,
  );
  assertEquals(
    findDuplicates({ title: "完全无关的芯片新闻", sourceUrls: [] }, history)
      .length,
    0,
  );
});

Deno.test("gate blocks duplicates and has no bypass", () => {
  const result = evaluateSubmissionGate({
    title: "t",
    html: `<section>${"内容".repeat(400)}</section>`,
    sources: [{ url: "https://a.com", excerpt: "x".repeat(100) }, {
      url: "https://b.com",
    }],
    images: [],
    duplicateMatches: [{
      title: "旧文",
      similarity: 0.9,
      sharedSourceUrls: [],
    }],
  });
  assertEquals(result.allowed, false);
  assertEquals(result.issues[0].category, "duplicate");
});
