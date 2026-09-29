/**
 * Blob Storage / Storage Queueクライアント(設計 §7.3, §7.5)。
 *
 * `services/` 配下は `app/` を一切importしない方針(docs/ARCHITECTURE.md, T04 Q-005)
 * だが、逆方向(`app/` → `services/shared/`)の依存はこの制約に反しない。Blob/Queue
 * 操作は複数実行単位(Web・Display・Preview・Maintenance)で共有される実処理であり、
 * 環境変数検証(`services/shared/env.ts`)のように重複させるとAzure SDK呼び出しが
 * 分岐して食い違うリスクが大きいため、実装はここへ集約する。Web側は
 * `app/lib/storage.server.ts`から本モジュールを再importする薄いラッパーにする。
 *
 * - Blobキーは資料IDから決定的に導出し、DBへ保存しない(設計 §7.3)。
 * - すべてのBlob/Queue操作へ明示的なtimeout(`abortSignal`)を設定する。
 * - HTML保存時の`Content-Type`は固定値を使い、利用者由来の値をヘッダーへ使わない。
 * - Blob削除・Queueメッセージ削除は対象が既に存在しなくても失敗しない(冪等)。
 * - Queueメッセージは`schemaVersion`と`documentId`だけを含む(設計 §7.5)。
 */
import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobServiceClient,
  newPipeline as newBlobPipeline,
  type ContainerClient,
  type RequestPolicy,
  type RequestPolicyFactory,
  type RequestPolicyOptions,
  type WebResource,
} from "@azure/storage-blob";
import {
  QueueServiceClient,
  RestError,
  newPipeline as newQueuePipeline,
  type QueueClient,
} from "@azure/storage-queue";
import { z } from "zod";

/**
 * Azure Storage REST APIのバージョン(`x-ms-version`ヘッダー)。
 *
 * Azure SDKの既定値はSDKのバージョンに追随して自動的に最新化されるため、
 * Azurite(ローカル)が未対応の新しいバージョンを急に要求してしまうことがある
 * (devcontainerのAzurite 3.36.0はBlob/Queueとも`2025-11-05`までに対応)。
 * ここで明示的に固定し、SDK更新でローカル結合テストが壊れないようにする。
 * 本番のAzure Storageも過去のAPIバージョンを長期間サポートするため、固定は
 * 本番側の動作にも問題ない。
 *
 * `BlobServiceClientOptions`/`StoragePipelineOptions`にはAPIバージョンを指定できる
 * 公開フィールドが無い(`Pipeline.d.ts`の`StoragePipelineOptions`に`version`は無い)。
 * 生成コード(`generated/src/operations/*`)の`x-ms-version`ヘッダーは
 * `isConstant: true`のパラメータとしてSDKバージョンごとの固定値が埋め込まれており、
 * 公開オプション経由では変更できない(Azure SDKの既知の制約)。そのため、
 * pipelineのpolicyとして送信直前のリクエストヘッダーを直接上書きすることで固定する。
 */
export const AZURE_STORAGE_API_VERSION = "2025-11-05";

/**
 * `x-ms-version`ヘッダーを`AZURE_STORAGE_API_VERSION`へ固定するpolicy factory。
 *
 * Blob/Queue双方のSDKが`@azure/core-http-compat`の同一の`RequestPolicyFactory`/
 * `RequestPolicy`/`RequestPolicyOptions`/`WebResource`型をそのまま再exportしている
 * ため、Blob側の型で1つ作れば両方のpipelineへ使い回せる。
 *
 * `BlobServiceClient.getContainerClient`等の派生clientはこのpipelineインスタンスを
 * そのまま使い回す実装のため、`additionalPolicies`(`position: "perCall"`)方式のように
 * 派生clientを作るたびにcore pipelineへ重複登録される問題は起きない。
 */
