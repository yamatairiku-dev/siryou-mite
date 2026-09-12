/**
 * アップロードaction(設計 §13の`/documents`)。
 *
 * 画面を持たないresource routeとし、処理本体は
 * `app/lib/upload/upload.server.ts`(server専用)に置く。
 */
import { handleDocumentUpload } from "~/lib/upload/upload.server";
import { securityHeaders } from "~/lib/security.server";
import type { Route } from "./+types/documents";

/** このrouteはアップロード専用で、GETで返す資料は無い(設計 §13)。 */
export async function loader() {
  return methodNotAllowed();
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return methodNotAllowed();
  }
  return handleDocumentUpload(request);
}

function methodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: "POST", ...securityHeaders() },
  });
}
