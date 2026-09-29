import { describe, expect, it } from "vitest";
import { parseEasyAuthPrincipal } from "~/lib/auth/easy-auth.server";

function encode(
  claims: Array<{ typ: string; val: string }>,
  authType = "aad",
) {
  return Buffer.from(JSON.stringify({ auth_typ: authType, claims })).toString(
    "base64",
  );
}

const baseClaims = [
  {
    typ: "http://schemas.microsoft.com/identity/claims/objectidentifier",
    val: "user-001",
  },
  {
    typ: "http://schemas.microsoft.com/identity/claims/tenantid",
    val: "tenant-001",
  },
  { typ: "name", val: "テスト利用者" },
  { typ: "preferred_username", val: "user@example.com" },
  { typ: "roles", val: "User" },
  { typ: "groups", val: "ZAA535-A" },
  { typ: "groups", val: "ZAA090-A" },
];

/** 指定したclaim typeを取り除いたclaim配列を作る。 */
function withoutTypes(...types: string[]) {
  return baseClaims.filter((claim) => !types.includes(claim.typ));
}

describe("parseEasyAuthPrincipal", () => {
  it("Easy Auth principalからrolesと複数groupsを抽出する", () => {
    expect(parseEasyAuthPrincipal(encode(baseClaims), "tenant-001")).toEqual({
      id: "user-001",
      tenantId: "tenant-001",
      name: "テスト利用者",
      email: "user@example.com",
      roles: ["User"],
      groups: ["ZAA535-A", "ZAA090-A"],
    });
  });

  it("短縮名のoid・tidも受け付ける", () => {
    const claims = withoutTypes(
      "http://schemas.microsoft.com/identity/claims/objectidentifier",
      "http://schemas.microsoft.com/identity/claims/tenantid",
    ).concat([
      { typ: "oid", val: "user-002" },
      { typ: "tid", val: "tenant-001" },
    ]);

    const user = parseEasyAuthPrincipal(encode(claims), "tenant-001");
    expect(user.id).toBe("user-002");
    expect(user.tenantId).toBe("tenant-001");
  });

  it("claim mapping後のURI形式rolesとgroupsを受け付ける", () => {
    const claims = withoutTypes("roles", "groups").concat([
      {
        typ: "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
        val: "Admin",
      },
      {
        typ: "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
        val: "ZAA535-A",
      },
    ]);

    const user = parseEasyAuthPrincipal(encode(claims), "tenant-001");
    expect(user.roles).toEqual(["Admin"]);
    expect(user.groups).toEqual(["ZAA535-A"]);
  });

  it("短縮名とURI形式で重複したgroupsを重複除去する", () => {
    const claims = baseClaims.concat([
      {
        typ: "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
        val: "ZAA535-A",
      },
      { typ: "groups", val: "ZAA090-A" },
      { typ: "groups", val: "ZAA777-B" },
    ]);

    expect(parseEasyAuthPrincipal(encode(claims), "tenant-001").groups).toEqual([
      "ZAA535-A",
      "ZAA090-A",
      "ZAA777-B",
    ]);
  });

  it("allowlistに無いclaim typeを認証・認可へ使わない", () => {
    const claims = withoutTypes("roles", "groups").concat([
      { typ: "role", val: "Admin" },
      { typ: "wids", val: "Admin" },
      { typ: "group", val: "ZAA535-A" },
      {
        typ: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
        val: "attacker-oid",
      },
    ]);

    const user = parseEasyAuthPrincipal(encode(claims), "tenant-001");
    expect(user.roles).toEqual([]);
    expect(user.groups).toEqual([]);
    expect(user.id).toBe("user-001");
  });

  it("tenant不一致を拒否する", () => {
    expect(() =>
      parseEasyAuthPrincipal(encode(baseClaims), "other-tenant"),
    ).toThrow(expect.objectContaining({ status: 401 }));
  });

  it("tenant IDの大文字小文字差は同一とみなす", () => {
    expect(
      parseEasyAuthPrincipal(encode(baseClaims), "TENANT-001").tenantId,
    ).toBe("tenant-001");
  });

  it.each([[undefined], [""], ["   "]])(
    "構成テナントが %s の場合は認証させない",
    (expectedTenantId) => {
      expect(() =>
        parseEasyAuthPrincipal(encode(baseClaims), expectedTenantId),
      ).toThrow(/ENTRA_TENANT_ID/);
    },
  );

  it("不正なBase64 JSONを拒否する", () => {
    expect(() => parseEasyAuthPrincipal("not-json", "tenant-001")).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it("Base64はdecodeできてもJSONでない場合を拒否する", () => {
    const encoded = Buffer.from("これはJSONではありません").toString("base64");
    expect(() => parseEasyAuthPrincipal(encoded, "tenant-001")).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it.each([
    ["claimsが配列でない", { auth_typ: "aad", claims: "ZAA535-A" }],
    ["auth_typが無い", { claims: [] }],
    ["claim valが空文字", { auth_typ: "aad", claims: [{ typ: "oid", val: "" }] }],
    ["claimsが無い", { auth_typ: "aad" }],
  ])("Zod検証に失敗するprincipal(%s)を拒否する", (_label, payload) => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    expect(() => parseEasyAuthPrincipal(encoded, "tenant-001")).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it("aad以外のauth_typを拒否する", () => {
    expect(() =>
      parseEasyAuthPrincipal(encode(baseClaims, "twitter"), "tenant-001"),
    ).toThrow(expect.objectContaining({ status: 401 }));
  });

  it.each([
    [
      "oid",
      "http://schemas.microsoft.com/identity/claims/objectidentifier",
    ],
    ["tid", "http://schemas.microsoft.com/identity/claims/tenantid"],
    ["メールアドレス", "preferred_username"],
  ])("必須claim(%s)が無いprincipalを拒否する", (_label, claimType) => {
    expect(() =>
      parseEasyAuthPrincipal(encode(withoutTypes(claimType)), "tenant-001"),
    ).toThrow(expect.objectContaining({ status: 401 }));
  });

  it("大きすぎるprincipalを拒否する", () => {
    expect(() =>
      parseEasyAuthPrincipal("A".repeat(64 * 1024 + 1), "tenant-001"),
    ).toThrow(expect.objectContaining({ status: 401 }));
  });

  it.each([
    ["hasgroups", [{ typ: "hasgroups", val: "true" }]],
    ["_claim_names", [{ typ: "_claim_names", val: '{"groups":"src1"}' }]],
    [
      "_claim_sources",
      [
        { typ: "_claim_names", val: '{"groups":"src1"}' },
        {
          typ: "_claim_sources",
          val: '{"src1":{"endpoint":"https://graph.microsoft.com/v1.0/users/user-001/getMemberObjects"}}',
        },
      ],
    ],
    [
      "groups.link",
      [
        {
          typ: "http://schemas.microsoft.com/claims/groups.link",
          val: "https://graph.microsoft.com/v1.0/users/user-001/getMemberObjects",
        },
      ],
    ],
  ])("group overage(%s)をfail closedで拒否する", (_label, overageClaims) => {
    const claims = withoutTypes("groups").concat(overageClaims);
    expect(() => parseEasyAuthPrincipal(encode(claims), "tenant-001")).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it("一部のgroupsが届いていてもoverage時は拒否する", () => {
    const claims = baseClaims.concat([{ typ: "hasgroups", val: "true" }]);
    expect(() => parseEasyAuthPrincipal(encode(claims), "tenant-001")).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it("groupsを指さない_claim_namesはoverageとして扱わない", () => {
    const claims = baseClaims.concat([
      { typ: "_claim_names", val: '{"roles":"src1"}' },
    ]);
    expect(parseEasyAuthPrincipal(encode(claims), "tenant-001").groups).toEqual([
      "ZAA535-A",
      "ZAA090-A",
    ]);
  });

  it("hasgroupsがfalseの場合はoverageとして扱わない", () => {
    const claims = baseClaims.concat([{ typ: "hasgroups", val: "false" }]);
    expect(parseEasyAuthPrincipal(encode(claims), "tenant-001").groups).toEqual([
      "ZAA535-A",
      "ZAA090-A",
    ]);
  });

  it("所属が0件のprincipalはgroupsを空で返し、利用可否はrequireUserが判定する", () => {
    const user = parseEasyAuthPrincipal(
      encode(withoutTypes("groups")),
      "tenant-001",
    );
    expect(user.groups).toEqual([]);
  });

  it("拒否レスポンスへprincipal本文やclaim値を含めない", async () => {
    const secretClaims = withoutTypes("groups").concat([
      { typ: "groups", val: "SECRET-GROUP" },
      { typ: "hasgroups", val: "true" },
    ]);
    const encoded = encode(secretClaims);

    let thrown: unknown;
    try {
      parseEasyAuthPrincipal(encoded, "tenant-001");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    const body = await (thrown as Response).text();
    expect(body).toBe("所属情報を確認できません");
    expect(body).not.toContain(encoded);
    expect(body).not.toContain("SECRET-GROUP");
    expect(body).not.toContain("user@example.com");
  });
});
