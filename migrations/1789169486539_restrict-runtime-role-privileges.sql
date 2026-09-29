-- Up Migration
--
-- 設計: docs/APPLICATION_DESIGN.md §7.4(DB roleは用途別に最小権限)、§12.2(監査は追記専用)
--
-- forward-only: このファイルへ "-- Down Migration" セクションは書かない。
--
-- runtime用DB role(Web・Display・Preview。Managed IdentityのEntra ID access tokenで
-- 接続する想定、設計 §7.4)には、documentsへSELECT/INSERT/UPDATEだけ、
-- audit_eventsへSELECT/INSERTだけを与える。DELETE、およびaudit_eventsへのUPDATEは
-- 与えない(削除はdocuments.statusの更新で表現するsoft deleteのため、documentsにも
-- DELETEは与えない)。
--
-- 用途別Managed Identityごとに個別のDB roleを分けるIaC(Bicep)側の設計はこの
-- migrationの範囲外(T03はDB schemaのみを担当する)。ここでは1つの代表roleへの
-- GRANTだけを用意し、実際のrole作成・Managed Identityとの対応付けはインフラ側の
-- 別タスクに委ねる。ロールが存在しない環境(ローカル開発・CIなど)でこのmigrationが
-- 失敗しないよう、GRANT前にpg_rolesで存在確認する。
DO $$
DECLARE
  runtime_role_name CONSTANT text := 'siryou_mite_runtime';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role_name) THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON documents FROM %I', runtime_role_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON documents TO %I', runtime_role_name);

    EXECUTE format('REVOKE ALL PRIVILEGES ON audit_events FROM %I', runtime_role_name);
    EXECUTE format('GRANT SELECT, INSERT ON audit_events TO %I', runtime_role_name);
  ELSE
    RAISE NOTICE
      'role "%" does not exist; skipping GRANT (expected in local/dev/CI environments; provision the role via infrastructure before relying on it in production)',
      runtime_role_name;
  END IF;
END
$$;
