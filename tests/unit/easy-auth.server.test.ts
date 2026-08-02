import { describe, expect, it } from "vitest";
import { parseEasyAuthPrincipal } from "~/lib/auth/easy-auth.server";

function encode(claims: Array<{ typ: string; val: string }>) {
  return Buffer.from(JSON.stringify({ auth_typ: "aad", claims })).toString(
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

  it("tenant不一致を拒否する", () => {
    expect(() =>
      parseEasyAuthPrincipal(encode(baseClaims), "other-tenant"),
    ).toThrow(expect.objectContaining({ status: 401 }));
  });

  it("claim mapping後のURI形式rolesとgroupsを受け付ける", () => {
    const claims = baseClaims
      .filter((claim) => claim.typ !== "roles" && claim.typ !== "groups")
      .concat([
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

  it("不正なBase64 JSONを拒否する", () => {
    expect(() => parseEasyAuthPrincipal("not-json", "tenant-001")).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });
});
