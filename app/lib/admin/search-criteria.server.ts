/**
 * 管理画面(設計 §5.6の`/admin/documents`、§5.7の`/admin/audit`)が共通で使う
 * 検索条件の検証部品。
 *
 * どちらの画面も、日時は画面表示(設計 §5.2)と同じ日本時間の分単位で受け取り、
 * UTCへ変換してからrepositoryへ渡す。変換規則を画面ごとに書くと境界の扱いが
 * ずれるため、ここに1つだけ置く。DB・環境変数・Blobへは触れないが、loader
 * (server側)からしか使わないため`.server.ts`に置く。
 */
import { z } from "zod";

/** 日本時間の固定オフセット(サマータイムが無いため定数でよい。設計 §5.2)。 */
const JST_UTC_OFFSET_MINUTES = 9 * 60;

/** 画面が送ってくる日時(`datetime-local`と同じ`YYYY-MM-DDTHH:mm`形式)。 */
export const jstMinutePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * 日本時間の`YYYY-MM-DDTHH:mm`をUTCのISO日時文字列へ変換する。
 * 形式・実在しない日付(`2026-02-30`など)はfail closedで`null`を返す。
 *
 * `addMinutes`は「指定した分の終わりまでを含める」上限の組み立てに使う
 * (repository側のSQLは排他的上限`< 上限`のため、1分進めた値を渡す)。
 */
export function jstMinuteToUtcIso(value: string, addMinutes = 0): string | null {
  if (!jstMinutePattern.test(value)) {
    return null;
  }
  const millis = Date.parse(`${value}:00.000+09:00`);
  if (Number.isNaN(millis)) {
    return null;
  }
  // `2026-02-30`のような存在しない日付は翌月へ繰り上がって解釈されるため、
  // 日本時間へ戻して入力と一致することを確かめる。
  const roundTrip = new Date(millis + JST_UTC_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 16);
  if (roundTrip !== value) {
    return null;
  }
  return new Date(millis + addMinutes * 60_000).toISOString();
}

/** 日本時間の分単位入力を受け付けるschema(実在する日時だけを通す)。 */
export const jstMinuteSchema = z
  .string()
  .regex(jstMinutePattern)
  .refine((value) => jstMinuteToUtcIso(value) !== null);

/** 空文字(未指定)を許す検索条件のschema。 */
export function optionalCriterion<T extends z.ZodType<string>>(schema: T) {
  return z.union([z.literal(""), schema]);
}

/**
 * URLのクエリ文字列から検索条件を読み出す。未指定は空文字にそろえ、
 * 前後の空白は落とす(空白だけの入力で全件一致パターンを作らないため)。
 * ここでは検証しない。呼び出し側がZodのstrict objectで検証する。
 */
export function readSearchCriteria<Name extends string>(
  request: Request,
  names: readonly Name[],
): Record<Name, string> {
  const params = new URL(request.url).searchParams;
  const criteria = {} as Record<Name, string>;
  for (const name of names) {
    criteria[name] = (params.get(name) ?? "").trim();
  }
  return criteria;
}
