/**
 * React Routerの既定のserver entry(`@react-router/dev`の`entry.server.node.tsx`)に、
 * HTML文書応答のCSP(要求ごとのnonce)を足したもの。nonceは`<ServerRouter nonce>`経由で
 * `<Scripts>`・`<ScrollRestoration>`などのインラインスクリプトにも付く。
 * 開発サーバー(`react-router dev`)はHMR用のインラインスクリプト・スタイルを使うため
 * CSPを付けない。`import.meta.env.DEV`はbuild時の`NODE_ENV`で決まり、E2E(`NODE_ENV=test`
 * でbuild)でもtrueになるため、実行時の`NODE_ENV`が`development`の場合に限る。
 * 本番build(`DEV=false`)では常にCSPを付ける。
 */
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";

import type { EntryContext, RouterContextProvider } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";
import { env } from "~/lib/env.server";
import { documentContentSecurityPolicy } from "~/lib/security.server";

export const streamTimeout = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  const nonce = randomBytes(16).toString("base64");
  const isDevelopmentServer =
    import.meta.env.DEV && env.NODE_ENV === "development";
  if (!isDevelopmentServer) {
    responseHeaders.set(
      "Content-Security-Policy",
      documentContentSecurityPolicy({
        nonce,
        displayOrigin: env.DISPLAY_ORIGIN,
      }),
    );
  }

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    let userAgent = request.headers.get("user-agent");

    // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
    // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
    let readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode
        ? "onAllReady"
        : "onShellReady";

    // Abort the rendering stream after the `streamTimeout` so it has time to
    // flush down the rejected boundaries
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => abort(),
      streamTimeout + 1000,
    );

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
      {
        nonce,
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              // Clear the timeout to prevent retaining the closure and memory leak
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");

          pipe(body);

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Log streaming rendering errors from inside the shell.  Don't log
          // errors encountered during initial shell rendering since they'll
          // reject and get logged in handleDocumentRequest.
          if (shellRendered) {
            console.error(error);
          }
        },
      },
    );
  });
}
