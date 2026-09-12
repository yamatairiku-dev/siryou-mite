-- Up Migration
--
-- 設計: docs/APPLICATION_DESIGN.md §6.1(頻度・同時実行の制限), §10.1(3)
--
-- forward-only: このファイルへ "-- Down Migration" セクションは書かない。
--
-- 件数・容量は`documents`から数えられるが、「1ユーザー1分5回」「同時アップロード1件」の
-- 判定に必要な"受け付けたアップロード試行"は既存テーブルに残らない(検証で拒否した
-- アップロードは資料レコードを作らないため。設計 §11.1)。Redisなどは追加しない
-- 方針(設計 §6.1)のため、PostgreSQLの1テーブルで試行を記録する。
--
-- 進行中(同時実行)の表現は`finished_at IS NULL AND expires_at > now()`とする。
-- 処理が異常終了して`finished_at`が更新されなくても`expires_at`で自動的に失効し、
-- 利用者が永久にブロックされない(設計 §14 の「利用者を行き止まりにしない」方針)。
--
-- 個人情報・業務情報は保存しない。owner_subject_idはEntra IDの内部識別子(oid)だけで、
-- ファイル名・HTML本文・byte数などは記録しない(設計 §12.2 の非記録方針に合わせる)。

CREATE TABLE upload_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Entra IDの内部識別子(oid)。documents.owner_subject_idと同じ値域。
  owner_subject_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 進行中leaseの失効時刻。明示的な解放(finished_at)が無くてもここで失効する。
  expires_at TIMESTAMPTZ NOT NULL,
  -- アップロード処理が成功・失敗どちらで終わっても設定する明示的な解放時刻。
  finished_at TIMESTAMPTZ,
  CONSTRAINT upload_attempts_expires_at_check
    CHECK (expires_at > started_at)
);

COMMENT ON TABLE upload_attempts IS
  'アップロード試行の記録。頻度(1分あたり)と同時実行の判定にだけ使う(設計 §6.1, §10.1(3))。';
COMMENT ON COLUMN upload_attempts.expires_at IS
  '進行中leaseの失効時刻。異常終了時に同時実行枠を永久に占有させないための時限解放(設計 §6.1)。';
COMMENT ON COLUMN upload_attempts.finished_at IS
  '明示的な解放時刻。NULLかつexpires_atが未来の行だけを「進行中」として数える。';

-- 頻度判定: 直近1分の試行を利用者別に数える(設計 §6.1)。
CREATE INDEX upload_attempts_owner_started_at_idx
  ON upload_attempts (owner_subject_id, started_at DESC);

-- 同時実行判定: 未解放の試行だけを利用者別に数える(設計 §6.1)。
CREATE INDEX upload_attempts_owner_in_progress_idx
  ON upload_attempts (owner_subject_id, expires_at)
  WHERE finished_at IS NULL;

-- runtime用DB roleの最小権限(設計 §7.4)。既存テーブルと同じく、存在する場合だけGRANTする。
-- INSERT(試行の記録)とUPDATE(解放)だけを与え、DELETEは与えない。古い行のpurgeは
-- 監査履歴と同様にMaintenance Job側の運用作業とする(設計 §7.7)。
DO $$
DECLARE
  runtime_role_name CONSTANT text := 'siryou_mite_runtime';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role_name) THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON upload_attempts FROM %I', runtime_role_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON upload_attempts TO %I', runtime_role_name);
  ELSE
    RAISE NOTICE
      'role "%" does not exist; skipping GRANT (expected in local/dev/CI environments)',
      runtime_role_name;
  END IF;
END
$$;
