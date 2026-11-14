import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSameOrigin,
  documentContentSecurityPolicy,
  securityHeaders,
} from "~/lib/security.server";

describe("assertSameOrigin", () => {
  // 単体テストの`APP_ORIGIN`は`http://localhost:3000`(`tests/setup.ts`)。
  it("OriginがAPP_ORIGINと一致する要求を許可する", () => {
    const request = new Request("http://localhost:3000/action", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
    });

    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it("異なるオリジンを拒否する", () => {
    const request = new Request("http://localhost:3000/action", {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    });

    expect(() => assertSameOrigin(request)).toThrow();
  });

  it("Originがない更新リクエストを拒否する", () => {
    const request = new Request("http://localhost:3000/action", {
      method: "POST",
    });

    expect(() => assertSameOrigin(request)).toThrow();
  });

  it("request.urlと一致していても、APP_ORIGINと異なるOriginは拒否する", () => {
    // `request.url`のhostは要求のHost header由来で、設定値より信頼できない。
    const request = new Request("https://internal.example/action", {
      method: "POST",
      headers: { Origin: "https://internal.example" },
    });

    expect(() => assertSameOrigin(request)).toThrow();
  });

  it("schemeだけ異なるOriginは拒否する", () => {
    const request = new Request("http://localhost:3000/action", {
      method: "POST",
      headers: { Origin: "https://localhost:3000" },
    });

    expect(() => assertSameOrigin(request)).toThrow();
  });

  describe("TLSを終端するingressの背後(Azure)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("request.urlがhttpでも、OriginがAPP_ORIGIN(https)と一致すれば許可する", async () => {
      // stagingでログインを含むすべてのmutationが拒否された不具合の再発防止。
      // ingressがTLSを終端するため、Webには`http://<公開host>`として届く。
      vi.stubEnv("APP_ORIGIN", "https://app.example.test");
      vi.resetModules();
      const { assertSameOrigin: assertBehindIngress } = await import(
        "~/lib/security.server"
      );
      const request = new Request("http://app.example.test/auth/login", {
        method: "POST",
        headers: { Origin: "https://app.example.test" },
      });

      expect(() => assertBehindIngress(request)).not.toThrow();
    });

    it("request.urlと同じhttpのOriginは、APP_ORIGIN(https)と異なるため拒否する", async () => {
      vi.stubEnv("APP_ORIGIN", "https://app.example.test");
      vi.resetModules();
      const { assertSameOrigin: assertBehindIngress } = await import(
        "~/lib/security.server"
      );
      const request = new Request("http://app.example.test/auth/login", {
        method: "POST",
        headers: { Origin: "http://app.example.test" },
      });

      expect(() => assertBehindIngress(request)).toThrow();
    });
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

  it("フォームの宛先は表示サービスとEntra IDのリダイレクト先だけ、iframeは表示サービスだけを許可する", () => {
    // 資料内の外部リンクをiframe内で開かせない(設計 §6.3)。
    expect(directives.get("frame-src")).toBe("https://display.example.com");
    expect(directives.get("form-action")).toBe(
      "'self' https://display.example.com https://login.microsoftonline.com",
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

