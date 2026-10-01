import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Preview Job専用image(`Dockerfile.preview`)のbase imageのtagが、image内で
 * Chromiumを起動する`playwright-core`のversionと一致すること(設計 §7.5)。
 *
 * image内のbrowserはbase imageが配置したものを使うため、versionがずれると
 * Preview Jobの実行時にbrowserが見つからず起動できない。CIはこのimageの中で
 * Chromiumを起動しないため、Dependabotが`@playwright/test`だけを上げたときに
 * ここで検出する。
 */

/** vitestはリポジトリのrootで実行する(jsdom環境では`import.meta.url`がfile URLにならない)。 */
function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function previewBaseImageVersion(): string | undefined {
  const match = /^FROM mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-\S+/m.exec(
    readRepoFile("Dockerfile.preview"),
  );
  return match?.[1];
}

describe("Preview Job imageのPlaywright version(設計 §7.5)", () => {
  it("base imageのtagが`package.json`の`@playwright/test`と一致する", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      devDependencies: Record<string, string>;
    };

    expect(previewBaseImageVersion()).toBe(
      packageJson.devDependencies["@playwright/test"],
    );
  });

  it("base imageのtagがimageへコピーする`playwright-core`(lockfile)と一致する", () => {
    const lock = JSON.parse(readRepoFile("package-lock.json")) as {
      packages: Record<string, { version?: string }>;
    };

    expect(previewBaseImageVersion()).toBe(
      lock.packages["node_modules/playwright-core"]?.version,
    );
  });
});
