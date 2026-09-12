import { afterEach, describe, expect, it } from "vitest";
import {
  getDocumentsContainerClientForWeb,
  getPreviewQueueClientForWeb,
  resetStorageClientsForTest,
} from "~/lib/storage.server";

/**
 * Web向け薄いラッパー(設計 §7.3, §7.5)。実処理は`services/shared/storage.ts`の
 * 単体テスト(`tests/unit/services/storage.test.ts`)で検証済みのため、ここでは
 * `app/lib/env.server.ts`の値からclientを組み立て、使い回すことだけを確認する。
 * テスト環境の`AZURE_STORAGE_CONNECTION_STRING`はAzuriteの接続文字列
 * (`UseDevelopmentStorage=true`)で、client生成は実際の接続を行わない。
 */
afterEach(() => {
  resetStorageClientsForTest();
});

describe("getDocumentsContainerClientForWeb", () => {
  it("env.AZURE_STORAGE_CONTAINERのcontainer clientを返し、使い回す", () => {
    const client = getDocumentsContainerClientForWeb();

    expect(client.containerName).toBe("documents");
    expect(getDocumentsContainerClientForWeb()).not.toBe(client);
    // BlobServiceClient自体は使い回すため、同じaccountを指す。
    expect(getDocumentsContainerClientForWeb().accountName).toBe(
      client.accountName,
    );
  });
});

describe("getPreviewQueueClientForWeb", () => {
  it("env.AZURE_STORAGE_QUEUE_NAMEのqueue clientを返す", () => {
    const client = getPreviewQueueClientForWeb();

    expect(client.name).toBe("preview-generation");
  });
});
