/**
 * Easy Authが付加する`X-MS-CLIENT-PRINCIPAL`headerのfixture(設計 §7.1, §7.1.2, §18.3)。
 *
 * `app/lib/auth/easy-auth.server.ts`が実装するBase64 → JSON → Zod検証と同じ構造
 * (`{ auth_typ, claims: [{ typ, val }] }`)をtestコード側でだけ組み立てる。
 * productionで有効になり得る認証bypassやテスト専用ログインrouteは作らない
 * (このfixtureはPlaywrightのHTTPリクエストへ載せるだけで、アプリ側には何も
 * 追加しない)。
 */
import { randomUUID } from "node:crypto";
import { ENTRA_TENANT_ID } from "./constants.js";

type Claim = { typ: string; val: string };

export type PrincipalInput = {
  /** 省略時はランダムなUUID(oid)を生成する(テスト間の所有者分離、設計判断)。 */
  oid?: string;
  /** 省略時は`ENTRA_TENANT_ID`と一致させる(正常系)。 */
  tid?: string | undefined;
  roles?: string[];
  groups?: string[];
  name?: string;
  email?: string;
  /** `true`にするとoid claim自体を含めない(必須claim欠落のテスト用)。 */
  omitObjectId?: boolean;
  /** `true`にするとemail claim自体を含めない(必須claim欠落のテスト用)。 */
  omitEmail?: boolean;
  /** `auth_typ`を`aad`以外にする(検証失敗のテスト用)。 */
  authType?: string;
};

/** `X-MS-CLIENT-PRINCIPAL`headerへそのまま渡せるbase64文字列を組み立てる。 */
export function encodeEasyAuthPrincipal(input: PrincipalInput = {}): string {
  const claims: Claim[] = [];

  if (!input.omitObjectId) {
    claims.push({ typ: "oid", val: input.oid ?? randomUUID() });
  }
  claims.push({ typ: "tid", val: input.tid ?? ENTRA_TENANT_ID });
  for (const role of input.roles ?? []) {
    claims.push({ typ: "roles", val: role });
  }
  for (const group of input.groups ?? []) {
    claims.push({ typ: "groups", val: group });
  }
  if (input.name) {
    claims.push({ typ: "name", val: input.name });
  }
  if (!input.omitEmail) {
    claims.push({ typ: "email", val: input.email ?? "e2e-user@example.test" });
  }

  const payload = { auth_typ: input.authType ?? "aad", claims };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export type Persona = {
  oid: string;
  email: string;
  name: string;
  roles: string[];
  groups: string[];
  /** `extraHTTPHeaders`にそのまま渡せるheader値。 */
  header: string;
};

/**
 * 1テストで使い切りのペルソナを作る。`oid`をランダムなUUIDにすることで、
 * テスト間の所有者・監査行を分離する(設計判断。QUESTIONS.md参照)。
 */
export function createPersona(options: {
  namePrefix: string;
  roles: string[];
  groups: string[];
  tenantId?: string;
}): Persona {
  const oid = randomUUID();
  const shortId = oid.slice(0, 8);
  const email = `${options.namePrefix}-${shortId}@example.test`;
  const name = `${options.namePrefix}-${shortId}`;

  return {
    oid,
    email,
    name,
    roles: options.roles,
    groups: options.groups,
    header: encodeEasyAuthPrincipal({
      oid,
      tid: options.tenantId,
      roles: options.roles,
      groups: options.groups,
      name,
      email,
    }),
  };
}
