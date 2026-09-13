/**
 * 初期画面(`/app`)からのアップロードE2Eヘルパー(設計 §5.2, §5.3, §10.1, §13)。
 *
 * 実際のUI操作(ファイル選択input)を経由して`POST /documents`を発生させ、
 * その応答をそのまま返す。アプリ側にテスト専用の分岐は追加しない。
 */
import type { Page } from "@playwright/test";

export type UploadWarning = { code: string; message: string };
export type UploadRejection = { code: string; message: string };

export type UploadSuccessBody = {
  documentId: string;
  documentUrl: string;
  previewStatus: string;
  warnings: UploadWarning[];
  correlationId: string;
};

export type UploadErrorBody = {
  message: string;
  correlationId: string | null;
  rejections?: UploadRejection[];
};

export type UploadResult =
  | { ok: true; status: number; body: UploadSuccessBody }
  | { ok: false; status: number; body: UploadErrorBody };

/**
 * `/app`を表示済みの`page`に対し、ファイル選択inputへHTMLを渡して
 * `POST /documents`の応答を読み取る。
 */
export async function uploadHtmlViaUi(
  page: Page,
  fileName: string,
  html: string,
): Promise<UploadResult> {
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/documents" &&
      response.request().method() === "POST",
  );

  await page.getByLabel("アップロードするファイル").setInputFiles({
    name: fileName,
    mimeType: "text/html",
    buffer: Buffer.from(html, "utf8"),
  });

  const response = await responsePromise;
  const status = response.status();
  const body = (await response.json()) as UploadSuccessBody | UploadErrorBody;

  return response.ok()
    ? { ok: true, status, body: body as UploadSuccessBody }
    : { ok: false, status, body: body as UploadErrorBody };
}

/** 資料表示画面のDisplay iframe(設計 §5.4、`app/routes/documents.$documentId.tsx`)。 */
export function displayFrameLocator(page: Page, documentId: string) {
  return page.frameLocator(`iframe[name="document-display-${documentId}"]`);
}
