-- Up Migration
--
-- 設計: docs/APPLICATION_DESIGN.md §12.2(audit_events), §15.1(監査履歴), §16(保持期間)
--
-- forward-only: このファイルへ "-- Down Migration" セクションは書かない。

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 設計 §12.2の例示区分。新しい区分が必要になった場合は
  -- CHECK制約を更新する新しいmigrationを追加する。
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  -- 検証・保存失敗時は資料レコード自体を作らないため、その監査はdocument_idを持たない
  -- (設計 §11.1)。ON DELETE指定なし(NO ACTION)のFKにする: ON DELETE SET NULLは
  -- documents行のDELETE時にaudit_eventsへUPDATEを発行してしまい、末尾の追記専用
  -- triggerと衝突する。documentsのsoft delete(status更新)はDELETE文ではないため
  -- この制約の影響を受けない。documents行の物理purge(設計 §16、Maintenance Job、
  -- T19)は、このFKと追記専用triggerの両方を踏まえた手順をT19側で設計すること。
  document_id UUID REFERENCES documents (id),
  actor_subject_id TEXT NOT NULL,
  actor_tenant_id TEXT NOT NULL,
  actor_email_at_event TEXT,
  actor_group_values TEXT[],
  actor_roles TEXT[],
  correlation_id UUID NOT NULL,
  error_category TEXT,
  -- 1年後の削除予定日時(設計 §16)。occurred_atから自動計算する(このファイル末尾の
  -- BEFORE INSERT triggerで設定する。`timestamptz + interval`はtimezoneに依存し
  -- IMMUTABLEではないため、GENERATED列にはできない)。
  retain_until TIMESTAMPTZ NOT NULL,
  CONSTRAINT audit_events_action_check
    CHECK (action IN ('upload', 'view', 'delete', 'admin_operation')),
  CONSTRAINT audit_events_result_check
    CHECK (result IN ('success', 'denied', 'failed'))
);

COMMENT ON TABLE audit_events IS
  '監査イベント。追記専用(このファイル末尾のtriggerでUPDATE/DELETEをDB側で禁止する)。'
  'HTML本文、質問・回答全文、token、Cookie、principal header全文、ファイル名、'
  'IPアドレスは保存しない(設計 §12.2)。';

-- 監査履歴検索(設計 §5.7): 日時、利用者、資料ID、操作、結果。
CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at DESC);
CREATE INDEX audit_events_document_id_idx ON audit_events (document_id);
CREATE INDEX audit_events_actor_subject_id_idx ON audit_events (actor_subject_id);
CREATE INDEX audit_events_action_idx ON audit_events (action);
CREATE INDEX audit_events_result_idx ON audit_events (result);
-- Maintenance Jobの保持期間経過分purge(設計 §16, docs/OPERATIONS.md 定期Job)用。
CREATE INDEX audit_events_retain_until_idx ON audit_events (retain_until);

-- 監査イベントは追記専用とする(設計 §12.2「通常のアプリ操作から更新・削除できない」)。
-- runtime用roleのGRANT設定(このファイル末尾のGRANTやrestrict-runtime-role-privileges
-- migration)に依存せず、DB側でも防ぐためBEFORE UPDATE/DELETE triggerでRAISE EXCEPTIONする。
-- 保持期間経過後のpurgeなど、意図的な削除が必要な運用作業は、このtriggerを一時的に
-- `ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only;`で無効化できる
-- テーブル所有者相当の権限を持つ専用の運用手順からのみ行う想定とする(T03のスコープ外)。
CREATE FUNCTION audit_events_prevent_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION audit_events_prevent_mutation();

-- retain_untilはoccurred_atから機械的に計算し、呼び出し側が任意の値を指定しても
-- 上書きする(設計 §16の保持期間をDB側で担保する)。
CREATE FUNCTION audit_events_set_retain_until() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.retain_until := NEW.occurred_at + INTERVAL '1 year';
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_set_retain_until_trigger
  BEFORE INSERT ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION audit_events_set_retain_until();