export function createApiVersionPolicyFactory(): RequestPolicyFactory {
  return {
    create(nextPolicy: RequestPolicy, _options: RequestPolicyOptions): RequestPolicy {
      return {
        sendRequest(request: WebResource) {
          request.headers.set("x-ms-version", AZURE_STORAGE_API_VERSION);
          return nextPolicy.sendRequest(request);
        },
      };
    },
  };
}

/**
 * Blob/Queue操作すべてに設定する既定timeout(ms)。
 * T05完了条件「timeoutを設定している」を満たすため、呼び出し側が省略しても
 * 必ず`abortSignal`付きでSDKを呼ぶ。
 */
export const DEFAULT_STORAGE_OPERATION_TIMEOUT_MS = 10_000;

/** Queueメッセージのvisibility timeout既定値(設計 §7.5、秒)。 */
export const DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SECONDS = 60;

export interface StorageOperationOptions {
  /** 省略時は`DEFAULT_STORAGE_OPERATION_TIMEOUT_MS`。 */
  timeoutMs?: number;
  /**
   * 呼び出し側の中断signal(任意)。操作単位のtimeoutと**両方**が有効になり、
   * どちらかが中断すればSDK呼び出しを中止する。Preview Jobのように1処理全体の
   * 上限(設計 §7.5)を持つ呼び出し側が、期限超過後に外部書き込みを続けないために使う。
   */
  abortSignal?: AbortSignal;
}

function abortSignalFor(options?: StorageOperationOptions): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(
    options?.timeoutMs ?? DEFAULT_STORAGE_OPERATION_TIMEOUT_MS,
  );

  // 呼び出し側signalが無い場合はtimeout signalをそのまま使う(既存の呼び出し側の
  // 挙動を変えない)。
  return options?.abortSignal
    ? AbortSignal.any([timeoutSignal, options.abortSignal])
    : timeoutSignal;
}

// --- 接続設定(設計 §7.3「サービス間はManaged Identityを使用する」) ---

export type StorageConnectionConfig =
  | { readonly kind: "connectionString"; readonly connectionString: string }
  | { readonly kind: "managedIdentity"; readonly accountName: string };

/**
 * ローカル・開発は接続文字列、本番はManaged Identity(account名)を使う。
 * どちらも無い場合は例外にする(fail closed)。値そのものは例外メッセージへ
 * 含めない(設計 §9.5)。呼び出し側(Web・各service)は自身のZod検証済み環境変数
 * (`AZURE_STORAGE_CONNECTION_STRING`/`AZURE_STORAGE_ACCOUNT_NAME`は排他)から
 * この関数を呼ぶ想定であり、本番で接続文字列を許可しない検証自体は
 * `validateStorageConfig`(env schema側)が既に行う。
 */
export function resolveStorageConnectionConfig(value: {
  AZURE_STORAGE_CONNECTION_STRING?: string | undefined;
  AZURE_STORAGE_ACCOUNT_NAME?: string | undefined;
}): StorageConnectionConfig {
  if (value.AZURE_STORAGE_CONNECTION_STRING) {
    return {
      kind: "connectionString",
      connectionString: value.AZURE_STORAGE_CONNECTION_STRING,
    };
  }

  if (value.AZURE_STORAGE_ACCOUNT_NAME) {
    return { kind: "managedIdentity", accountName: value.AZURE_STORAGE_ACCOUNT_NAME };
  }

  throw new Error(
    "Storage接続設定がありません(AZURE_STORAGE_CONNECTION_STRING または AZURE_STORAGE_ACCOUNT_NAME が必要です)",
  );
}

/** `newPipeline`が受け付ける資格情報の型(SDKが公開する型をそのまま再利用する)。 */
type BlobPipelineCredential = NonNullable<Parameters<typeof newBlobPipeline>[0]>;
type QueuePipelineCredential = NonNullable<Parameters<typeof newQueuePipeline>[0]>;

