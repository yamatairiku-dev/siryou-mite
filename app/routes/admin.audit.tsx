/**
 * 管理画面: 監査履歴の検索・閲覧(設計 §5.7, §4.2, §13の`/admin/audit`)。
 *
 * - loaderは`handleAdminAuditSearch`が`requireAdmin`で認可してから検索する。
 *   この画面へのリンクを隠すことは認可ではない(設計 §4.2、AGENTS.md 5項)。
 * - 読み取りだけの画面で、更新のactionを持たない(監査履歴は追記専用。設計 §12.2)。
 * - CSV出力と詳細分析機能は設けない(設計 §5.7)。
 * - 日時は日本時間`YYYY/MM/DD HH:mm`で表示し、検索条件の日時も日本時間として
 *   解釈する(設計 §5.2)。
 * - 表示する監査行にはメールアドレス・所属・ロールが含まれる。管理者だけが到達
 *   できる画面のためそのまま表示するが、運用ログ(stdout)へは出さない(設計 §15.2)。
 */
import { Form } from "react-router";
import type { Route } from "./+types/admin.audit";
import {
  handleAdminAuditSearch,
  type AdminAuditSearchCriteria,
  type AdminAuditSearchData,
} from "~/lib/admin/audit-search.server";
import { AdminNav } from "~/lib/format/admin-nav";
import { formatJstDateTime } from "~/lib/format/document-view";

export async function loader({
  request,
}: Route.LoaderArgs): Promise<AdminAuditSearchData> {
  return handleAdminAuditSearch(request);
}

export const meta: Route.MetaFunction = () => [
  { title: "資料みて！ 監査履歴" },
];

/** 操作(`action`)の表示名(設計 §12.2の区分)。 */
const actionLabels = {
  upload: "アップロード",
  view: "閲覧",
  delete: "削除",
  admin_operation: "管理操作",
} as const;

/** 結果(`result`)の表示名(設計 §15.1)。 */
const resultLabels = {
  success: "成功",
  denied: "拒否",
  failed: "失敗",
} as const;

/**
 * 次ページ(keyset pagination)のURL。検索条件はcursorに含まれないため、
 * 同じ条件をクエリ文字列へ引き継ぐ。
 */
function nextPageHref(
  criteria: AdminAuditSearchCriteria,
  nextCursor: string,
): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(criteria)) {
    if (name !== "cursor" && value !== "") {
      params.set(name, value);
    }
  }
  params.set("cursor", nextCursor);
  return `/admin/audit?${params.toString()}`;
}

export default function AdminAudit({ loaderData }: Route.ComponentProps) {
  const { criteria, page } = loaderData;

  return (
    <section>
      <p className="eyebrow">資料みて！ 管理画面</p>
      <h1>監査履歴</h1>
      <AdminNav current="audit" />
      <p className="lead">
        日時、利用者、資料ID、操作、結果で検索できます。条件を空欄にすると絞り込みません。
        監査履歴の閲覧もこの履歴へ記録されます。
      </p>

      {/* 検索は読み取りのみのGET。cursorは含めないため、検索するたびに1ページ目へ戻る。 */}
      <Form method="get" className="card admin-search-form">
        <div>
          <label htmlFor="occurredFrom">日時（開始）</label>
          <input
            id="occurredFrom"
            name="occurredFrom"
            type="datetime-local"
            defaultValue={criteria.occurredFrom}
          />
        </div>
        <div>
          <label htmlFor="occurredTo">日時（終了）</label>
          <input
            id="occurredTo"
            name="occurredTo"
            type="datetime-local"
            defaultValue={criteria.occurredTo}
          />
        </div>
        <div>
          <label htmlFor="actorEmail">利用者のメールアドレス</label>
          <input
            id="actorEmail"
            name="actorEmail"
            type="text"
            maxLength={320}
            defaultValue={criteria.actorEmail}
          />
        </div>
        <div>
          <label htmlFor="actorSubjectId">利用者ID</label>
          <input
            id="actorSubjectId"
            name="actorSubjectId"
            type="text"
            maxLength={200}
            defaultValue={criteria.actorSubjectId}
          />
        </div>
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
          <label htmlFor="action">操作</label>
          {/* 自由入力を受け付けない。server側でも同じenumで検証する(設計 §12.2)。 */}
          <select id="action" name="action" defaultValue={criteria.action}>
            <option value="">すべて</option>
            {Object.entries(actionLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="result">結果</label>
          <select id="result" name="result" defaultValue={criteria.result}>
            <option value="">すべて</option>
            {Object.entries(resultLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="document-card-actions">
          <button type="submit" className="button">
            検索
          </button>
          <a className="button button-secondary" href="/admin/audit">
            条件をクリア
          </a>
        </div>
      </Form>

      {page.events.length === 0 ? (
        <p>条件に一致する監査履歴はありません。</p>
      ) : (
        <>
          <p className="audit-legend">
            <span className="audit-badge audit-badge-denied">拒否</span>
            <span className="audit-badge audit-badge-failed">失敗</span>
            の行は色を変えて表示します。
          </p>
          {/* 列が多いため、狭い画面では表だけを横スクロールさせる。 */}
          <div className="table-wrap card">
            <table className="audit-table">
              <thead>
                <tr>
                  <th scope="col">日時</th>
                  <th scope="col">操作</th>
                  <th scope="col">結果</th>
                  <th scope="col">利用者</th>
                  <th scope="col">ロール／所属</th>
                  <th scope="col">資料ID</th>
                  <th scope="col">エラー分類</th>
                  <th scope="col">相関ID</th>
                </tr>
              </thead>
              <tbody>
                {page.events.map((event) => (
                  <tr
                    key={event.id}
                    className={`audit-row-${event.result}`}
                    data-result={event.result}
                  >
                    <td className="audit-nowrap">
                      {formatJstDateTime(event.occurredAt)}
                    </td>
                    <td className="audit-nowrap">
                      {actionLabels[event.action]}
                    </td>
                    <td>
                      <span
                        className={`audit-badge audit-badge-${event.result}`}
                      >
                        {resultLabels[event.result]}
                      </span>
                    </td>
                    <td>
                      <div>{event.actorEmail ?? "(不明)"}</div>
                      <div className="audit-id">{event.actorSubjectId}</div>
                    </td>
                    <td>
                      <div className="audit-nowrap">
                        {event.actorRoles.join("、") || "(なし)"}
                      </div>
                      <div className="audit-sub">
                        {event.actorGroupValues.join("、") || "(なし)"}
                      </div>
                    </td>
                    <td className="audit-id">{event.documentId ?? "—"}</td>
                    <td>{event.errorCategory ?? "—"}</td>
                    <td className="audit-id">{event.correlationId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

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
