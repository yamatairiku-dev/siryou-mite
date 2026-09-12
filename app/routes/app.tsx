/**
 * 初期画面(設計 §5.2, §5.3, §13の`/app`)。
 *
 * loaderはログイン済み利用者自身の資料だけを新しい順に取得する
 * (`listDocumentsByOwner`が`owner_subject_id`で必ず絞り込むため、他人の資料は
 * 混ざらない)。アップロードは`POST /documents`(T09)へブラウザから直接送り、
 * 成功後は資料表示画面(`documentUrl`、T13で実装予定)への導線を表示する。
 */
import { useEffect, useRef, useState } from "react";
import { Form, useFetcher, useRevalidator } from "react-router";
import type { Route } from "./+types/app";
import { isDocumentOwner } from "~/lib/auth/authorization.server";
import {
  InvalidCursorError,
  listDocumentsByOwner,
  type DocumentRecord,
  type PreviewStatus,
} from "~/lib/db/documents.server";
import {
  formatByteSize,
  formatJstDateTime,
  formatPreviewStatus,
  previewImageSrc,
} from "~/lib/format/document-view";
import { requireUser, type AppUser } from "~/lib/session.server";
import { encodeFileNameHeader } from "~/lib/upload/file-name-header";
import type {
  UploadErrorBody,
  UploadSuccessBody,
} from "~/lib/upload/upload.server";

/** カード表示に必要な項目だけを抜き出したDTO(設計 §5.2)。 */
export type DocumentCard = {
  id: string;
  title: string;
  originalFileName: string;
  byteSize: number | null;
  previewStatus: PreviewStatus | null;
  createdAt: Date;
  /** オーナー本人だけに削除操作を表示する(設計 §5.2、AGENTS.md 5項)。 */
  canDelete: boolean;
};

export type AppLoaderData = {
  user: Pick<AppUser, "name" | "email">;
  page: { documents: DocumentCard[]; nextCursor: string | null };
};

function toDocumentCard(user: AppUser, document: DocumentRecord): DocumentCard {
  return {
    id: document.id,
    title: document.title ?? document.originalFileName ?? "(タイトル不明)",
    originalFileName: document.originalFileName ?? "(不明なファイル名)",
    byteSize: document.byteSize,
    previewStatus: document.previewStatus,
    createdAt: document.createdAt,
    // このrouteは`owner_subject_id`で絞り込んだ一覧しか扱わないため常にtrueになる
    // はずだが、削除操作の表示可否は認可ヘルパーで明示的に判定する(UIの非表示を
    // 認可として扱わない、設計 §4.2)。
    canDelete: isDocumentOwner(user, document),
  };
}

export async function loader({ request }: Route.LoaderArgs): Promise<AppLoaderData> {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");

  let page;
  try {
    // 所有者条件(`ownerSubjectId: user.id`)はサーバー側のこの呼び出しでだけ決まり、
    // 利用者からの入力では変更できない(他人の資料が混ざらないための唯一の条件)。
    page = await listDocumentsByOwner({ ownerSubjectId: user.id, cursor });
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw new Response(error.message, { status: 400 });
    }
    throw error;
  }

  return {
    user: { name: user.name, email: user.email },
    page: {
      documents: page.documents.map((document) => toDocumentCard(user, document)),
      nextCursor: page.nextCursor,
    },
  };
}

export const meta: Route.MetaFunction = () => [{ title: "資料みて！" }];

type UploadUiState =
  | { status: "idle" }
  | { status: "uploading" }
  | { status: "success"; result: UploadSuccessBody }
  | {
      status: "error";
      message: string;
      correlationId: string | null;
      rejections?: UploadErrorBody["rejections"];
    };

