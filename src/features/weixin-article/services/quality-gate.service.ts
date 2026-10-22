import type { ArticleQualityReview } from "@src/features/weixin-article/domain/quality-review.ts";
import type { ResolvedTrendPublishConfig } from "@src/utils/config/define-config.ts";

export interface QualityGateDecision {
  allowed: boolean;
  bypassed: boolean;
  reason: string;
  action: "allow" | "allow-dry-run" | "bypass" | "disabled" | "block";
}

export type ArticleQualityGateConfig =
  ResolvedTrendPublishConfig["features"]["article"]["qualityGate"];

export function evaluateArticleQualityGate(
  input: {
    review: ArticleQualityReview;
    config: ArticleQualityGateConfig;
    dryRun: boolean;
    forcePublish?: boolean;
  },
): QualityGateDecision {
  if (input.dryRun) {
    return {
      allowed: true,
      bypassed: false,
      action: "allow-dry-run",
      reason: "dry-run 不受质量门禁阻断",
    };
  }

  // 真实发布时即使配置关闭门禁（enabled=false）也强制评估，避免绕过。
  const blockReason = getQualityBlockReason(input.review, input.config);
  if (!blockReason) {
    return {
      allowed: true,
      bypassed: false,
      action: "allow",
      reason: "质量审稿通过",
    };
  }

  // 真实发布不允许绕过质量门禁：forcePublish（请求或配置）只记录，不再放行。
  const bypassRequested = input.config.forcePublish === true ||
    input.forcePublish === true;
  return {
    allowed: false,
    bypassed: false,
    action: "block",
    reason: bypassRequested
      ? `${blockReason}（已忽略 forcePublish：真实发布不允许绕过质量门禁）`
      : blockReason,
  };
}

function getQualityBlockReason(
  review: ArticleQualityReview,
  config: ArticleQualityGateConfig,
): string | null {
  const blocker = review.issues.find((issue) => issue.severity === "blocker");
  if (blocker) return `存在 blocker 问题: ${blocker.message}`;

  if (config.blockOnHighFactIssue) {
    const highFactIssue = review.issues.find((issue) =>
      issue.category === "fact" &&
      (issue.severity === "high" || issue.severity === "blocker")
    );
    if (highFactIssue) {
      return `存在高危事实问题: ${highFactIssue.message}`;
    }
  }

  if (!review.allowPublish) {
    return `审稿结论不允许发布: ${review.recommendedAction}`;
  }

  if (review.recommendedAction !== "publish") {
    return `审稿建议为 ${review.recommendedAction}`;
  }

  if (review.overallScore < config.minScore) {
    return `质量分 ${review.overallScore} 低于门禁 ${config.minScore}`;
  }

  return null;
}
