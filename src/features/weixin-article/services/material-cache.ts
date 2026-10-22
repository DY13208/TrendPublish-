import type { ContentPublisher } from "@src/core/ports/content-publisher.ts";
import type { PublishRecordStore } from "@src/core/ports/publish-record-store.ts";
import { sha256Hex } from "@src/features/weixin-article/services/publish-idempotency.service.ts";

/**
 * 封面素材 add_material 幂等：同一账号 + 同一图片 URL 只上传一次，之后复用 media_id。
 * （步骤重试或重复运行时不会重复占用素材库。）
 */
export function withMaterialCache<
  T extends Pick<ContentPublisher, "uploadImage">,
>(
  publisher: T,
  store: Pick<PublishRecordStore, "getMaterial" | "putMaterial">,
  accountId = "default",
): T {
  const original = publisher.uploadImage.bind(publisher);
  publisher.uploadImage = async (imageUrl: string) => {
    if (!imageUrl) return await original(imageUrl);
    const key = `cover:${await sha256Hex(`${accountId}|${imageUrl}`)}`;
    const cached = await store.getMaterial(key);
    if (cached) return cached;
    const mediaId = await original(imageUrl);
    if (mediaId) await store.putMaterial(key, mediaId);
    return mediaId;
  };
  return publisher;
}
