import { describe, expect, it } from "vitest";
import { requireAllowedEntraEmail } from "~/lib/auth/email-domain.server";

describe("requireAllowedEntraEmail", () => {
  it("emailクレイムの許可ドメインを大文字小文字を区別せず受け入れる", () => {
    expect(
      requireAllowedEntraEmail(
        { email: "User@EXAMPLE.COM" },
        ["example.com"],
      ),
    ).toBe("User@EXAMPLE.COM");
  });

  it("emailクレイムがない場合はpreferred_usernameを使用する", () => {
    expect(
      requireAllowedEntraEmail(
        { preferred_username: "user@subsidiary.example.com" },
        ["example.com", "subsidiary.example.com"],
      ),
    ).toBe("user@subsidiary.example.com");
  });

  it("許可していないドメインを拒否する", () => {
    expect(() =>
      requireAllowedEntraEmail(
        { email: "user@attacker.example" },
        ["example.com"],
      ),
    ).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("サブドメインを暗黙には許可しない", () => {
    expect(() =>
      requireAllowedEntraEmail(
        { email: "user@sub.example.com" },
        ["example.com"],
      ),
    ).toThrow(expect.objectContaining({ status: 403 }));
  });

  it.each([
    undefined,
    {},
    { email: "not-an-email" },
    { email: ["user@example.com"] },
  ])("メールクレイムが不正な場合は拒否する", (claims) => {
    expect(() =>
      requireAllowedEntraEmail(claims, ["example.com"]),
    ).toThrow(expect.objectContaining({ status: 401 }));
  });
});
