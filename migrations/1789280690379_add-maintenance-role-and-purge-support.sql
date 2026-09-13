-- Up Migration
--
-- 設計: docs/APPLICATION_DESIGN.md §7.7(定期保守Job), §16(保持期間1年と自動削除),
--       §7.4(DB roleは用途別に最小権限), §12.2(監査は追記専用)
--
-- forward-only: このファイルへ "-- Down Migration" セクションは書かない。
--
-- T19(定期保守Job)が行う4つの処理のうち、3つがDELETEを必要とする。
--
--   1. `blob_cleanup_pending`の再試行(UPDATEのみ。既存権限で足りる)
--   2. 1年経過した監査履歴と削除済み資料メタデータのpurge(DELETE)
--   3. 孤児Blobの掃除(DBはSELECTのみ)
--   4. `upload_attempts`の古い行のpurge(DELETE。Q-011)
--
-- 監査の追記専用性(設計 §12.2)は「通常のアプリ操作から更新・削除できない」ことであり、
-- 設計 §16が要求する1年経過後の自動削除とは両立させる必要がある。そこで:
--
--   - Web・Display・Previewが使うruntime role(`siryou_mite_runtime`)には、
--     これまでどおり`audit_events`へDELETEを**与えない**(既存GRANTは変更しない)。
--   - 保守Job専用のrole(`siryou_mite_maintenance`)を別に用意し、こちらにだけ
--     purgeに必要なDELETEを与える。
--   - `audit_events`の`BEFORE UPDATE OR DELETE` triggerは残したまま、
--     「保持期間(retain_until)を過ぎた行の、保守role(またはテーブル所有者)による
--     DELETE」だけを通すように条件を足す。UPDATEは誰に対しても引き続き禁止する。
--
-- テーブル所有者を許可対象に含めるのは、所有者は`ALTER TABLE ... DISABLE TRIGGER`で
-- triggerそのものを無効化できるため、この分岐があってもなくても実効的な強度が
-- 変わらないから(migration/結合テストは所有者で実行される)。保持期間前の行は
-- 所有者であってもtrigger経由では削除できない。

-- --- 保守role用のGRANT(設計 §7.4) ---------------------------------------------
--
-- 既存migrationと同じく、role自体の作成とManaged Identityとの対応付けはIaC(Bicep)側の
-- 範囲とし、ここではroleが存在する場合にだけGRANTする(ローカル・CIでは何もしない)。
DO $$
DECLARE
  maintenance_role_name CONSTANT text := 'siryou_mite_maintenance';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = maintenance_role_name) THEN
    -- documents: Blob削除完了の反映(UPDATE)と1年経過後のpurge(DELETE)。
    EXECUTE format('REVOKE ALL PRIVILEGES ON documents FROM %I', maintenance_role_name);
    EXECUTE format('GRANT SELECT, UPDATE, DELETE ON documents TO %I', maintenance_role_name);

    -- audit_events: 保持期間経過分のpurge(DELETE)だけ。INSERT・UPDATEは与えない
    -- (保守Jobは監査を書かない。書けないことをrole権限でも担保する)。
    EXECUTE format('REVOKE ALL PRIVILEGES ON audit_events FROM %I', maintenance_role_name);
    EXECUTE format('GRANT SELECT, DELETE ON audit_events TO %I', maintenance_role_name);

    -- upload_attempts: 古い行のpurge(Q-011)。
    EXECUTE format('REVOKE ALL PRIVILEGES ON upload_attempts FROM %I', maintenance_role_name);
    EXECUTE format('GRANT SELECT, DELETE ON upload_attempts TO %I', maintenance_role_name);
  ELSE
    RAISE NOTICE
      'role "%" does not exist; skipping GRANT (expected in local/dev/CI environments; provision the role via infrastructure before relying on it in production)',
      maintenance_role_name;
  END IF;
END
$$;

-- --- 監査の追記専用triggerを「保持期間経過分のpurgeだけ許す」形へ更新 -----------
--
-- 関数名・trigger名は変えない(CREATE OR REPLACEで本体だけ差し替える)。
--
-- `search_path`は`pg_catalog, pg_temp`へ固定する。この関数は`pg_class`・`pg_roles`という
-- リレーションを参照するため、固定しないと呼び出し側の`search_path`(たとえば`pg_temp`)に
-- 同名のリレーションを置かれて判定を欺かれ得る。`pg_temp`を末尾に置くのは、省略すると
-- PostgreSQLが暗黙に先頭へ付けてしまうため(定石)。
CREATE OR REPLACE FUNCTION audit_events_prevent_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  maintenance_role_name CONSTANT text := 'siryou_mite_maintenance';
  table_owner text;
BEGIN
  -- UPDATEは誰にも許さない(設計 §12.2「通常のアプリ操作から更新・削除できない」)。
  IF TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP;
  END IF;

  -- 保持期間(occurred_at + 1年、設計 §16)を過ぎた行だけをpurgeできる。
  IF OLD.retain_until > pg_catalog.now() THEN
    RAISE EXCEPTION
      'audit_events is append-only: DELETE is only allowed after retain_until';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO table_owner
    FROM pg_catalog.pg_class AS c
   WHERE c.oid = TG_RELID;

  IF pg_catalog.pg_has_role(current_user, table_owner, 'MEMBER') THEN
    RETURN OLD;
  END IF;

  -- roleの存在確認と`pg_has_role`はIFをネストして評価順を明示する。
  -- PostgreSQLは`AND`の短絡評価を保証しないため、1つのIFにまとめると
  -- role未作成の環境(ローカル・CI)で`role "..." does not exist`という
  -- 分かりにくい例外になり得る。
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = maintenance_role_name) THEN
    IF pg_catalog.pg_has_role(current_user, maintenance_role_name, 'MEMBER') THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION
    'audit_events is append-only: DELETE is only allowed for the maintenance role';
END;
$$;

COMMENT ON FUNCTION audit_events_prevent_mutation() IS
  '監査の追記専用性を保つtrigger関数。UPDATEは常に拒否し、DELETEは保持期間'
  '(retain_until)経過後かつ保守role(またはテーブル所有者)からのものだけ許可する'
  '(設計 §12.2, §16, §7.7)。';

-- --- 保守Jobのバッチ処理を支えるindex -----------------------------------------
--
-- Blob削除の再試行対象(`blob_cleanup_pending = true`)は通常ごく少数のため部分indexに
-- する。保守Jobは`(deleted_at, id)`のkeyset順に取り出し、失敗した資料で無限ループ
-- しないよう次のバッチへ進む。
CREATE INDEX documents_blob_cleanup_pending_idx
  ON documents (deleted_at, id)
  WHERE blob_cleanup_pending;

-- 1年経過した削除済み資料の抽出(status = 'deleted'の行だけを対象にする)。
CREATE INDEX documents_deleted_at_idx
  ON documents (deleted_at)
  WHERE status = 'deleted';

-- `upload_attempts`の古い行の抽出。既存のindexは`finished_at IS NULL`の部分indexで、
-- 解放済みの行を含まないためpurgeには使えない。
CREATE INDEX upload_attempts_expires_at_idx
  ON upload_attempts (expires_at);