export default function Application({ loaderData }: Route.ComponentProps) {
  const revalidator = useRevalidator();
  const loadMoreFetcher = useFetcher<AppLoaderData>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [documents, setDocuments] = useState(loaderData.page.documents);
  const [nextCursor, setNextCursor] = useState(loaderData.page.nextCursor);
  const [uploadState, setUploadState] = useState<UploadUiState>({ status: "idle" });
  const [selectError, setSelectError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // アップロード後のrevalidateなどでloaderの一覧(先頭ページ)が更新されたら、
  // 「次を表示」で追加取得した分をリセットして先頭から表示し直す。
  useEffect(() => {
    setDocuments(loaderData.page.documents);
    setNextCursor(loaderData.page.nextCursor);
  }, [loaderData.page]);

  useEffect(() => {
    if (loadMoreFetcher.state === "idle" && loadMoreFetcher.data) {
      const nextPage = loadMoreFetcher.data.page;
      setDocuments((prev) => [...prev, ...nextPage.documents]);
      setNextCursor(nextPage.nextCursor);
    }
    // loadMoreFetcher.dataは新しく取得するたびに新しい参照になるため、
    // 取得のたびに1回だけ追記される。
    // eslint系のexhaustive-depsは未使用のためコメントで意図を残す。
  }, [loadMoreFetcher.data, loadMoreFetcher.state]);

  function handleFiles(files: FileList | null): void {
    setSelectError(null);
    if (!files || files.length === 0) {
      return;
    }
    // 設計 §5.2「1回につき1ファイルだけ受け付ける」。
    if (files.length > 1) {
      setSelectError("一度にアップロードできるファイルは1つだけです。");
      return;
    }
    const file = files[0];
    if (file) {
      void uploadFile(file);
    }
  }

  async function uploadFile(file: File): Promise<void> {
    setUploadState({ status: "uploading" });
    try {
      const response = await fetch("/documents", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeFileNameHeader(file.name),
        },
        body: file,
      });
      const body: unknown = await response.json();
      if (response.ok) {
        setUploadState({ status: "success", result: body as UploadSuccessBody });
        // 新しい資料をカード一覧へ反映する(先頭ページを取り直す)。
        revalidator.revalidate();
      } else {
        const errorBody = body as UploadErrorBody;
        setUploadState({
          status: "error",
          message: errorBody.message,
          correlationId: errorBody.correlationId ?? null,
          rejections: errorBody.rejections,
        });
      }
    } catch {
      // 相関IDはサーバーが発行するため、通信自体が失敗した場合は持たない(設計 §14)。
      setUploadState({
        status: "error",
        message: "アップロードに失敗しました。時間をおいてやり直してください。",
        correlationId: null,
      });
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setIsDragOver(false);
    handleFiles(event.dataTransfer.files);
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave(): void {
    setIsDragOver(false);
  }

  async function copyDocumentUrl(documentId: string): Promise<void> {
    const url = `${window.location.origin}/documents/${documentId}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // clipboard APIが使えない環境では黙って諦める(業務結果に影響しない)。
    }
  }

  const isUploading = uploadState.status === "uploading";

  return (
    <section>
      <p className="eyebrow">資料みて！</p>
      <h1>資料一覧</h1>
      <p className="lead">
        {loaderData.user.name}さん（{loaderData.user.email}）
      </p>

      <section className="upload-panel card">
        <h2>資料をアップロード</h2>
        <div
          className={isDragOver ? "dropzone dropzone-active" : "dropzone"}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          data-testid="dropzone"
        >
          <p>ここにHTMLファイルをドラッグ＆ドロップ</p>
          <button
            type="button"
            className="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            ファイルを選択
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".html,.htm"
            className="visually-hidden"
            aria-label="アップロードするファイル"
            onChange={(event) => handleFiles(event.target.files)}
          />
        </div>

        {isUploading && <p role="status">アップロード中です…</p>}

        {selectError && (
          <p className="notice" role="alert">
            {selectError}
          </p>
        )}

        {uploadState.status === "success" && (
          <div className="notice" role="status">
            <p>アップロードが完了しました。</p>
            {uploadState.result.warnings.length > 0 && (
              <ul>
                {uploadState.result.warnings.map((warning) => (
                  <li key={warning.code}>{warning.message}</li>
                ))}
              </ul>
            )}
            <p>
              <a className="button" href={uploadState.result.documentUrl}>
                資料を開く
              </a>
            </p>
          </div>
        )}

        {uploadState.status === "error" && (
          <div className="notice" role="alert">
            <p>{uploadState.message}</p>
            {uploadState.rejections && uploadState.rejections.length > 0 && (
              <ul>
                {uploadState.rejections.map((rejection) => (
                  <li key={rejection.code}>{rejection.message}</li>
                ))}
              </ul>
            )}
            {uploadState.correlationId && (
              <p className="correlation-id">相関ID: {uploadState.correlationId}</p>
            )}
          </div>
        )}
      </section>

      <ul className="document-list grid">
        {documents.length === 0 && (
          <p>まだ資料がありません。ファイルをアップロードしてください。</p>
        )}
        {documents.map((document) => (
          <li key={document.id} className="card document-card">
            <img
              src={previewImageSrc(document.previewStatus)}
              alt={`${document.title}のプレビュー`}
              className="document-card-preview"
            />
            <h2>{document.title}</h2>
            <dl>
              <dt>元ファイル名</dt>
              <dd>{document.originalFileName}</dd>
              <dt>アップロード日時</dt>
              <dd>{formatJstDateTime(document.createdAt)}</dd>
              <dt>ファイルサイズ</dt>
              <dd>{formatByteSize(document.byteSize)}</dd>
              <dt>プレビュー状態</dt>
              <dd>{formatPreviewStatus(document.previewStatus)}</dd>
            </dl>
            <div className="document-card-actions">
              <a className="button" href={`/documents/${document.id}`}>
                資料を開く
              </a>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void copyDocumentUrl(document.id)}
              >
                URLをコピー
              </button>
              {document.canDelete && (
                <Form method="post" action={`/documents/${document.id}/delete`}>
                  <button type="submit" className="button button-secondary">
                    削除
                  </button>
                </Form>
              )}
            </div>
          </li>
        ))}
      </ul>

      {nextCursor && (
        <button
          type="button"
          className="button button-secondary"
          disabled={loadMoreFetcher.state !== "idle"}
          onClick={() =>
            loadMoreFetcher.load(`/app?cursor=${encodeURIComponent(nextCursor)}`)
          }
        >
          次を表示
        </button>
      )}
    </section>
  );
}
