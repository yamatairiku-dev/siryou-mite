/**
 * プレビュー画像resource route(設計 §5.2, §5.3, §7.3, §13の
 * `/documents/:documentId/preview`、QUESTIONS.md Q-030)。
 *
 * - `ready`の資料のプレビュー画像(非公開Blob)を、認証・閲覧認可のうえで
 *   同一オリジンの`image/jpeg`応答として中継する。画面(Componentやmeta)は持たない。
 * - 認可・404の統一・Blob取得のtimeout・失敗時の運用ログは
 *   `~/lib/documents/preview-image.server.ts`に集約する(結合テストから同じ処理を
 *   実DB・Azuriteに対して実行できるようにするため)。
 * - GET専用でDB・Blobを更新しないため`assertSameOrigin`は呼ばない。監査もしない
 *   (Q-032、設計 §15.1)。
 */
import type { Route } from "./+types/documents.$documentId.preview";
import { handlePreviewImageRequest } from "~/lib/documents/preview-image.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  return handlePreviewImageRequest(request, params);
}
