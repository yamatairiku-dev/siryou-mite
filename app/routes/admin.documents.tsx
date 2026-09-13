/**
 * 管理画面: 全資料の検索・閲覧・強制削除の導線(設計 §5.6, §4.2, §13の
 * `/admin/documents`)。
 *
 * - loaderは`handleAdminDocumentSearch`が`requireAdmin`で認可してから検索する。
 *   この画面のリンクやボタンを隠すことは認可ではない(設計 §4.2、AGENTS.md 5項)。
 * - 強制削除はこの画面では実行しない。T14の削除確認画面
 *   `/documents/:documentId/delete`へGETで遷移し、確認後のPOSTでだけ削除される
 *   (設計 §5.5)。削除の認可も確認画面側のactionが再判定する。
 * - オーナー変更の操作は設けない(設計 §5.6「オーナー変更はできない」、§4.2)。
 * - 日時は日本時間`YYYY/MM/DD HH:mm`で表示し、検索条件の日時も日本時間として
 *   解釈する(設計 §5.2)。
 */
import { Form } from "react-router";
import type { Route } from "./+types/admin.documents";
import {
  handleAdminDocumentSearch,
  type AdminDocumentSearchCriteria,
  type AdminDocumentSearchData,
} from "~/lib/admin/document-search.server";
import {
  formatByteSize,
  formatJstDateTime,
  formatPreviewStatus,
  previewImageSrc,
} from "~/lib/format/document-view";

export async function loader({
  request,
}: Route.LoaderArgs): Promise<AdminDocumentSearchData> {
  return handleAdminDocumentSearch(request);
}

export const meta: Route.MetaFunction = () => [
  { title: "資料みて！ 管理画面" },
];

/**
 * 次ページ(keyset pagination)のURL。検索条件はcursorに含まれないため、
 * 同じ条件をクエリ文字列へ引き継ぐ。
 */
function nextPageHref(
  criteria: AdminDocumentSearchCriteria,
  nextCursor: string,
): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(criteria)) {
    if (name !== "cursor" && value !== "") {
      params.set(name, value);
    }
  }
  params.set("cursor", nextCursor);
  return `/admin/documents?${params.toString()}`;
}

export default function AdminDocuments({ loaderData }: Route.ComponentProps) {
  const { criteria, page } = loaderData;

  return (
    <section>
      <p className="eyebrow">資料みて！ 管理画面</p>
      <h1>全資料の検索</h1>
      <p className="lead">
        資料ID、オーナーのメールアドレス、元ファイル名、アップロード日時で検索できます。
        条件を空欄にすると絞り込みません。
      </p>

      {/* 検索は読み取りのみのGET。cursorは含めないため、検索するたびに1ページ目へ戻る。 */}
      <Form method="get" className="card admin-search-form">
        <div>
          <label htmlFor="documentId">資料ID</label>
          <input
            id="documentId"
            name="documentId"
            type="text"
            maxLength={36}
            defaultValue={criteria.documentId}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </div>
        <div>
          <label htmlFor="ownerEmail">オーナーのメールアドレス</label>
          <input
            id="ownerEmail"
            name="ownerEmail"
            type="text"
            maxLength={320}
            defaultValue={criteria.ownerEmail}
          />
        </div>
        <div>
          <label htmlFor="fileName">元ファイル名</label>
          <input
            id="fileName"
            name="fileName"
            type="text"
            maxLength={1000}
            defaultValue={criteria.fileName}
          />
        </div>
        <div>
          <label htmlFor="uploadedFrom">アップロード日時（開始）</label>
          <input
            id="uploadedFrom"
            name="uploadedFrom"
            type="datetime-local"
            defaultValue={criteria.uploadedFrom}
          />
        </div>
        <div>
          <label htmlFor="uploadedTo">アップロード日時（終了）</label>
          <input
            id="uploadedTo"
            name="uploadedTo"
            type="datetime-local"
            defaultValue={criteria.uploadedTo}
          />
        </div>
        <div className="document-card-actions">
          <button type="submit" className="button">
            検索
          </button>
          <a className="button button-secondary" href="/admin/documents">
            条件をクリア
          </a>
        </div>
      </Form>

      <ul className="document-list grid">
        {page.documents.length === 0 && (
          <p>条件に一致する資料はありません。</p>
        )}
        {page.documents.map((document) => (
          <li key={document.id} className="card document-card">
            <img
              src={previewImageSrc(document.previewStatus)}
              alt={`${document.title}のプレビュー`}
              className="document-card-preview"
            />
            <h2>{document.title}</h2>
            <dl>
              <dt>資料ID</dt>
              <dd>{document.id}</dd>
              {/* オーナーのメールアドレスは管理者にだけ表示する(設計 §5.6)。 */}
              <dt>オーナー</dt>
              <dd>{document.ownerEmail}</dd>
              <dt>元ファイル名</dt>
              <dd>{document.originalFileName}</dd>
              <dt>アップロード日時</dt>
              <dd>{formatJstDateTime(document.createdAt)}</dd>
              <dt>ファイルサイズ</dt>
              <dd>{formatByteSize(document.byteSize)}</dd>
              <dt>プレビュー状態</dt>
              <dd>{formatPreviewStatus(document.previewStatus)}</dd>
            </dl>
            <div className="document-card-actions">
              <a className="button" href={`/documents/${document.id}`}>
                資料を開く
              </a>
              {/*
                強制削除は必ず確認画面を経由する(設計 §5.5)。このリンクはGETで
                確認画面へ遷移するだけで、資料は更新しない。
              */}
              <a
                className="button button-secondary"
                href={`/documents/${document.id}/delete`}
              >
                強制削除
              </a>
            </div>
          </li>
        ))}
      </ul>

      {page.nextCursor && (
        <a
          className="button button-secondary"
          href={nextPageHref(criteria, page.nextCursor)}
        >
          次を表示
        </a>
      )}
    </section>
  );
}
