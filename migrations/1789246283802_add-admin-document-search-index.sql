-- Up Migration
--
-- 設計: docs/APPLICATION_DESIGN.md §5.6(管理画面の全資料検索), §18.1(cursor pagination)
--
-- forward-only: このファイルへ "-- Down Migration" セクションは書かない。
--
-- 管理画面(`/admin/documents`)は所有者で絞らずに全資料を`(created_at DESC, id DESC)`
-- で並べ、行値比較`(created_at, id) < ($1, $2)`で続きを取得する(T16 repository層)。
-- 既存の`documents_created_at_idx`は並び替えのタイブレーカである`id DESC`を含まず、
-- この行値比較をそのままindexで辿れない。所有者別一覧で同じ理由から
-- `documents_owner_created_at_id_idx`を作った1789178805623のmigrationと同じ方針で、
-- ソート列を追加したindexを作り、前方一致で完全に代替される既存indexを削除する
-- (書き込みコストを増やさないため)。
--
-- runtime roleへの新しい権限付与は不要(既存のSELECT権限のまま使える)。

CREATE INDEX documents_created_at_id_idx
  ON documents (created_at DESC, id DESC);

DROP INDEX documents_created_at_idx;
