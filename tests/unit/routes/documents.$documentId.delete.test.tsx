import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoutesStub } from "react-router";
import type { AuditEventInput } from "~/lib/db/audit-events.server";
import type { DocumentRecord } from "~/lib/db/documents.server";
import type { Queryable } from "~/lib/db/pool.server";
import { createUserSession, type AppUser } from "~/lib/session.server";

/**
 * T14 単体テスト: 削除確認画面と削除action(設計 §5.5, §10.4, §11.1, §12.1, §14, §15)。
 *
 * - loaderは他人の資料の確認画面を表示しないこと、削除済み・未存在・UUIDでない
 *   資料IDが同じ404になることを確認する。
 * - actionはDB・Blobを差し替え、認証・同一オリジン検証・認可・トランザクション
 *   境界・Blob削除の補償処理をそのまま実行して検証する。
 */

const findDocumentByIdMock = vi.fn<
  (documentId: string) => Promise<DocumentRecord | null>
>();

vi.mock("~/lib/db/documents.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/db/documents.server")>();
  return {
    ...actual,
    findDocumentById: (documentId: string) => findDocumentByIdMock(documentId),
  };
});

const {
  loader,
  action,
  default: DocumentDeleteConfirm,
} = await import("~/routes/documents.$documentId.delete");
const { handleDocumentDeletion } = await import("~/lib/documents/delete.server");
type DocumentDeleteDependencies = Awaited<
  typeof import("~/lib/documents/delete.server")
>["defaultDocumentDeleteDependencies"];

const origin = "http://localhost:3000";
const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

const owner: AppUser = {
  id: "oid-owner",
  tenantId: "tenant-001",
  name: "所有者 太郎",
  email: "owner@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

/** 管理者ではない一般利用者(他人の資料は削除できない)。 */
const otherUser: AppUser = {
  id: "oid-someone-else",
  tenantId: "tenant-001",
  name: "閲覧者 花子",
  email: "viewer@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

/** オーナー本人が管理者でもある場合(所有者スコープで削除する)。 */
const ownerAdminUser: AppUser = {
  ...owner,
  name: "所有者 兼 管理者",
  roles: ["User", "Admin"],
};

const adminUser: AppUser = {
  id: "oid-admin",
  tenantId: "tenant-001",
  name: "管理者 次郎",
  email: "admin@example.com",
  roles: ["Admin"],
  groups: ["ZAA535-A"],
};

function documentRecord(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: DOCUMENT_ID,
    ownerSubjectId: owner.id,
    ownerEmailAtUpload: owner.email,
    originalFileName: "極秘資料.html",
    title: "資料タイトル",
    byteSize: 2048,
    previewStatus: "ready",
    warningCodes: ["script_disabled"],
    status: "active",
    createdAt: new Date("2026-01-02T15:30:00.000Z"),
    deletedAt: null,
    deletedBySubjectId: null,
    blobCleanupPending: false,
    ...overrides,
  };
}

/** 削除後のDB行(設計 §12.1の「削除時に消去」項目がNULLになる)。 */
function deletedRecord(
  document: DocumentRecord,
  deletedBySubjectId: string,
): DocumentRecord {
  return {
    ...document,
    ownerEmailAtUpload: null,
    originalFileName: null,
    title: null,
    byteSize: null,
    previewStatus: null,
    warningCodes: null,
    status: "deleted",
    deletedAt: new Date(),
    deletedBySubjectId,
    blobCleanupPending: true,
  };
}

async function sessionCookieFor(user: AppUser): Promise<string> {
  const response = await createUserSession(user);
  return response.headers.get("Set-Cookie") ?? "";
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  findDocumentByIdMock.mockReset();
  // 実装の`console.log`(運用ログ)でテスト出力を汚さない。
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function loggedEvents(): Record<string, unknown>[] {
  return logSpy.mock.calls.map(
    ([line]: unknown[]) => JSON.parse(String(line)) as Record<string, unknown>,
  );
}

// --- 確認画面(loader。設計 §5.5) ---

function loaderArgs(documentId: string, cookie?: string) {
  return {
    request: new Request(
      `${origin}/documents/${documentId}/delete`,
      cookie ? { headers: { Cookie: cookie } } : {},
    ),
    params: { documentId },
  } as unknown as Parameters<typeof loader>[0];
}

describe("削除確認画面のloader", () => {
  it("未ログインはログイン画面へ戻し、DBへ触れない", async () => {
    await expect(loader(loaderArgs(DOCUMENT_ID))).rejects.toMatchObject({
      status: 302,
    });

    expect(findDocumentByIdMock).not.toHaveBeenCalled();
  });

  it("オーナー本人には資料タイトルを表示する", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());

    const result = await loader(
      loaderArgs(DOCUMENT_ID, await sessionCookieFor(owner)),
    );

    expect(result).toEqual({ documentId: DOCUMENT_ID, title: "資料タイトル" });
  });

  it("他人の資料の確認画面は一般利用者へ表示しない(403)", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());

    await expect(
      loader(loaderArgs(DOCUMENT_ID, await sessionCookieFor(otherUser))),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("管理者は他人の資料の確認画面を表示できる", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());

    const result = await loader(
      loaderArgs(DOCUMENT_ID, await sessionCookieFor(adminUser)),
    );

    expect(result.documentId).toBe(DOCUMENT_ID);
  });

  it("削除済みと未存在は同じ404「資料が見つかりません」になる", async () => {
    const cookie = await sessionCookieFor(owner);

    findDocumentByIdMock.mockResolvedValue(
      documentRecord({ status: "deleted", title: null, originalFileName: null }),
    );
    const deleted = (await loader(loaderArgs(DOCUMENT_ID, cookie)).catch(
      (error: Response) => error,
    )) as Response;

    findDocumentByIdMock.mockResolvedValue(null);
    const missing = (await loader(loaderArgs(DOCUMENT_ID, cookie)).catch(
      (error: Response) => error,
    )) as Response;

    expect(deleted.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await deleted.text()).toBe("資料が見つかりません");
    expect(await missing.text()).toBe("資料が見つかりません");
  });

  it("UUID形式でない資料IDはDBへ触れる前に404で拒否する", async () => {
    await expect(
      loader(loaderArgs("not-a-uuid", await sessionCookieFor(owner))),
    ).rejects.toMatchObject({ status: 404 });

    expect(findDocumentByIdMock).not.toHaveBeenCalled();
  });
});

