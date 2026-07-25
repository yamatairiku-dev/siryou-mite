# Repository Guidelines

## Required workflow

1. Read `docs/DEVELOPMENT_STANDARD.md` and `docs/SECURITY.md`.
2. Keep React Router in Framework Mode with SSR enabled. Do not enable RSC.
3. Put server-only code in files ending with `.server.ts`.
4. Authenticate protected loaders and actions with `requireUser(request)`.
5. Authorize the requested operation at the server/data boundary; UI hiding is not authorization.
6. Validate untrusted input with Zod.
7. Call `assertSameOrigin(request)` in every cookie-authenticated mutation action.
8. Never log secrets, tokens, authorization codes, session cookies, or personal data.
9. Add or update tests for behavior changes.
10. Run `npm run verify` before handoff.

## Structure

- `app/routes`: route modules and resource routes
- `app/lib`: shared application code; server-only modules use `.server.ts`
- `tests/unit`: isolated logic and route tests
- `tests/e2e`: critical user flows only
- `docs`: current operational documents; do not add status-report files to the root

## Change control

- Keep dependencies minimal and justify every production dependency in the pull request.
- Update all `react-router` and `@react-router/*` packages together.
- Do not weaken cookie flags, origin checks, environment validation, or the non-root container.
- Record architecture changes in `docs/ARCHITECTURE.md`.
- Update `docs/OPERATIONS.md` for any environment variable or deployment change.
