/**
 * 削除確認画面と削除action(設計 §5.5, §10.4, §13の`/documents/:documentId/delete`)。
 *
 * - loaderは確認画面を表示するためだけに使う。DBもBlobも更新しないため
 *   `assertSameOrigin`は呼ばない(AGENTS.md 7項の対象はcookie認証のmutation action)。
 * - 確認画面の表示可否も認可する(他人の資料の確認画面を見せない)が、これはUIの
 *   都合であって認可の根拠ではない。実際の削除可否はactionが`requireUser`と
 *   `requireDocumentDeletionScope`でDB更新の直前に再判定する(AGENTS.md 5項)。
 * - 確認画面のPOST(利用者が「削除する」を押した後)でだけ削除actionが動く
 *   (設計 §5.5「確認後にだけ削除actionを実行する」)。初期画面・資料表示画面の
 *   「削除」導線はこの確認画面への遷移であり、直接の削除ではない。
 * - 削除済み・未存在・UUID形式でない資料IDは、いずれも同じ404
 *   「資料が見つかりません」にする(設計 §10.4, §14)。
 */
import { Form } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/documents.$documentId.delete";
import { authorizeDocumentDeletion } from "~/lib/auth/authorization.server";
import { handleDocumentDeletion } from "~/lib/documents/delete.server";
import { findDocumentById } from "~/lib/db/documents.server";
import { securityHeaders } from "~/lib/security.server";
import { requireUser } from "~/lib/session.server";

const documentIdParamSchema = z.uuid();

export type DocumentDeleteConfirmData = {
  documentId: string;
  /** 確認のために表示する資料タイトル(設計 §5.5)。 */
  title: string;
};

export async function loader({
  request,
  params,
}: Route.LoaderArgs): Promise<DocumentDeleteConfirmData> {
  // 未ログインならここで`/auth/login?returnTo=...`へredirectする。
  const user = await requireUser(request);

  // UUID形式でない資料IDはDBへ触れる前に拒否し、未存在と同じ経路へ合流させる。
  const parsedDocumentId = documentIdParamSchema.safeParse(params.documentId);
  const document = parsedDocumentId.success
    ? await findDocumentById(parsedDocumentId.data)
    : null;

  // 削除できない利用者には確認画面自体を見せない。拒否の内容(403/404)と
  // メッセージは認可ヘルパーが決める(設計 §4.2, §14)。
  const decision = authorizeDocumentDeletion(user, document);
  if (!decision.allowed) {
    throw new Response(decision.message, { status: decision.status });
  }
  if (!document) {
    // `authorizeDocumentDeletion`が必ず拒否するため到達しないが、
    // 非nullを型として確定させるためのfail closedな保険。
    throw new Response("資料が見つかりません", { status: 404 });
  }

  return {
    documentId: document.id,
    title: document.title ?? document.originalFileName ?? "資料",
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response(null, {
      status: 405,
      headers: { Allow: "POST", ...securityHeaders() },
    });
  }
  return handleDocumentDeletion(request, params);
}

export const meta: Route.MetaFunction = () => [{ title: "資料みて！" }];

export default function DocumentDeleteConfirm({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  return (
    <section>
      <p className="eyebrow">資料みて！</p>
      <h1>資料を削除しますか？</h1>

      <div className="card">
        <h2>{loaderData.title}</h2>
        <p className="notice" role="alert">
          削除すると、この資料は元に戻せません。同じURLでも表示できなくなります。
        </p>
      </div>

      {actionData && (
        <div className="notice" role="alert">
          <p>{actionData.message}</p>
          <p className="correlation-id">相関ID: {actionData.correlationId}</p>
        </div>
      )}

      <div className="document-view-actions">
        {/* 確認後にだけ削除actionを実行する(設計 §5.5)。 */}
        <Form method="post">
          <button type="submit" className="button">
            削除する
          </button>
        </Form>
        <a className="button button-secondary" href="/app">
          キャンセル
        </a>
      </div>
    </section>
  );
}