// --- 削除action(設計 §10.4) ---

type Harness = {
  deps: DocumentDeleteDependencies;
  calls: string[];
  audits: AuditEventInput[];
  ownerDeleteParams: { documentId: string; ownerSubjectId: string }[];
  adminDeleteParams: { documentId: string; adminSubjectId: string }[];
};

function createHarness(
  options: {
    document?: DocumentRecord | null;
    overrides?: Partial<DocumentDeleteDependencies>;
  } = {},
): Harness {
  const document =
    options.document === undefined ? documentRecord() : options.document;
  const calls: string[] = [];
  const audits: AuditEventInput[] = [];
  const ownerDeleteParams: { documentId: string; ownerSubjectId: string }[] = [];
  const adminDeleteParams: { documentId: string; adminSubjectId: string }[] = [];
  const tx = { query: async () => ({ rows: [] }) } as unknown as Queryable;

  const base: DocumentDeleteDependencies = {
    withTransaction: async (run) => {
      calls.push("tx:begin");
      try {
        const result = await run(tx);
        calls.push("tx:commit");
        return result;
      } catch (error) {
        calls.push("tx:rollback");
        throw error;
      }
    },
    findDocumentById: async () => {
      calls.push("findDocumentById");
      return document;
    },
    deleteAsOwner: async (params) => {
      calls.push("deleteAsOwner");
      ownerDeleteParams.push(params);
      // 所有者条件付きSQLと同じ振る舞い: 所有者が一致しなければ0行。
      return document && document.ownerSubjectId === params.ownerSubjectId
        ? deletedRecord(document, params.ownerSubjectId)
        : null;
    },
    deleteAsAdmin: async (params) => {
      calls.push("deleteAsAdmin");
      adminDeleteParams.push(params);
      return document ? deletedRecord(document, params.adminSubjectId) : null;
    },
    insertAuditEvent: async (input) => {
      calls.push(`audit:${input.action}:${input.result}`);
      audits.push(input);
      return {};
    },
    deleteHtml: async () => {
      calls.push("deleteHtml");
    },
    deletePreview: async () => {
      calls.push("deletePreview");
    },
    markBlobCleanupCompleted: async () => {
      calls.push("markBlobCleanupCompleted");
      return true;
    },
    ...options.overrides,
  };

  return { deps: base, calls, audits, ownerDeleteParams, adminDeleteParams };
}

