/**
 * 運用ログの実処理(設計 §15.2)。
 *
 * stdoutへ1行1eventのJSONで出力する。記録してよい項目(相関ID、時刻、処理名、
 * 成否、エラー分類、pseudonymize化した利用者識別子、資料ID)だけを型で受け付け、
 * HTML本文、プレビュー、ファイル名、メールアドレス、token、Cookie、
 * `X-MS-CLIENT-PRINCIPAL`、表示grant、request body、クエリ文字列は引数に取らない。
 *
 * 利用者の`oid`はログ専用のHMAC鍵(`LOG_HMAC_KEY`)で変換してから記録する
 * (設計 §9.5, §15.2)。鍵そのものはログへ出さない。
 *
 * Web(`app/lib/log.server.ts`)とDisplay・Preview・Maintenanceで出力形式を
 * 揃えるため、実処理は`services/shared/`へ集約する(docs/ARCHITECTURE.md)。
 * このモジュールは環境変数を読まず、HMAC鍵を引数で受け取る。
 */
import { createHmac } from "node:crypto";

/** 監査の`result`(設計 §15.1)と同じ3値をログでも使う。 */
export type OperationLogResult = "success" | "denied" | "failed";

export type OperationLogEvent = {
  /** 処理名。固定文字列だけを渡す(利用者入力を混ぜない)。 */
  event: string;
  /** server側で発行した相関ID(UUID)。 */
  correlationId: string;
  result: OperationLogResult;
  /** 監査と同じ分類名。秘密情報・個人情報を含まない固定文字列だけ。 */
  errorCategory?: string | null;
  /** 利用者の`oid`。出力前に必ずHMAC化する。 */
  actorSubjectId?: string | null;
  /** 資料ID(推測困難なランダム値で、個人情報ではない)。 */
  documentId?: string | null;
};

export type OperationLogger = {
  /** 利用者識別子をログ専用鍵でHMAC化する(設計 §15.2)。 */
  pseudonymizeSubjectId(subjectId: string): string;
  /** 1行1eventのJSONを出力する。 */
  logOperationEvent(event: OperationLogEvent): void;
};

/**
 * ログ専用のHMAC鍵(base64)を束ねたloggerを作る。
 * 鍵はプロセス起動時にZod検証済みの環境変数から渡す。
 */
export function createOperationLogger(logHmacKeyBase64: string): OperationLogger {
  const key = Buffer.from(logHmacKeyBase64, "base64");

  /**
   * 出力を短く保つため先頭32桁(128bit)だけを使う。
   */
  function pseudonymizeSubjectId(subjectId: string): string {
    return createHmac("sha256", key)
      .update(subjectId, "utf8")
      .digest("hex")
      .slice(0, 32);
  }

  /**
   * ログ出力自体の失敗で業務処理を止めない(設計 §15.2)。
   */
  function logOperationEvent(event: OperationLogEvent): void {
    try {
      const line = {
        time: new Date().toISOString(),
        event: event.event,
        result: event.result,
        correlationId: event.correlationId,
        errorCategory: event.errorCategory ?? null,
        actor: event.actorSubjectId
          ? pseudonymizeSubjectId(event.actorSubjectId)
          : null,
        documentId: event.documentId ?? null,
      };
      console.log(JSON.stringify(line));
    } catch {
      // ログ出力の失敗は握りつぶす(業務処理を止めない)。
    }
  }

  return { pseudonymizeSubjectId, logOperationEvent };
}
