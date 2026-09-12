import { describe, expect, it } from "vitest";
import { assertLocalStorageConnection } from "./helpers/storage.js";

/**
 * 結合テストの接続先ガード(設計 §18.2「本番Azure resourceには接続しない」)。
 *
 * 結合テストはcontainer/queueを作成・削除するため、ローカルのAzurite以外を
 * 指した`AZURE_STORAGE_CONNECTION_STRING`では実行できないようにしている。
 */
describe("assertLocalStorageConnection", () => {
  it.each([
    "UseDevelopmentStorage=true",
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=dummy;BlobEndpoint=http://azurite:10000/devstoreaccount1;QueueEndpoint=http://azurite:10001/devstoreaccount1;",
    "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;",
    "BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;",
  ])("ローカルのAzurite(%s)を許可する", (connectionString) => {
    expect(() => assertLocalStorageConnection(connectionString)).not.toThrow();
  });

  it.each([
    "DefaultEndpointsProtocol=https;AccountName=realaccount;AccountKey=dummy;EndpointSuffix=core.windows.net",
    "BlobEndpoint=https://realaccount.blob.core.windows.net/;QueueEndpoint=https://realaccount.queue.core.windows.net/;",
    "not-a-connection-string",
  ])("ローカル以外(%s)を拒否する", (connectionString) => {
    expect(() => assertLocalStorageConnection(connectionString)).toThrow();
  });

  it("エラーメッセージへaccount keyを含めない", () => {
    const connectionString =
      "DefaultEndpointsProtocol=https;AccountName=realaccount;AccountKey=sup3r-secret-key;EndpointSuffix=core.windows.net";

    expect(() => assertLocalStorageConnection(connectionString)).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("sup3r-secret-key"),
      }),
    );
  });
});
