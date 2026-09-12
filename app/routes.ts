import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("app", "routes/app.tsx"),
  route("documents", "routes/documents.ts"),
  route("documents/:documentId", "routes/documents.$documentId.tsx"),
  route(
    "documents/:documentId/delete",
    "routes/documents.$documentId.delete.tsx",
  ),
  route("auth/login", "routes/auth.login.tsx"),
  route("auth/logout", "routes/auth.logout.tsx"),
  route("health", "routes/health.ts"),
] satisfies RouteConfig;
