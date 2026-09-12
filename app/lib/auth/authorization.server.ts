/**
 * 業務認可(設計 §4.2の権限表, §10.3, §10.4)。
 *
 * すべての認可はloader、action、データアクセス直前でサーバー側が行い、UIの非表示を
 * 認可として扱わない(設計 §4.2、AGENTS.md 5項)。owner判定にはEntra IDの
 * 変更されにくい内部識別子(`oid` = `AppUser.id`)だけを使い、メールアドレスや
 * 表示名は使わない(設計 §4.2)。
 *
 * 判定結果は`Response`を投げる`assert`系と、監査へ記録する分類を返す関数の
 * 両方で公開する。呼び出し側は拒否時に`result = "denied"`、`errorCategory`を
 * そのまま`insertAuditEvent`へ渡せる(設計 §15.1、QUESTIONS Q-003)。
 */
import type { AuditErrorCategory } from "~/lib/db/audit-events.server";
import type { DocumentRecord } from "~/lib/db/documents.server";
import { hasAppAccessRole, isAdmin } from "~/lib/auth/roles.server";
import { requireUser, type AppUser } from "~/lib/session.server";

export {
  appRoles,
  appRolesOf,
  hasAppAccessRole,
  isAdmin,
} from "~/lib/auth/roles.server";
export type { AppRole } from "~/lib/auth/roles.server";

/**
 * 認可判定に必要な資料の項目だけを要求する。repositoryの型から導出し、
 * カラム名(`owner_subject_id` / `status`)の変更に追従できるようにする。
 */
export type AuthorizableDocument = Pick<
  DocumentRecord,
  "ownerSubjectId" | "status"
>;

/** 削除をどのrepository関数で実行してよいか(設計 §10.4(2))。 */
export type DocumentDeletionScope = "owner" | "admin";

type DenialCategory = Extract<
  AuditErrorCategory,
  "not_authorized" | "document_not_found"
>;

export type AuthorizationDenial = {
  allowed: false;
  /** 利用者へ返すHTTPステータス。 */
  status: 403 | 404;
  /** 監査の`error_category`(設計 §12.2の固定分類)。 */
  errorCategory: DenialCategory;
  /** 利用者向けの短い日本語メッセージ(設計 §14)。内部情報を含めない。 */
  message: string;
};

export type DocumentViewDecision = { allowed: true } | AuthorizationDenial;

export type DocumentDeletionDecision =
  | { allowed: true; scope: DocumentDeletionScope }
  | AuthorizationDenial;

/**
 * 資料不存在・削除済み・閲覧不可を一般利用者向けに区別しない(設計 §10.4, §14)。
 * 監査には`errorCategory`で区別して残す。
 */
const documentNotFound: AuthorizationDenial = {
  allowed: false,
  status: 404,
  errorCategory: "document_not_found",
  message: "資料が見つかりません",
};

const noAppAccess: AuthorizationDenial = {
  allowed: false,
  status: 403,
  errorCategory: "not_authorized",
  message: "このアプリを利用する権限がありません",
};

const notAdmin: AuthorizationDenial = {
  allowed: false,
  status: 403,
  errorCategory: "not_authorized",
  message: "管理機能を利用する権限がありません",
};

const notDocumentOwner: AuthorizationDenial = {
  allowed: false,
  status: 403,
  errorCategory: "not_authorized",
  message: "この資料を削除する権限がありません",
};

/**
 * 利用者がこのアプリを使える状態か(設計 §7.1)。
 *
 * `requireUser`が同じ条件を検証済みだが、`getUser`の戻り値をそのまま渡された場合や
 * 将来の呼び出し漏れでもfail closedになるよう、データアクセス直前でも確認する。
 */
export function hasAppAccess(user: AppUser): boolean {
  return hasAppAccessRole(user) && user.groups.length > 0;
}

/** オーナー判定。`oid`(`AppUser.id`)だけで判定し、メールアドレスは使わない。 */
export function isDocumentOwner(
  user: AppUser,
  document: AuthorizableDocument,
): boolean {
  return document.ownerSubjectId === user.id;
}

/**
 * URLを知っている資料の閲覧(設計 §4.2)。ログイン済み利用者であれば所有者以外でも
 * 閲覧できるが、`active`でない資料は「見つかりません」として拒否する(設計 §10.3(2))。
 */
export function authorizeDocumentView(
  user: AppUser,
  document: AuthorizableDocument | null,
): DocumentViewDecision {
  if (!hasAppAccess(user)) {
    return noAppAccess;
  }
  if (!document || document.status !== "active") {
    return documentNotFound;
  }
  return { allowed: true };
}

/**
 * 資料の削除(設計 §4.2, §10.4(2))。オーナー本人または管理者だけが削除でき、
 * 一般ユーザーによる他人の資料の削除は拒否する。
 *
 * オーナー本人が管理者でもある場合は`owner`スコープを返し、所有者条件付きの
 * repository関数(`deleteDocumentAsOwner`)を使わせる。
 */
export function authorizeDocumentDeletion(
  user: AppUser,
  document: AuthorizableDocument | null,
): DocumentDeletionDecision {
  if (!hasAppAccess(user)) {
    return noAppAccess;
  }
  if (!document || document.status !== "active") {
    return documentNotFound;
  }
  if (isDocumentOwner(user, document)) {
    return { allowed: true, scope: "owner" };
  }
  if (isAdmin(user)) {
    return { allowed: true, scope: "admin" };
  }
  return notDocumentOwner;
}

/** 閲覧を認可し、拒否なら`Response`を投げる。 */
export function assertCanViewDocument(
  user: AppUser,
  document: AuthorizableDocument | null,
): void {
  const decision = authorizeDocumentView(user, document);
  if (!decision.allowed) {
    throw toResponse(decision);
  }
}

/**
 * 削除を認可し、使ってよいrepository関数のスコープを返す。拒否なら`Response`を投げる。
 * DB更新の直前で呼ぶ(設計 §10.4(2))。
 */
export function requireDocumentDeletionScope(
  user: AppUser,
  document: AuthorizableDocument | null,
): DocumentDeletionScope {
  const decision = authorizeDocumentDeletion(user, document);
  if (!decision.allowed) {
    throw toResponse(decision);
  }
  return decision.scope;
}

/** 管理機能の認可(設計 §4.2)。拒否なら`Response`を投げる。 */
export function assertAdmin(user: AppUser): void {
  if (!hasAppAccess(user)) {
    throw toResponse(noAppAccess);
  }
  if (!isAdmin(user)) {
    throw toResponse(notAdmin);
  }
}

/**
 * 管理者専用のloader/actionの先頭で使う(設計 §5.6, §5.7)。
 * 未認証はログイン画面へ、権限不足は403で拒否する。
 */
export async function requireAdmin(request: Request): Promise<AppUser> {
  const user = await requireUser(request);
  assertAdmin(user);
  return user;
}

/**
 * 拒否結果を利用者向けレスポンスへ変換する。メッセージは短い日本語だけで、
 * 資料の所有者や内部状態を含めない(設計 §14)。
 */
function toResponse(denial: AuthorizationDenial): Response {
  return new Response(denial.message, { status: denial.status });
}
