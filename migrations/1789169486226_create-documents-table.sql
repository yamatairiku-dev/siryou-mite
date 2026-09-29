-- Up Migration
--
-- 設計: docs/APPLICATION_DESIGN.md §11(状態モデル), §12.1(documents)
--
-- forward-only: このファイルへ "-- Down Migration" セクションは書かない
-- (node-pg-migrateはセクションが無いmigrationを`down`実行不可として扱う。
-- 破壊的変更は新しいmigrationファイルを追加して段階的に行う)。

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Entra IDの内部識別子(oid)。owner判定に使用し、削除後も消去しない。
  owner_subject_id TEXT NOT NULL,
  -- 以下6項目は削除時に消去する機微・表示用項目(設計 §12.1)。
  owner_email_at_upload TEXT,
  original_file_name TEXT,
  title TEXT,
  byte_size BIGINT,
  preview_status TEXT,
  warning_codes TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by_subject_id TEXT,
  blob_cleanup_pending BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT documents_status_check
    CHECK (status IN ('active', 'deleted')),
  CONSTRAINT documents_preview_status_check
    CHECK (preview_status IS NULL OR preview_status IN ('pending', 'ready', 'failed')),
  CONSTRAINT documents_byte_size_check
    CHECK (byte_size IS NULL OR byte_size >= 0),
  -- 資料状態モデル(設計 §11.1): deleted_atはstatus='deleted'のときだけ設定される。
  CONSTRAINT documents_deleted_consistency_check
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

COMMENT ON TABLE documents IS
  '資料メタデータ。HTML本文とプレビュー画像はBlobへ保存し、このテーブルへは保存しない(設計 §7.4)。';
COMMENT ON COLUMN documents.owner_email_at_upload IS '削除時にNULLへ消去する(設計 §12.1)。';
COMMENT ON COLUMN documents.original_file_name IS '削除時にNULLへ消去する(設計 §12.1)。';
COMMENT ON COLUMN documents.title IS '削除時にNULLへ消去する(設計 §12.1)。';
COMMENT ON COLUMN documents.byte_size IS '削除時にNULLへ消去する(設計 §12.1)。';
COMMENT ON COLUMN documents.preview_status IS '削除時にNULLへ消去する(設計 §12.1)。';
COMMENT ON COLUMN documents.warning_codes IS '削除時にNULLへ消去する(設計 §12.1)。';

-- 初期画面: 所有者別に新しい順で一覧表示するためのindex(設計 §5.2)。
CREATE INDEX documents_owner_created_at_idx
  ON documents (owner_subject_id, created_at DESC);

-- 管理画面: アップロード日時での検索・並び替え(設計 §5.6)。
CREATE INDEX documents_created_at_idx
  ON documents (created_at DESC);

-- 管理画面: オーナーのメールアドレスでの検索(設計 §5.6)。
-- アップロード時点の値であり削除後はNULLになる(削除済み資料はメールで検索できない)。
CREATE INDEX documents_owner_email_at_upload_idx
  ON documents (owner_email_at_upload);

-- 管理画面: 元ファイル名での検索(設計 §5.6)。
CREATE INDEX documents_original_file_name_idx
  ON documents (original_file_name);
