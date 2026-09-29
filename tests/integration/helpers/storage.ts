/**
 * 結合テスト共通ヘルパー(設計 §18.2)。
 *
 * `tests/integration/helpers/schema.ts`の`assertLocalDatabaseHost`と同じ思想で、
 * Blob/Queue結合テストがローカルのAzurite以外へ接続してcontainer/queueを
 * 作成・削除しないようにするガードを提供する(本番Azure resourceへ接続しない、
 * 設計 §18.2)。
 */
const allowedStorageHosts = new Set([
  "azurite",
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

/**
 * `AZURE_STORAGE_CONNECTION_STRING`がローカルのAzurite以外を指す場合は例外にする。
 * 接続文字列そのもの(account keyを含み得る)はメッセージへ出さず、host名だけを
 * 検査する。
 */
export function assertLocalStorageConnection(connectionString: string): void {
  const trimmed = connectionString.trim();

  if (/^UseDevelopmentStorage=true$/i.test(trimmed)) {
    // Azuriteの既定エンドポイント(127.0.0.1)を指す省略形。
    return;
  }

  const hosts = new Set<string>();
  for (const match of trimmed.matchAll(
    /(?:Blob|Queue)Endpoint=(https?:\/\/[^;]+)/gi,
  )) {
    const endpoint = match[1];
    if (!endpoint) {
      continue;
    }
    try {
      hosts.add(new URL(endpoint).hostname);
    } catch {
      throw new Error(
        "AZURE_STORAGE_CONNECTION_STRING に含まれるBlob/QueueEndpointが不正なURLです",
      );
    }
  }

  if (hosts.size === 0) {
    throw new Error(
      "Integration tests only run against a local Azurite emulator (BlobEndpoint/QueueEndpoint or UseDevelopmentStorage=true required). Point AZURE_STORAGE_CONNECTION_STRING at the devcontainer Azurite (see docs/OPERATIONS.md).",
    );
  }

  for (const host of hosts) {
    if (!allowedStorageHosts.has(host)) {
      throw new Error(
        "Integration tests create and delete containers/queues, so they only run against a local Azurite emulator (azurite / localhost / 127.0.0.1). Point AZURE_STORAGE_CONNECTION_STRING at the devcontainer Azurite (see docs/OPERATIONS.md).",
      );
    }
  }
}

export function requireStorageConnectionString(): string {
  const value = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!value) {
    throw new Error(
      "AZURE_STORAGE_CONNECTION_STRING is required to run integration tests. Run `npm run test:integration` inside the devcontainer (see docs/OPERATIONS.md), or set it to a reachable Azurite instance.",
    );
  }

  assertLocalStorageConnection(value);
  return value;
}

/** テスト専用のcontainer/queue名(衝突と後片付け漏れを避けるため乱数を含める)。 */
export function uniqueTestName(prefix: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${suffix}`;
}