function resolveBlobConnectionBasics(
  config: StorageConnectionConfig,
): { url: string; credential: BlobPipelineCredential } {
  if (config.kind === "connectionString") {
    // 接続文字列の資格情報解析(shared key / SAS等)を自前で実装しないため、
    // 一度`fromConnectionString`でclientを作り、そこから`url`・`credential`だけを
    // 取り出してpolicy入りのpipelineで作り直す。
    const parsed = BlobServiceClient.fromConnectionString(config.connectionString);
    return { url: parsed.url, credential: parsed.credential };
  }

  return {
    url: `https://${config.accountName}.blob.core.windows.net`,
    credential: new DefaultAzureCredential(),
  };
}

function resolveQueueConnectionBasics(
  config: StorageConnectionConfig,
): { url: string; credential: QueuePipelineCredential } {
  if (config.kind === "connectionString") {
    // `QueueServiceClient`の`credential`はprotectedで外から読めないため、`url`だけ
    // ここから取り、`credential`(shared key等、`@azure/storage-common`が両SDK共通で
    // 使うクラス)は`BlobServiceClient`側(publicで読める)から取り出す。同じ
    // 接続文字列から作るため、Blob用・Queue用で資格情報の実体は同じになる。
    // (この使い回しは`@azure/storage-common`がBlob/Queue間で単一インストールに
    // dedupeされている前提に依存する。`npm ls @azure/storage-common`が1系統だけ
    // 表示されることを確認済み。多重インストールされると`instanceof`チェックで
    // 資格情報のpolicyが正しく組み立てられない可能性がある。)
    const queueParsed = QueueServiceClient.fromConnectionString(config.connectionString);
    const blobParsed = BlobServiceClient.fromConnectionString(config.connectionString);
    return { url: queueParsed.url, credential: blobParsed.credential };
  }

  return {
    url: `https://${config.accountName}.queue.core.windows.net`,
    credential: new DefaultAzureCredential(),
  };
}

export function createBlobServiceClient(
  config: StorageConnectionConfig,
): BlobServiceClient {
  const { url, credential } = resolveBlobConnectionBasics(config);
  const pipeline = newBlobPipeline(credential, {});
  pipeline.factories.push(createApiVersionPolicyFactory());
  return new BlobServiceClient(url, pipeline);
}

export function createQueueServiceClient(
  config: StorageConnectionConfig,
): QueueServiceClient {
  const { url, credential } = resolveQueueConnectionBasics(config);
  const pipeline = newQueuePipeline(credential, {});
  pipeline.factories.push(createApiVersionPolicyFactory());
  return new QueueServiceClient(url, pipeline);
}

export function getDocumentsContainerClient(
  blobServiceClient: BlobServiceClient,
  containerName: string,
): ContainerClient {
  return blobServiceClient.getContainerClient(containerName);
}

export function getPreviewQueueClient(
  queueServiceClient: QueueServiceClient,
  queueName: string,
): QueueClient {
  return queueServiceClient.getQueueClient(queueName);
}

// --- Blobキー導出(設計 §7.3) ---

/** 資料IDから決定的にBlobキーを導出する前提のUUID検証。パストラバーサル・
 * インジェクション対策として、`../`や`/`を含む値はここで拒否される
 * (`z.uuid()`は正規のUUID文字列だけを許可する)。 */
const documentIdSchema = z.uuid();

export class InvalidDocumentIdError extends Error {
  constructor() {
    super("資料IDの形式が不正です");
    this.name = "InvalidDocumentIdError";
  }
}

function assertDocumentId(documentId: string): string {
  const result = documentIdSchema.safeParse(documentId);
  if (!result.success) {
    throw new InvalidDocumentIdError();
  }
  return result.data;
}

/** 非公開HTMLのBlobキー(設計 §7.3)。DBへは保存しない。 */
export function documentHtmlBlobKey(documentId: string): string {
  return `html/${assertDocumentId(documentId)}/document.html`;
}

/** プレビュー画像のBlobキー(設計 §7.3)。DBへは保存しない。 */
export function documentPreviewBlobKey(documentId: string): string {
  return `preview/${assertDocumentId(documentId)}/preview.jpg`;
}

