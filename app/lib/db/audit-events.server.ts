/**
 * `audit_events` repositoryのWeb向け薄いラッパー(設計 §12.2, §15.1)。
 *
 * 実処理は`services/shared/db/audit-events.ts`にある。Web・Display(閲覧監査)・
 * Preview・Maintenanceが同じ列・同じZod schemaで追記するため、SQLと分類enumを
 * 二重に持たない(docs/ARCHITECTURE.md)。`insertAuditEvent`は`executor`に既定値を
 * 持たず、業務更新と同じトランザクションの渡し忘れを型エラーにする(設計 §15.1)。
 *
 * 監査履歴画面(設計 §5.7の`/admin/audit`)向けの`searchAuditEvents`はSELECTだけを
 * 行う。追記専用の性質は変わらず、UPDATE・DELETEを行う関数はここにも無い。
 */
export {
  auditActions,
  auditErrorCategories,
  auditEventInputSchema,
  auditResults,
  decodeAuditEventCursor,
  encodeAuditEventCursor,
  insertAuditEvent,
  InvalidAuditCursorError,
  searchAuditEvents,
} from "../../../services/shared/db/audit-events";
export type {
  AuditAction,
  AuditErrorCategory,
  AuditEventInput,
  AuditEventPage,
  AuditEventRecord,
  AuditEventSearchRecord,
  AuditResult,
  SearchAuditEventsOptions,
} from "../../../services/shared/db/audit-events";