function deleteRequest(options: {
  cookie?: string | undefined;
  requestOrigin?: string | null | undefined;
  documentId?: string | undefined;
  method?: string | undefined;
}): Request {
  const headers = new Headers();
  if (options.cookie) {
    headers.set("Cookie", options.cookie);
  }
  if (options.requestOrigin !== null) {
    headers.set("Origin", options.requestOrigin ?? origin);
  }
  return new Request(
    `${origin}/documents/${options.documentId ?? DOCUMENT_ID}/delete`,
    { method: options.method ?? "POST", headers },
  );
}

async function runDelete(options: {
  user?: AppUser | null;
  harness?: Harness;
  documentId?: string;
  requestOrigin?: string | null;
}) {
  const harness = options.harness ?? createHarness();
  const cookie =
    options.user === null || options.user === undefined
      ? undefined
      : await sessionCookieFor(options.user);
  const result = await handleDocumentDeletion(
    deleteRequest({
      cookie,
      requestOrigin: options.requestOrigin ?? origin,
      documentId: options.documentId,
    }),
    { documentId: options.documentId ?? DOCUMENT_ID },
    harness.deps,
  );
  return { harness, result };
}

describe("削除action: 正常系(設計 §10.4)", () => {
  it("オーナー本人の削除は所有者条件付きの削除と成功監査を同一トランザクションで行い、初期画面へ戻す", async () => {
    const { harness, result } = await runDelete({ user: owner });

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/app");

    // 認可はDB更新の直前(同一トランザクション内の読み直し)で行う。
    expect(harness.calls).toEqual([
      "tx:begin",
      "findDocumentById",
      "deleteAsOwner",
      "audit:delete:success",
      "tx:commit",
      "deleteHtml",
      "deletePreview",
      "markBlobCleanupCompleted",
    ]);
    expect(harness.calls).not.toContain("deleteAsAdmin");
    expect(harness.ownerDeleteParams).toEqual([
      { documentId: DOCUMENT_ID, ownerSubjectId: owner.id },
    ]);
    expect(harness.audits[0]).toMatchObject({
      action: "delete",
      result: "success",
      documentId: DOCUMENT_ID,
      actorSubjectId: owner.id,
      errorCategory: null,
    });
  });

  it("管理者による他人の資料の強制削除は所有者で絞り込まず、管理操作として監査する", async () => {
    const { harness, result } = await runDelete({ user: adminUser });

    expect((result as Response).status).toBe(303);
    expect(harness.calls).toContain("deleteAsAdmin");
    expect(harness.calls).not.toContain("deleteAsOwner");
    expect(harness.adminDeleteParams).toEqual([
      { documentId: DOCUMENT_ID, adminSubjectId: adminUser.id },
    ]);
    // 管理者の強制削除も`delete`で記録し、`action = delete`で全削除履歴が揃う
    // ようにする(強制削除かどうかは`actorRoles`と所有者IDの不一致で判別する)。
    expect(harness.audits[0]).toMatchObject({
      action: "delete",
      result: "success",
      documentId: DOCUMENT_ID,
      actorSubjectId: adminUser.id,
      actorRoles: ["Admin"],
    });
  });

  it("オーナー本人が管理者でもある場合は所有者条件付きの削除を使い、監査もdeleteにする", async () => {
    const { harness, result } = await runDelete({ user: ownerAdminUser });

    expect((result as Response).status).toBe(303);
    expect(harness.calls).toContain("deleteAsOwner");
    expect(harness.calls).not.toContain("deleteAsAdmin");
    expect(harness.audits[0]).toMatchObject({
      action: "delete",
      result: "success",
      actorSubjectId: owner.id,
    });
  });

  it("削除監査へファイル名・タイトル・HTML本文などを保存しない(設計 §12.2)", async () => {
    const { harness } = await runDelete({ user: owner });

    const serialized = JSON.stringify(harness.audits);
    for (const forbidden of ["極秘資料.html", "資料タイトル", "<html", "Cookie"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(harness.audits[0] ?? {}).sort()).toEqual([
      "action",
      "actorEmailAtEvent",
      "actorGroupValues",
      "actorRoles",
      "actorSubjectId",
      "actorTenantId",
      "correlationId",
      "documentId",
      "errorCategory",
      "result",
    ]);
  });

  it("運用ログには資料IDと成否だけを出し、個人情報を出さない(設計 §15.2)", async () => {
    await runDelete({ user: owner });

    const events = loggedEvents();
    expect(events.at(-1)).toMatchObject({
      event: "document_delete",
      result: "success",
      documentId: DOCUMENT_ID,
    });
    expect(JSON.stringify(events)).not.toContain(owner.email);
    expect(JSON.stringify(events)).not.toContain(owner.id);
  });
});

describe("削除action: 認可(設計 §4.2, §10.4(2))", () => {
  it("一般ユーザーによる他人の資料の削除を403で拒否し、DBの更新関数を一切呼ばず、拒否だけを監査する", async () => {
    const harness = createHarness();
    const denial = (await runDelete({ user: otherUser, harness }).catch(
      (error: Response) => error,
    )) as Response;

    expect(denial.status).toBe(403);
    expect(await denial.text()).toContain("この資料を削除する権限がありません");
    expect(harness.calls).not.toContain("deleteAsOwner");
    expect(harness.calls).not.toContain("deleteAsAdmin");
    expect(harness.calls).toContain("tx:rollback");
    expect(harness.calls).not.toContain("deleteHtml");
    expect(harness.audits).toEqual([
      expect.objectContaining({
        action: "delete",
        result: "denied",
        errorCategory: "not_authorized",
        actorSubjectId: otherUser.id,
        documentId: DOCUMENT_ID,
      }),
    ]);
  });

  it("未ログインの削除要求はログイン画面へ戻し、監査もDB更新も行わない", async () => {
    const harness = createHarness();

    const redirected = await handleDocumentDeletion(
      deleteRequest({}),
      { documentId: DOCUMENT_ID },
      harness.deps,
    ).catch((error: Response) => error);

    expect((redirected as Response).status).toBe(302);
    expect(harness.calls).toEqual([]);
    expect(harness.audits).toEqual([]);
  });

  it("cross-originの削除要求を403で拒否し、拒否を監査する(AGENTS.md 7項)", async () => {
    const harness = createHarness();

    const denial = await handleDocumentDeletion(
      deleteRequest({
        cookie: await sessionCookieFor(owner),
        requestOrigin: "https://evil.example.com",
      }),
      { documentId: DOCUMENT_ID },
      harness.deps,
    ).catch((error: Response) => error);

    expect((denial as Response).status).toBe(403);
    expect(harness.calls).not.toContain("findDocumentById");
    expect(harness.calls).not.toContain("deleteAsOwner");
    expect(harness.audits).toEqual([
      expect.objectContaining({
        action: "delete",
        result: "denied",
        errorCategory: "not_authorized",
        documentId: null,
      }),
    ]);
  });

  it("拒否レスポンスにもsecurityHeadersと相関IDを付ける(設計 §14, §15.2)", async () => {
    const harness = createHarness();
    const denial = (await runDelete({ user: otherUser, harness }).catch(
      (error: Response) => error,
    )) as Response;

    expect(denial.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(denial.headers.get("Cache-Control")).toBe("no-store");
    // 画面へ表示する相関IDは監査の相関IDと同じ値にする。
    const correlationId = harness.audits[0]?.correlationId;
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await denial.text()).toContain(`（相関ID: ${correlationId}）`);
  });

  it("Originヘッダーが無い削除要求も拒否する", async () => {
    const harness = createHarness();

    const denial = await handleDocumentDeletion(
      deleteRequest({
        cookie: await sessionCookieFor(owner),
        requestOrigin: null,
      }),
      { documentId: DOCUMENT_ID },
      harness.deps,
    ).catch((error: Response) => error);

    expect((denial as Response).status).toBe(403);
    expect(harness.calls).not.toContain("deleteAsOwner");
  });
});

describe("削除action: 未存在・削除済み(設計 §10.4, §14)", () => {
  it("削除済みと未存在は同じ404表示になり、削除監査(success)を残さない", async () => {
    const deletedHarness = createHarness({
      document: documentRecord({
        status: "deleted",
        title: null,
        originalFileName: null,
      }),
    });
    const deleted = (await runDelete({
      user: owner,
      harness: deletedHarness,
    }).catch((error: Response) => error)) as Response;

    const missingHarness = createHarness({ document: null });
    const missing = (await runDelete({
      user: owner,
      harness: missingHarness,
    }).catch((error: Response) => error)) as Response;

    expect(deleted.status).toBe(404);
    expect(missing.status).toBe(404);
    // 相関ID以外は同じ文面にする(削除済みと未存在を区別しない。設計 §10.4, §14)。
    const withoutCorrelationId = (message: string) =>
      message.replace(/（相関ID: [0-9a-f-]{36}）$/u, "");
    expect(withoutCorrelationId(await deleted.text())).toBe("資料が見つかりません");
    expect(withoutCorrelationId(await missing.text())).toBe("資料が見つかりません");
    for (const harness of [deletedHarness, missingHarness]) {
      expect(harness.calls).not.toContain("deleteAsOwner");
      expect(harness.audits).toEqual([
        expect.objectContaining({
          result: "denied",
          errorCategory: "document_not_found",
          documentId: null,
        }),
      ]);
    }
  });

  it("UUID形式でない資料IDはDBへ触れる前に404で拒否する", async () => {
    const harness = createHarness();

    const denial = (await runDelete({
      user: owner,
      harness,
      documentId: "not-a-uuid",
    }).catch((error: Response) => error)) as Response;

    expect(denial.status).toBe(404);
    expect(await denial.text()).toContain("資料が見つかりません");
    expect(harness.calls).not.toContain("findDocumentById");
    expect(harness.audits).toEqual([
      expect.objectContaining({
        result: "denied",
        errorCategory: "validation_failed",
      }),
    ]);
  });

  it("認可後に他の操作が削除していた場合(更新0行)はrollbackして404にする", async () => {
    const harness = createHarness({
      overrides: { deleteAsOwner: async () => null },
    });

    const denial = (await runDelete({ user: owner, harness }).catch(
      (error: Response) => error,
    )) as Response;

    expect(denial.status).toBe(404);
    expect(harness.calls).toContain("tx:rollback");
    expect(harness.audits).toEqual([
      expect.objectContaining({ result: "denied" }),
    ]);
  });
});

describe("削除action: 失敗と補償(設計 §10.4(5), §15.1)", () => {
  it("監査保存に失敗したらrollbackし、資料を削除せず失敗を返す", async () => {
    const harness = createHarness({
      overrides: {
        insertAuditEvent: async (input) => {
          if (input.result === "success") {
            throw new Error("audit write failed");
          }
          return {};
        },
      },
    });

    const { result } = await runDelete({ user: owner, harness });

    expect(result).not.toBeInstanceOf(Response);
    const failure = result as { data: { message: string; correlationId: string } };
    expect(failure.data.message).toContain("削除できませんでした");
    expect(failure.data.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(harness.calls).toContain("tx:rollback");
    // commit前に失敗しているため、Blob削除は行わない(資料は残っている)。
    expect(harness.calls).not.toContain("deleteHtml");
    expect(harness.calls).not.toContain("markBlobCleanupCompleted");
  });

  it("Blob削除に失敗しても削除は成功し、blob_cleanup_pendingを落とさず運用ログへ記録する", async () => {
    const harness = createHarness({
      overrides: {
        deleteHtml: async () => {
          throw new Error("storage unavailable");
        },
      },
    });

    const { result } = await runDelete({ user: owner, harness });

    expect((result as Response).status).toBe(303);
    expect((result as Response).headers.get("Location")).toBe("/app");
    // プレビュー削除は試みるが、再試行フラグは下ろさない(T19が冪等に再試行する)。
    expect(harness.calls).toContain("deletePreview");
    expect(harness.calls).not.toContain("markBlobCleanupCompleted");

    const events = loggedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "document_delete_blob_cleanup",
        result: "failed",
        errorCategory: "storage_failed",
        documentId: DOCUMENT_ID,
      }),
    );
    expect(events.at(-1)).toMatchObject({
      event: "document_delete",
      result: "success",
    });
  });

  it("プレビュー画像の削除だけ失敗した場合も再試行フラグを残す", async () => {
    const harness = createHarness({
      overrides: {
        deletePreview: async () => {
          throw new Error("storage unavailable");
        },
      },
    });

    const { result } = await runDelete({ user: owner, harness });

    expect((result as Response).status).toBe(303);
    expect(harness.calls).toContain("deleteHtml");
    expect(harness.calls).not.toContain("markBlobCleanupCompleted");
  });

  it("再試行フラグの更新に失敗しても削除自体は成功のままにする", async () => {
    const harness = createHarness({
      overrides: {
        markBlobCleanupCompleted: async () => {
          throw new Error("db unavailable");
        },
      },
    });

    const { result } = await runDelete({ user: owner, harness });

    expect((result as Response).status).toBe(303);
    expect(loggedEvents()).toContainEqual(
      expect.objectContaining({
        event: "document_delete_blob_cleanup_flag",
        result: "failed",
      }),
    );
  });

  it("拒否監査の保存に失敗しても、拒否結果は変えない", async () => {
    const harness = createHarness({
      overrides: {
        insertAuditEvent: async () => {
          throw new Error("audit write failed");
        },
      },
    });

    const denial = (await runDelete({ user: otherUser, harness }).catch(
      (error: Response) => error,
    )) as Response;

    expect(denial.status).toBe(403);
    expect(loggedEvents()).toContainEqual(
      expect.objectContaining({
        event: "document_delete_audit_write",
        result: "failed",
      }),
    );
  });
});