/** HTML保存時に固定で使う`Content-Type`。利用者由来の値は使わない。 */
export const HTML_BLOB_CONTENT_TYPE = "text/html; charset=utf-8";
/** プレビュー画像保存時に固定で使う`Content-Type`。 */
export const PREVIEW_BLOB_CONTENT_TYPE = "image/jpeg";

// --- Blob操作 ---

async function uploadBlob(
  containerClient: ContainerClient,
  blobKey: string,
  content: Buffer,
  contentType: string,
  options?: StorageOperationOptions,
): Promise<void> {
  const blockBlobClient = containerClient.getBlockBlobClient(blobKey);
  await blockBlobClient.uploadData(content, {
    abortSignal: abortSignalFor(options),
    blobHTTPHeaders: { blobContentType: contentType },
  });
}

async function streamToBuffer(
  readable: NodeJS.ReadableStream | undefined,
): Promise<Buffer> {
  if (!readable) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer),
    );
  }
  return Buffer.concat(chunks);
}

async function downloadBlob(
  containerClient: ContainerClient,
  blobKey: string,
  options?: StorageOperationOptions,
): Promise<Buffer> {
  const blobClient = containerClient.getBlobClient(blobKey);
  const response = await blobClient.download(undefined, undefined, {
    abortSignal: abortSignalFor(options),
  });
  return streamToBuffer(response.readableStreamBody);
}

async function deleteBlob(
  containerClient: ContainerClient,
  blobKey: string,
  options?: StorageOperationOptions,
): Promise<void> {
  const blobClient = containerClient.getBlobClient(blobKey);
  // 冪等: 既に存在しないBlobを削除しても失敗させない。
  await blobClient.deleteIfExists({ abortSignal: abortSignalFor(options) });
}

export async function uploadDocumentHtml(
  containerClient: ContainerClient,
  documentId: string,
  html: Buffer,
  options?: StorageOperationOptions,
): Promise<void> {
  await uploadBlob(
    containerClient,
    documentHtmlBlobKey(documentId),
    html,
    HTML_BLOB_CONTENT_TYPE,
    options,
  );
}

export async function downloadDocumentHtml(
  containerClient: ContainerClient,
  documentId: string,
  options?: StorageOperationOptions,
): Promise<Buffer> {
  return downloadBlob(containerClient, documentHtmlBlobKey(documentId), options);
}

export async function deleteDocumentHtml(
  containerClient: ContainerClient,
  documentId: string,
  options?: StorageOperationOptions,
): Promise<void> {
  await deleteBlob(containerClient, documentHtmlBlobKey(documentId), options);
}

export async function uploadDocumentPreview(
  containerClient: ContainerClient,
  documentId: string,
  jpeg: Buffer,
  options?: StorageOperationOptions,
): Promise<void> {
  await uploadBlob(
    containerClient,
    documentPreviewBlobKey(documentId),
    jpeg,
    PREVIEW_BLOB_CONTENT_TYPE,
    options,
  );
}

export async function downloadDocumentPreview(
  containerClient: ContainerClient,
  documentId: string,
  options?: StorageOperationOptions,
): Promise<Buffer> {
  return downloadBlob(
    containerClient,
    documentPreviewBlobKey(documentId),
    options,
  );
}

export async function deleteDocumentPreview(
  containerClient: ContainerClient,
  documentId: string,
  options?: StorageOperationOptions,
): Promise<void> {
  await deleteBlob(containerClient, documentPreviewBlobKey(documentId), options);
}

// --- 孤児Blobの掃除(設計 §7.7、T19) ---

/** 非公開HTMLのBlobキーの接頭辞(設計 §7.3)。 */
export const HTML_BLOB_KEY_PREFIX = "html/";
/** プレビュー画像のBlobキーの接頭辞(設計 §7.3)。 */
export const PREVIEW_BLOB_KEY_PREFIX = "preview/";

/** 資料Blobの種別。孤児Blobの削除はこの2種類だけを対象にする。 */
export type DocumentBlobKind = "html" | "preview";

