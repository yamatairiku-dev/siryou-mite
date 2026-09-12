-- Up Migration
--
-- 設計: docs/APPLICATION_DESIGN.md §6.1(容量上限), §10.1(3)(システム全体のupload判定は直列化する)
--
-- forward-only: このファイルへ "-- Down Migration" セクションは書かない。
--
-- 上限判定(reserve)と資料登録(documents INSERT)は別トランザクションで、その間に
-- advisory lockは解放される(設計 §10.1の手順: 判定 → HTML検査 → Blob保存 → DB登録)。
-- そのため`documents`だけを集計すると、「判定は通ったがまだ登録されていないbyte数」が
-- どの判定からも見えず、並行アップロードでシステム全体50GB・利用者500MBを超過できる。
-- 進行中の試行に予約byte数を持たせ、判定時に加算することで、判定の直列化を実効化する。
--
-- byte数は`documents.byte_size`として既に保存している値と同じ種類の情報であり、
-- 個人データ・業務内容ではない(設計 §12.2の非記録項目に該当しない)。
--
-- 新旧アプリ互換(設計 §7.4): NOT NULL DEFAULT 0 とするため、この列を知らない
-- 旧versionのアプリがINSERTしても失敗しない(予約byteが0として扱われるだけ)。
ALTER TABLE upload_attempts
  ADD COLUMN byte_size BIGINT NOT NULL DEFAULT 0;

ALTER TABLE upload_attempts
  ADD CONSTRAINT upload_attempts_byte_size_check CHECK (byte_size >= 0);

COMMENT ON COLUMN upload_attempts.byte_size IS
  '進行中のアップロードが使う予定のHTML byte数。容量上限の判定へ加算する(設計 §6.1)。';

-- システム全体の予約byte数を、進行中の行だけで集計するための部分index。
CREATE INDEX upload_attempts_in_progress_byte_size_idx
  ON upload_attempts (expires_at) INCLUDE (byte_size)
  WHERE finished_at IS NULL;

-- 件数・容量の集計(設計 §6.1)は常に status = 'active' だけを対象にする。
-- システムロックを保持している間の集計を短くするため、有効な資料だけの部分indexを
-- 追加する(利用者別の集計にも同じindexを使える)。
CREATE INDEX documents_active_owner_byte_size_idx
  ON documents (owner_subject_id) INCLUDE (byte_size)
  WHERE status = 'active';