describe("削除action: HTTPメソッド", () => {
  it("POST以外は405で拒否する", async () => {
    const rejected = await action({
      request: deleteRequest({ method: "DELETE" }),
      params: { documentId: DOCUMENT_ID },
    } as unknown as Parameters<typeof action>[0]).catch(
      (error: Response) => error,
    );

    expect((rejected as Response).status).toBe(405);
    expect((rejected as Response).headers.get("Allow")).toBe("POST");
  });
});

// --- 確認画面コンポーネント(設計 §5.5) ---

function renderConfirm(actionData?: { message: string; correlationId: string }) {
  const path = `/documents/${DOCUMENT_ID}/delete`;
  const Stub = createRoutesStub([
    {
      path,
      Component: DocumentDeleteConfirm,
      loader: () => ({ documentId: DOCUMENT_ID, title: "資料タイトル" }),
      action: () => actionData,
    },
  ]);
  return render(<Stub initialEntries={[path]} />);
}

describe("削除確認画面コンポーネント", () => {
  it("資料タイトルと復元できない旨を表示し、確認後にPOSTする導線だけを置く", async () => {
    renderConfirm();

    expect(await screen.findByText("資料タイトル")).toBeTruthy();
    expect(
      screen.getByText(/削除すると、この資料は元に戻せません/),
    ).toBeTruthy();

    const submit = screen.getByRole("button", { name: "削除する" });
    expect(submit.closest("form")?.getAttribute("method")).toBe("post");

    const cancel = screen.getByRole("link", { name: "キャンセル" });
    expect(cancel.getAttribute("href")).toBe("/app");
  });
});