export type ParsedDocumentBlobKey = {
  kind: DocumentBlobKind;
  documentId: string;
};

/**
 * Blobキーを資料IDへ逆引きする。`documentHtmlBlobKey`/`documentPreviewBlobKey`が
 * 生成する形と**完全に一致**する場合だけ資料IDを返し、それ以外(想定外のキー、
 * UUIDでない部分、余分なパス)は`null`を返す。
 *
 * 保守Job(設計 §7.7)の孤児Blob掃除は、この関数が資料IDを返したBlobだけを
 * 削除対象にする。キーを直接指定して削除する経路は用意しない(取り違えで
 * 無関係なBlobを消さないため)。
 */
export function parseDocumentBlobKey(
  blobKey: string,
): ParsedDocumentBlobKey | null {
  const kinds: Array<{
    kind: DocumentBlobKind;
    prefix: string;
    suffix: string;
    derive: (documentId: string) => string;
  }> = [
    {
      kind: "html",
      prefix: HTML_BLOB_KEY_PREFIX,
      suffix: "/document.html",
      derive: documentHtmlBlobKey,
    },
    {
      kind: "preview",
      prefix: PREVIEW_BLOB_KEY_PREFIX,
      suffix: "/preview.jpg",
      derive: documentPreviewBlobKey,
    },
  ];

  for (const candidate of kinds) {
    if (
      !blobKey.startsWith(candidate.prefix) ||
      !blobKey.endsWith(candidate.suffix)
    ) {
      continue;
    }

    const documentId = blobKey.slice(
      candidate.prefix.length,
      blobKey.length - candidate.suffix.length,
    );

    if (!documentIdSchema.safeParse(documentId).success) {
      return null;
    }

    // 大文字のUUIDはこのアプリが作らない形(`randomUUID`は小文字)。PostgreSQLの
    // `uuid`型は大文字小文字を区別しないのに対しBlobキーは区別するため、
    // 突き合わせが噛み合わない値は対象外にする(fail closed)。
    if (documentId !== documentId.toLowerCase()) {
      return null;
    }

    // 導出結果と突き合わせ、少しでも違う形のキーは対象外にする。
    if (candidate.derive(documentId) !== blobKey) {
      return null;
    }

    return { kind: candidate.kind, documentId };
  }

  return null;
}

/** 一覧で取得するBlobの最小情報。本文は読まない。 */
export type StoredBlobSummary = {
  key: string;
  /** Storageが返す最終更新日時。取得できない場合は`null`。 */
  lastModified: Date | null;
};

export type StoredBlobPage = {
  blobs: StoredBlobSummary[];
  /** 続きがある場合だけ文字列。無い場合は`null`。 */
  continuationToken: string | null;
};

export interface ListBlobsOptions extends StorageOperationOptions {
  /** 1ページの最大件数。メモリを使い切らないよう呼び出し側が必ず指定する。 */
  pageSize: number;
  /** 前ページの`continuationToken`。先頭から読む場合は省略する。 */
  continuationToken?: string | null;
}

/**
 * 接頭辞に一致するBlobを1ページ分だけ列挙する(設計 §7.7の孤児Blob掃除)。
 *
 * 全件をメモリへ読み込まないよう、`byPage`で1ページだけ取得して打ち切る。
 * 戻り値にBlob本文は含めない。
 */
export async function listBlobsByPrefix(
  containerClient: ContainerClient,
  prefix: string,
  options: ListBlobsOptions,
): Promise<StoredBlobPage> {
  const iterator = containerClient
    .listBlobsFlat({ prefix, abortSignal: abortSignalFor(options) })
    .byPage({
      maxPageSize: options.pageSize,
      ...(options.continuationToken
        ? { continuationToken: options.continuationToken }
        : {}),
    });

  const page = await iterator.next();
  if (page.done || !page.value) {
    return { blobs: [], continuationToken: null };
  }

  const blobs: StoredBlobSummary[] = page.value.segment.blobItems.map(
    (item) => ({
      key: item.name,
      lastModified: item.properties.lastModified ?? null,
    }),
  );

  return {
    blobs,
    continuationToken: page.value.continuationToken || null,
  };
}

