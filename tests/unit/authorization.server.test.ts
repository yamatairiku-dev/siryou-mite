import { describe, expect, it } from "vitest";
import {
  appRolesOf,
  assertAdmin,
  assertCanViewDocument,
  authorizeDocumentDeletion,
  authorizeDocumentView,
  hasAppAccess,
  isAdmin,
  isDocumentOwner,
  requireAdmin,
  requireDocumentDeletionScope,
  type AuthorizableDocument,
} from "~/lib/auth/authorization.server";
import { createUserSession, type AppUser } from "~/lib/session.server";

const owner: AppUser = {
  id: "oid-owner",
  tenantId: "tenant-001",
  name: "オーナー",
  email: "owner@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

const otherUser: AppUser = {
  ...owner,
  id: "oid-other",
  name: "別の利用者",
  email: "other@example.com",
};

const administrator: AppUser = {
  ...owner,
  id: "oid-admin",
  name: "管理者",
  email: "admin@example.com",
  roles: ["Admin"],
};

const activeDocument: AuthorizableDocument = {
  ownerSubjectId: "oid-owner",
  status: "active",
};

const deletedDocument: AuthorizableDocument = {
  ownerSubjectId: "oid-owner",
  status: "deleted",
};

/** dev認証モードのセッションCookieを付けた要求を作る。 */
async function requestAs(user: AppUser): Promise<Request> {
  const response = await createUserSession(user);
  return new Request("http://localhost:3000/admin", {
    headers: { Cookie: response.headers.get("Set-Cookie") ?? "" },
  });
}

describe("App Role判定", () => {
  it("`User`と`Admin`だけをApp Roleとして扱う", () => {
    expect(appRolesOf({ roles: ["User", "Admin"] })).toEqual(["User", "Admin"]);
    expect(
      appRolesOf({ roles: ["ZAA535-A", "Reader", "user", "ADMIN"] }),
    ).toEqual([]);
  });

  it("`Admin`単独でも一般機能を利用できる", () => {
    expect(hasAppAccess(administrator)).toBe(true);
    expect(isAdmin(administrator)).toBe(true);
  });

  it("`User`だけの利用者は管理者ではない", () => {
    expect(hasAppAccess(owner)).toBe(true);
    expect(isAdmin(owner)).toBe(false);
  });

  it("App Roleが無い、または所属が無い利用者を拒否する", () => {
    expect(hasAppAccess({ ...owner, roles: [] })).toBe(false);
    expect(hasAppAccess({ ...owner, roles: ["ZAA535-A"] })).toBe(false);
    expect(hasAppAccess({ ...owner, groups: [] })).toBe(false);
  });

  it("所属グループ名をApp Roleとして扱わない", () => {
    const memberOfGroupNamedAdmin: AppUser = {
      ...owner,
      roles: ["User"],
      groups: ["Admin"],
    };
    expect(isAdmin(memberOfGroupNamedAdmin)).toBe(false);
    expect(hasAppAccess(memberOfGroupNamedAdmin)).toBe(true);
  });
});

describe("assertAdmin", () => {
  it("管理者を通す", () => {
    expect(() => assertAdmin(administrator)).not.toThrow();
  });

  it("一般ユーザーを403で拒否する", () => {
    expect(() => assertAdmin(owner)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it("所属が無い管理者も拒否する", () => {
    expect(() => assertAdmin({ ...administrator, groups: [] })).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});

describe("requireAdmin", () => {
  it("管理者の要求から利用者を返す", async () => {
    await expect(requireAdmin(await requestAs(administrator))).resolves.toEqual(
      administrator,
    );
  });

  it("一般ユーザーの管理機能利用を拒否する", async () => {
    await expect(requireAdmin(await requestAs(owner))).rejects.toMatchObject({
      status: 403,
    });
  });

  it("未認証はログイン画面へ遷移させる", async () => {
    await expect(
      requireAdmin(new Request("http://localhost:3000/admin")),
    ).rejects.toMatchObject({ status: 302 });
  });
});

describe("オーナー判定", () => {
  it("`oid`が一致する場合だけオーナーとする", () => {
    expect(isDocumentOwner(owner, activeDocument)).toBe(true);
    expect(isDocumentOwner(otherUser, activeDocument)).toBe(false);
  });

  it("メールアドレスが同じでも`oid`が違えばオーナーとしない", () => {
    const impersonator: AppUser = { ...otherUser, email: owner.email };
    expect(isDocumentOwner(impersonator, activeDocument)).toBe(false);
  });
});

describe("資料の閲覧認可", () => {
  it("URLを知っている利用者は他人の資料でも閲覧できる", () => {
    expect(authorizeDocumentView(otherUser, activeDocument)).toEqual({
      allowed: true,
    });
    expect(() => assertCanViewDocument(otherUser, activeDocument)).not.toThrow();
  });

  it.each([
    ["削除済み", deletedDocument],
    ["存在しない", null],
  ])("%s資料を同じ扱いで拒否する", (_label, document) => {
    expect(authorizeDocumentView(owner, document)).toMatchObject({
      allowed: false,
      status: 404,
      errorCategory: "document_not_found",
      message: "資料が見つかりません",
    });
  });

  it("App Roleまたは所属が無い利用者はオーナーでも閲覧できない", () => {
    expect(
      authorizeDocumentView({ ...owner, roles: [] }, activeDocument),
    ).toMatchObject({
      allowed: false,
      status: 403,
      errorCategory: "not_authorized",
    });
    expect(
      authorizeDocumentView({ ...owner, groups: [] }, activeDocument),
    ).toMatchObject({
      allowed: false,
      status: 403,
      errorCategory: "not_authorized",
    });
  });

  it("拒否時は403の`Response`を投げる", () => {
    expect(() =>
      assertCanViewDocument({ ...owner, groups: [] }, activeDocument),
    ).toThrow(expect.objectContaining({ status: 403 }));
  });
});

describe("資料の削除認可", () => {
  it("オーナー本人はオーナースコープで削除できる", () => {
    expect(authorizeDocumentDeletion(owner, activeDocument)).toEqual({
      allowed: true,
      scope: "owner",
    });
    expect(requireDocumentDeletionScope(owner, activeDocument)).toBe("owner");
  });

  it("管理者は他人の資料を管理者スコープで強制削除できる", () => {
    expect(requireDocumentDeletionScope(administrator, activeDocument)).toBe(
      "admin",
    );
  });

  it("オーナー自身が管理者の場合はオーナースコープを使う", () => {
    const ownerAdmin: AppUser = { ...owner, roles: ["User", "Admin"] };
    expect(requireDocumentDeletionScope(ownerAdmin, activeDocument)).toBe(
      "owner",
    );
  });

  it("一般ユーザーによる他人の資料の削除を拒否する", () => {
    expect(authorizeDocumentDeletion(otherUser, activeDocument)).toMatchObject({
      allowed: false,
      status: 403,
      errorCategory: "not_authorized",
    });
    expect(() =>
      requireDocumentDeletionScope(otherUser, activeDocument),
    ).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("拒否メッセージへオーナーや資料の内部情報を含めない", async () => {
    let thrown: unknown;
    try {
      requireDocumentDeletionScope(otherUser, activeDocument);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    const body = await (thrown as Response).text();
    expect(body).toBe("この資料を削除する権限がありません");
    expect(body).not.toContain(activeDocument.ownerSubjectId);
  });

  it.each([
    ["削除済み", deletedDocument],
    ["存在しない", null],
  ])("%s資料の削除は「見つかりません」として拒否する", (_label, document) => {
    expect(authorizeDocumentDeletion(administrator, document)).toMatchObject({
      allowed: false,
      status: 404,
      errorCategory: "document_not_found",
    });
  });

  it("App Roleが無い利用者はオーナーでも削除できない", () => {
    expect(
      authorizeDocumentDeletion({ ...owner, roles: [] }, activeDocument),
    ).toMatchObject({
      allowed: false,
      status: 403,
      errorCategory: "not_authorized",
    });
  });
});
