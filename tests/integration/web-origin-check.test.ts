import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Web(`react-router-serve` + `server/web-build.mjs`)のOrigin検査(設計 §7.1.1, §9)。
 *
 * AzureではingressがTLSを終端し、Webには`http://<公開host>`として届く。React Routerの
 * 組み込みCSRF検査とアプリの`assertSameOrigin`が`request.url`(http)とブラウザの
 * `Origin`(https)を比較していたため、stagingでログインを含むすべてのmutationが
 * `400 Bad Request`で拒否された。その再発防止として、実際のWebサーバーを
 * `APP_ORIGIN=https://...`で起動し、ingressと同じ形の要求(schemeはhttp、Hostは公開host)を
 * 送って確認する。
 *
 * buildした成果物を使うため、`npm run build && npm run build:services`の後に実行する
 * (CIは`npm run verify`の後に結合テストを実行する)。成果物が無い環境ではskipする。
 */

const PUBLIC_HOST = "app.example.test";
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;

const buildExists =
  existsSync("build/server/index.js") &&
  existsSync("build/services/shared/action-origins.js");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

type Reply = { status: number; headers: IncomingHttpHeaders };

/** ingressの背後と同じ形(http接続、Hostは公開host)で要求を送る。 */
function send(
  port: number,
  options: { method: string; path: string; origin?: string; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: {
          Host: PUBLIC_HOST,
          ...(options.origin ? { Origin: options.origin } : {}),
          ...(options.body !== undefined
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(options.body),
              }
            : {}),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers }),
        );
      },
    );
    req.once("error", reject);
    req.end(options.body);
  });
}

describe.skipIf(!buildExists)(
  "Web: TLSを終端するingressの背後でのOrigin検査",
  () => {
    let server: ChildProcess | undefined;
    let port = 0;

    beforeAll(async () => {
      port = await freePort();
      server = spawn(
        process.execPath,
        ["node_modules/@react-router/serve/bin.cjs", "server/web-build.mjs"],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            PORT: String(port),
            APP_ORIGIN: PUBLIC_ORIGIN,
            AUTH_MODE: "easyauth",
            ENTRA_TENANT_ID: "00000000-0000-4000-8000-000000000001",
          },
          stdio: "ignore",
        },
      );

      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          const reply = await send(port, { method: "GET", path: "/health" });
          if (reply.status === 200) {
            return;
          }
        } catch {
          // 起動待ち。
        }
        if (Date.now() > deadline) {
          throw new Error("Webの起動を確認できませんでした");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });

    afterAll(async () => {
      const current = server;
      if (!current || current.exitCode !== null) {
        return;
      }
      await new Promise<void>((resolve) => {
        current.once("exit", () => resolve());
        current.kill("SIGTERM");
      });
    });

    // `/auth/login`は画面を持つroute。React Routerの組み込みCSRF検査とアプリの
    // `assertSameOrigin`の両方を通る。stagingで400になったのはこの経路。
    describe("画面を持つrouteのaction(/auth/login)", () => {
      it("公開オリジン(https)からのform送信を受け付け、Easy Authのloginへ遷移させる", async () => {
        const reply = await send(port, {
          method: "POST",
          path: "/auth/login",
          origin: PUBLIC_ORIGIN,
          body: "returnTo=%2Fapp",
        });

        expect(reply.status).toBe(302);
        expect(String(reply.headers.location)).toBe(
          `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(`${PUBLIC_ORIGIN}/app`)}`,
        );
        expect(reply.headers["x-remix-reload-document"]).toBe("true");
      });

      it("画面内の送信(single fetchの`.data`)も公開オリジンからなら受け付ける", async () => {
        const reply = await send(port, {
          method: "POST",
          path: "/auth/login.data",
          origin: PUBLIC_ORIGIN,
          body: "returnTo=%2Fapp",
        });

        // single fetchはredirectを202の本文で返す。400・403でなければ検査を通過している。
        expect(reply.status).toBe(202);
      });

      it("別サイトのOriginはReact RouterのCSRF検査が400で拒否する", async () => {
        const reply = await send(port, {
          method: "POST",
          path: "/auth/login",
          origin: "https://evil.example",
          body: "returnTo=%2Fapp",
        });

        expect(reply.status).toBe(400);
      });

      it("request.urlと同じhttpのOriginは、公開オリジンと異なるためアプリが403で拒否する", async () => {
        const reply = await send(port, {
          method: "POST",
          path: "/auth/login",
          origin: `http://${PUBLIC_HOST}`,
          body: "returnTo=%2Fapp",
        });

        expect(reply.status).toBe(403);
      });
    });

    // `/auth/logout`は画面を持たないresource route。React RouterのCSRF検査は
    // resource routeに適用されないため、アプリの`assertSameOrigin`だけが守る。
    describe("resource routeのaction(/auth/logout)", () => {
      it("公開オリジン(https)からのform送信を受け付け、Easy Authのlogoutへ遷移させる", async () => {
        const reply = await send(port, {
          method: "POST",
          path: "/auth/logout",
          origin: PUBLIC_ORIGIN,
          body: "",
        });

        expect(reply.status).toBe(302);
        expect(String(reply.headers.location)).toContain("/.auth/logout");
        expect(reply.headers["x-remix-reload-document"]).toBe("true");
      });

      it("別サイトのOriginはアプリが403で拒否する", async () => {
        const reply = await send(port, {
          method: "POST",
          path: "/auth/logout",
          origin: "https://evil.example",
          body: "",
        });

        expect(reply.status).toBe(403);
      });

      it("Originの無いmutationはアプリが403で拒否する", async () => {
        const reply = await send(port, {
          method: "POST",
          path: "/auth/logout",
          body: "",
        });

        expect(reply.status).toBe(403);
      });
    });
  },
);