// --- Storage Queue(設計 §7.5) ---

/** 現時点で発行するQueueメッセージのschema version。増分は後方非互換の変更時のみ。 */
export const PREVIEW_QUEUE_SCHEMA_VERSION = 1;

/**
 * プレビュー生成メッセージ(設計 §7.5「`schemaVersion`と`documentId`だけを含む」)。
 * `.strict()`で未知フィールドを拒否する。
 */
export const previewQueueMessageSchema = z
  .object({
    schemaVersion: z.literal(PREVIEW_QUEUE_SCHEMA_VERSION),
    documentId: z.uuid(),
  })
  .strict();

export type PreviewQueueMessage = z.infer<typeof previewQueueMessageSchema>;

export class InvalidQueueMessageError extends Error {
  constructor() {
    super("Queueメッセージの形式が不正です");
    this.name = "InvalidQueueMessageError";
  }
}

/**
 * メッセージ本文はStorage Queueの予約文字(XML)を避けるためbase64で送る
 * (Azure Storage Queueのbase64エンコード方針、公式クライアントの標準的な使い方)。
 */
export function encodePreviewQueueMessage(documentId: string): string {
  const message = previewQueueMessageSchema.parse({
    schemaVersion: PREVIEW_QUEUE_SCHEMA_VERSION,
    documentId,
  });
  return Buffer.from(JSON.stringify(message), "utf8").toString("base64");
}

/**
 * 受信したQueueメッセージ本文を検証する。未知フィールド・不正な`schemaVersion`・
 * 不正な`documentId`はすべて`InvalidQueueMessageError`として拒否する
 * (恒久失敗として扱えるよう、呼び出し側で分類できる専用の例外にする)。
 */
export function parsePreviewQueueMessage(messageText: string): PreviewQueueMessage {
  let decoded: string;
  try {
    decoded = Buffer.from(messageText, "base64").toString("utf8");
  } catch {
    throw new InvalidQueueMessageError();
  }

  let json: unknown;
  try {
    json = JSON.parse(decoded);
  } catch {
    throw new InvalidQueueMessageError();
  }

  const result = previewQueueMessageSchema.safeParse(json);
  if (!result.success) {
    throw new InvalidQueueMessageError();
  }
  return result.data;
}

export interface SendPreviewQueueMessageOptions extends StorageOperationOptions {
  /** メッセージのtime-to-live(秒)。既定はStorage Queueの既定値(7日)。 */
  messageTimeToLiveSeconds?: number;
}

export async function sendPreviewGenerationMessage(
  queueClient: QueueClient,
  documentId: string,
  options?: SendPreviewQueueMessageOptions,
): Promise<void> {
  const messageText = encodePreviewQueueMessage(documentId);
  await queueClient.sendMessage(messageText, {
    abortSignal: abortSignalFor(options),
    ...(options?.messageTimeToLiveSeconds !== undefined
      ? { messageTimeToLive: options.messageTimeToLiveSeconds }
      : {}),
  });
}

export interface ReceivePreviewQueueMessagesOptions extends StorageOperationOptions {
  /** 既定は`DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SECONDS`(設計 §7.5の60秒)。 */
  visibilityTimeoutSeconds?: number;
  /** 既定は1件(設計 §7.5「1実行で1メッセージだけを処理する」)。 */
  numberOfMessages?: number;
}

export interface ReceivedPreviewQueueMessage {
  messageId: string;
  popReceipt: string;
  /** `dequeueCount`(設計 §7.5「最大3回」の判定に使う)。 */
  dequeueCount: number;
  /** 検証済みのメッセージ本文。不正な本文は`InvalidQueueMessageError`を投げる。 */
  message: PreviewQueueMessage;
}

