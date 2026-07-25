import { describe, expect, it } from "vitest";
import { assertSameOrigin, securityHeaders } from "~/lib/security.server";

describe("assertSameOrigin", () => {
  it("同一オリジンを許可する", () => {
    const request = new Request("https://internal.example/action", {
      method: "POST",
      headers: { Origin: "https://internal.example" },
    });

    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it("異なるオリジンを拒否する", () => {
    const request = new Request("https://internal.example/action", {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    });

    expect(() => assertSameOrigin(request)).toThrow();
  });

  it("Originがない更新リクエストを拒否する", () => {
    const request = new Request("https://internal.example/action", {
      method: "POST",
    });

    expect(() => assertSameOrigin(request)).toThrow();
  });
});

describe("securityHeaders", () => {
  it("最低限の防御ヘッダーを返す", () => {
    expect(securityHeaders()).toMatchObject({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
  });
});
