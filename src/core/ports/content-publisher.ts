export interface ContentPublisher {
  // 上传图片到指定平台
  uploadImage(imageUrl: string): Promise<string>;

  // 发布文章到指定平台
  publishArticle(request: PublishArticleRequest): Promise<PublishResult>;
}

export interface ContentImageUploader {
  uploadContentImage(
    imageUrl: string,
    imageBuffer?: ArrayBuffer | Uint8Array,
  ): Promise<string>;
}

export interface PublishArticleRequest {
  content: string;
  title: string;
  digest: string;
  coverMediaId: string;
}

export interface PublishResult {
  publishId: string;
  url?: string;
  status: PublishStatus;
  publishedAt: Date;
  platform: string;
  accountId?: string;
  reason?: string;
}

export type PublishStatus =
  | "pending"
  | "published"
  | "failed"
  | "draft"
  | "scheduled"
  | "blocked";

/** 微信 freepublish/get 响应。 */
export interface WeixinFreePublishStatus {
  publish_id?: string | number;
  /** 0 成功, 1 发布中, 2 原创失败, 3 常规失败, 4 平台审核不通过, 5 成功后用户删除, 6 成功后系统封禁 */
  publish_status: number;
  article_id?: string;
  article_detail?: {
    count?: number;
    item?: Array<{ idx?: number; article_url?: string }>;
  };
  fail_idx?: number[];
}