/**
 * 受信したメッセージの封筒(envelope)。本文の検証に失敗した場合も`messageId`と
 * `popReceipt`を保持するため、呼び出し側(Preview Job)は検証できないメッセージを
 * queueから取り除ける(取り除けないと同じ不正メッセージが再配信され続ける)。
 */
export interface ReceivedPreviewQueueEnvelope {
  messageId: string;
  popReceipt: string;
  /** `dequeueCount`(設計 §7.5「最大3回」の判定に使う)。 */
  dequeueCount: number;
  /** 検証済みのメッセージ本文。検証に失敗した場合は`null`。 */
  message: PreviewQueueMessage | null;
}

/**
 * Queueからメッセージを受信し、本文の検証結果を`message`(検証失敗時は`null`)として
 * 返す。本文が不正でも`messageId`・`popReceipt`は返るため、呼び出し側は恒久失敗として
 * 削除できる。visibility timeoutは既定60秒(設計 §7.5)。
 *
 * 本文そのもの(利用者由来ではないが、schema外の値が入り得る)は返さない。
 */
export async function receivePreviewGenerationEnvelopes(
  queueClient: QueueClient,
  options?: ReceivePreviewQueueMessagesOptions,
): Promise<ReceivedPreviewQueueEnvelope[]> {
  const response = await queueClient.receiveMessages({
    abortSignal: abortSignalFor(options),
    visibilityTimeout:
      options?.visibilityTimeoutSeconds ??
      DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
    ...(options?.numberOfMessages !== undefined
      ? { numberOfMessages: options.numberOfMessages }
      : {}),
  });

  return response.receivedMessageItems.map((item) => {
    let message: PreviewQueueMessage | null;
    try {
      message = parsePreviewQueueMessage(item.messageText);
    } catch {
      message = null;
    }

    return {
      messageId: item.messageId,
      popReceipt: item.popReceipt,
      dequeueCount: item.dequeueCount,
      message,
    };
  });
}

/**
 * Queueからメッセージを受信し、検証済みの形へ変換して返す。不正な本文は
 * 例外にするため、呼び出し側は個別メッセージ単位で恒久失敗として扱える。
 * 不正な本文をqueueから取り除く必要がある場合(Preview Job)は
 * `receivePreviewGenerationEnvelopes`を使う。
 * visibility timeoutは既定60秒(設計 §7.5)。
 */
export async function receivePreviewGenerationMessages(
  queueClient: QueueClient,
  options?: ReceivePreviewQueueMessagesOptions,
): Promise<ReceivedPreviewQueueMessage[]> {
  const envelopes = await receivePreviewGenerationEnvelopes(queueClient, options);

  return envelopes.map((envelope) => {
    if (envelope.message === null) {
      throw new InvalidQueueMessageError();
    }
    return {
      messageId: envelope.messageId,
      popReceipt: envelope.popReceipt,
      dequeueCount: envelope.dequeueCount,
      message: envelope.message,
    };
  });
}

/**
 * 処理済みメッセージを削除する。既に削除済み・存在しないメッセージへの呼び出しは
 * 冪等に扱い、"MessageNotFound"(そのメッセージだけが存在しない)は成功として扱う
 * (重複配信・重複削除への耐性)。"QueueNotFound"など他の404はqueue自体の設定ミスの
 * 可能性があるため、握り潰さずに伝播させる。
 */
export async function deletePreviewGenerationMessage(
  queueClient: QueueClient,
  messageId: string,
  popReceipt: string,
  options?: StorageOperationOptions,
): Promise<void> {
  try {
    await queueClient.deleteMessage(messageId, popReceipt, {
      abortSignal: abortSignalFor(options),
    });
  } catch (error) {
    if (isMessageNotFoundError(error)) {
      return;
    }
    throw error;
  }
}

function isMessageNotFoundError(error: unknown): boolean {
  return (
    error instanceof RestError &&
    error.statusCode === 404 &&
    error.code === "MessageNotFound"
  );
}
