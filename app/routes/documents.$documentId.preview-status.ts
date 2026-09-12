/**
 * プレビュー状態resource route(設計 §5.3, §11.1, §13の
 * `/documents/:documentId/preview-status`)。
 *
 * - 初期画面のカードは、プレビュー生成がバックグラウンドで終わるまで
 *   「処理中」表示のままになる(設計 §5.3)。このrouteはカードが定期的に
 *   最新のプレビュー状態(`pending`/`ready`/`failed`)だけを取りに来るための
 *   read-only resource routeで、画面(Componentやmeta)は持たない。
 * - このloaderはDB・Blobを一切更新しない(mutationではない)ため、
 *   `assertSameOrigin`は呼ばない(AGENTS.md 7項は「cookie認証mutation
 *   action」が対象。GET専用でactionを持たないこのrouteには当てはまらない)。
 * - 認可は資料表示画面(`documents.$documentId.tsx`)と同じ`assertCanViewDocument`を
 *   使う。所有者以外でもURLを知っているログイン済み利用者は閲覧できる一方、
 *   `active`でない資料(削除済み・未存在)は同じ404にする(設計 §10.3(2), §14)。
 *   `documentId`がUUID形式でない場合もDBへ触れる前に同じ404へ合流させる
 *   (AGENTS.md 6項)。
 * - 応答にはプレビュー状態の表示に必要な最小限(`previewStatus`)だけを含め、
 *   ファイル名・メールアドレス・オーナーID・Blobキーなどの機微情報は返さない
 *   (設計 §14)。
 * - `error_category`の監査対象(設計 §15.1)はupload・view・delete・管理操作で、
 *   プレビュー状態の読み取りポーリングは対象に含まれていない。この
 *   routeは高頻度に呼ばれ得るポーリング用のため、ここで監査行を作ると
 *   ノイズになり本来の監査(閲覧・削除等)の分析を妨げる。よってこの
 *   routeでは`insertAuditEvent`を呼ばない(QUESTIONS.md Q-003への対応方針。
 *   司令塔判断が必要ならQUESTIONS.mdへの追記を検討)。
 * - 未認証・`documentId`検証前の要求を監査へ残さない方針(QUESTIONS.md
 *   Q-014/Q-021/Q-028)とも矛盾しない。
 */
import { z } from "zod";
import type { Route } from "./+types/documents.$documentId.preview-status";
import { assertCanViewDocument } from "~/lib/auth/authorization.server";
import { findDocumentById } from "~/lib/db/documents.server";
import { securityHeaders } from "~/lib/security.server";
import { requireUser } from "~/lib/session.server";

const documentIdParamSchema = z.uuid();

export type PreviewStatusBody = {
  previewStatus: import("~/lib/db/documents.server").PreviewStatus | null;
};

export async function loader({ request, params }: Route.LoaderArgs) {
  // 未ログインならここで`/auth/login?returnTo=...`へredirectする。
  const user = await requireUser(request);

  // UUID形式でない`documentId`はDBへ触れる前に拒否し、未存在と同じ404経路へ合流させる。
  const parsedDocumentId = documentIdParamSchema.safeParse(params.documentId);
  const document = parsedDocumentId.success
    ? await findDocumentById(parsedDocumentId.data)
    : null;

  // 資料表示画面と同じ認可(閲覧可否)。削除済み・未存在は同じ404にする。
  assertCanViewDocument(user, document);
  if (!document) {
    // 上の`assertCanViewDocument`が必ず例外を投げるため到達しないが、
    // 非nullを型として確定させるためのfail closedな保険。
    throw new Response("資料が見つかりません", { status: 404 });
  }

  const body: PreviewStatusBody = { previewStatus: document.previewStatus };
  return Response.json(body, { headers: securityHeaders() });
}
