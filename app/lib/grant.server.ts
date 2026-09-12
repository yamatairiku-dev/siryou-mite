/**
 * 表示grant発行のWeb向け薄いラッパー(設計 §7.2, §9.5, §10.3)。
 *
 * 実処理は`services/shared/grant.ts`に実装する(署名と検証で署名対象のbyte列が
 * 食い違わないようにするため)。`services/`配下は`app/`をimportしない方針
 * (docs/ARCHITECTURE.md、T04 Q-005)だが、逆方向(`app/` → `services/shared/`)は
 * この制約に反しない。このファイルはWeb固有の関心事、すなわち
 * `app/lib/env.server.ts`(Zod検証済み環境変数)から署名鍵を組み立てて使い回す部分
 * だけを持つ。
 *
 * Webは秘密鍵だけを持ち、検証は公開鍵を持つDisplayが行う(設計 §9.5)。
 * 発行したgrant・鍵・nonceはログへ出さない。
 */
import { env } from "~/lib/env.server";
import type { AppUser } from "~/lib/session.server";
import {
  createDisplayGrantSigningKey,
  signDisplayGrant,
  type DisplayGrantSigningKey,
} from "../../services/shared/grant";

/**
 * Webが必要とするのは「発行」だけのため、検証系API
 * (`verifyDisplayGrant`・`createDisplayGrantVerificationKeys`など)は再exportしない。
 * Display(`services/display/`)は`services/shared/grant.ts`を直接importする。
 * hidden formのフィールド名だけはWeb側の画面実装でも必要なので再exportする。
 */
export { DISPLAY_GRANT_FORM_FIELD } from "../../services/shared/grant";

let cachedSigningKey: DisplayGrantSigningKey | undefined;

function getSigningKey(): DisplayGrantSigningKey {
  if (!cachedSigningKey) {
    cachedSigningKey = createDisplayGrantSigningKey({
      keyId: env.GRANT_SIGNING_KEY_ID,
      privateKeyPem: env.GRANT_SIGNING_PRIVATE_KEY,
    });
  }
  return cachedSigningKey;
}

/**
 * 表示grantを発行する(設計 §10.3(3))。
 *
 * 呼び出し側は資料IDと`requireUser`が返す利用者だけを渡す。grantへ入るのは
 * 資料ID・`oid`・tenant ID・操作時点のメールアドレス・`iat`/`exp`・nonceで
 * (設計 §7.2)、Blobキーとファイル名は含めない。メールアドレスは形式として
 * 解釈できない場合(UPNなど)は`null`になり、発行自体は成功する(T09 Q-016)。
 * 有効期間は`GRANT_TTL_SECONDS`(既定60秒)。
 *
 * 発行したgrantとメールアドレスはログへ出さない(設計 §9.5)。
 */
export function issueDisplayGrant(
  input: {
    documentId: string;
    user: Pick<AppUser, "id" | "tenantId" | "email">;
  },
  options?: { now?: Date | undefined },
): string {
  return signDisplayGrant(
    {
      documentId: input.documentId,
      actorSubjectId: input.user.id,
      actorTenantId: input.user.tenantId,
      // メールアドレス形式でない値(UPNなど)は`signDisplayGrant`が`null`へ正規化する。
      actorEmailAtEvent: input.user.email,
    },
    {
      signingKey: getSigningKey(),
      ttlSeconds: env.GRANT_TTL_SECONDS,
      now: options?.now,
    },
  );
}

/** テスト後片付け用。プロセス内で使い回す署名鍵のキャッシュを破棄する。 */
export function resetDisplayGrantSigningKeyForTest(): void {
  cachedSigningKey = undefined;
}
