/**
 * テスト用の自己署名証明書を、その場で作る(秘密鍵をリポジトリへ置かないため)。
 *
 * 本番では`infra/scripts/generate-renderer-tls.mjs`が同じ形式(ECDSA P-256、SANにIP)で作る。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SelfSignedTls = { cert: string; key: string };

export function createSelfSignedTls(ip = "127.0.0.1"): SelfSignedTls {
  const dir = mkdtempSync(join(tmpdir(), "siryou-tls-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
        "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1",
        "-subj", "/CN=test-renderer", "-addext", `subjectAltName=IP:${ip}`,
      ],
      { stdio: "ignore" },
    );
    return {
      cert: readFileSync(certPath, "utf8"),
      key: readFileSync(keyPath, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
