import { describe, expect, it } from "vitest";
import {
  assertSameOrigin,
  documentContentSecurityPolicy,
  securityHeaders,
} from "~/lib/security.server";

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

describe("documentContentSecurityPolicy", () => {
  const policy = documentContentSecurityPolicy({
    nonce: "bm9uY2U=",
    displayOrigin: "https://display.example.com",
  });
  const directives = new Map(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values.join(" ")] as const;
    }),
  );

  it("スクリプトは同一オリジンと要求ごとのnonceだけを許可する", () => {
    expect(directives.get("script-src")).toBe("'self' 'nonce-bm9uY2U='");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("grant送信フォームの宛先は表示サービスだけ、iframeは表示サービスと資料内リンクの遷移先(http/https)を許可する", () => {
    expect(directives.get("frame-src")).toBe(
      "https://display.example.com https: http:",
    );
    expect(directives.get("form-action")).toBe(
      "'self' https://display.example.com",
    );
    expect(directives.get("connect-src")).toBe("'self'");
    expect(directives.get("img-src")).toBe("'self'");
  });

  it("埋め込み・base・pluginを拒否する", () => {
    expect(directives.get("frame-ancestors")).toBe("'none'");
    expect(directives.get("base-uri")).toBe("'none'");
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("default-src")).toBe("'self'");
  });
});

