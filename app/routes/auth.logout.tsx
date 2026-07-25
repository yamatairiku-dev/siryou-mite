import type { Route } from "./+types/auth.logout";
import { assertSameOrigin } from "~/lib/security.server";
import { destroyUserSession } from "~/lib/session.server";

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  return destroyUserSession(request);
}

export async function loader() {
  throw new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  });
}
