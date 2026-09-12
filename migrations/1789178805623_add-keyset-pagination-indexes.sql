-- Up Migration
--
-- 設計: docs/APPLICATION_DESIGN.md §5.2(所有者別一覧), §5.7(監査履歴検索), §18.1(cursor pagination)
--
-- forward-only: このファイルへ "-- Down Migration" セクションは書かない。
--
-- cursor pagination(keyset方式)は、同一時刻の行でも重複・欠落しないよう
-- `(created_at DESC, id DESC)`、`(occurred_at DESC, id DESC)`で並べ、
-- 行値比較`(created_at, id) < ($1, $2)`で続きを取得する(T04 repository層)。
-- 既存indexは並び替えのタイブレーカである`id DESC`を含まないため、
-- ソート列を追加したindexを新しく作り、前方一致で完全に代替される
-- 既存indexを削除する(書き込みコストを増やさないため)。
-- 既存migrationファイルは書き換えず、この新しいmigrationだけで前進させる。

-- documents: 所有者別の新しい順一覧(設計 §5.2)。
CREATE INDEX documents_owner_created_at_id_idx
  ON documents (owner_subject_id, created_at DESC, id DESC);

DROP INDEX documents_owner_created_at_idx;

-- audit_events: 監査履歴の新しい順一覧(設計 §5.7)。
CREATE INDEX audit_events_occurred_at_id_idx
  ON audit_events (occurred_at DESC, id DESC);

DROP INDEX audit_events_occurred_at_idx;
