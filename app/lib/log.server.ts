/**
 * 運用ログのWeb向け薄いラッパー(設計 §15.2)。
 *
 * 実処理は`services/shared/log.ts`に実装する(Web・Display・Preview・Maintenanceで
 * 出力形式を揃えるため)。このファイルはWeb固有の関心事、すなわち
 * `app/lib/env.server.ts`(Zod検証済み環境変数)からHMAC鍵を渡す部分だけを持つ。
 */
import { env } from "~/lib/env.server";
import { createOperationLogger } from "../../services/shared/log";

export type {
  OperationLogEvent,
  OperationLogResult,
} from "../../services/shared/log";

const logger = createOperationLogger(env.LOG_HMAC_KEY);

/** 利用者識別子をログ専用鍵でHMAC化する(設計 §15.2)。 */
export const pseudonymizeSubjectId = logger.pseudonymizeSubjectId;

/** 1行1eventのJSONを出力する(設計 §15.2)。 */
export const logOperationEvent = logger.logOperationEvent;
