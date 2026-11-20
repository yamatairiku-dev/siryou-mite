#!/usr/bin/env node
// 撮影サービス(Azure Container Instances)用のTLS証明書と共有トークンを生成し、
// 環境変数の形でファイルへ書き出す(設計 §9.5、QUESTIONS Q-066)。
//
//   node infra/scripts/generate-renderer-tls.mjs <出力ファイル>
//
// - 自己署名のTLS証明書と秘密鍵(ECDSA P-256)。Subject Alternative Nameに固定のDNS名
//   (`SERVER_NAME`。`services/preview/renderer-client.ts`の`RENDERER_TLS_SERVER_NAME`と同じ値)を
//   入れる。ACIのプライベートIPは指定できず変わることがあるため、IPは入れない。
//   秘密鍵は撮影サービスだけが持ち、証明書はPreview Jobが「この証明書だけを信頼する」ために使う
// - 共有トークン(32byte、base64url)。Preview Jobが`Authorization: Bearer`で送る
// - 有効期限は10年(公開の認証局を使わず、両端を自分たちで管理するため)。期限は出力ファイルの
//   コメントと`docs/OPERATIONS.md`に記録する
//
// 秘密値を画面へ出さないよう、ファイルへだけ書き出し、権限を所有者のみ(600)にする。
// `keys.env`(表示grantの鍵)とは別のファイルにし、既存の鍵を上書きしない。
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VALID_DAYS = 3650;
// services/preview/renderer-client.ts の RENDERER_TLS_SERVER_NAME と一致させる
// (tests/unit/services/preview-renderer-client.test.ts が確認する)。
const SERVER_NAME = "preview-renderer.siryou-mite.internal";

const [outputPath] = process.argv.slice(2);
if (!outputPath) {
  console.error("usage: node infra/scripts/generate-renderer-tls.mjs <output-file>");
  process.exit(2);
}
const target = resolve(outputPath);
if (target.startsWith(resolve(process.cwd()) + "/") && !target.includes("/node_modules/")) {
  console.error("出力ファイルはリポジトリの外に置いてください(誤ってcommitしないため)");
  process.exit(2);
}
if (existsSync(target)) {
  console.error("出力ファイルが既にあります。上書きしないので、別の名前を指定してください");
  process.exit(2);
}

const workDir = mkdtempSync(join(tmpdir(), "siryou-renderer-tls-"));
let cert;
let key;
try {
  const keyPath = join(workDir, "key.pem");
  const certPath = join(workDir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-keyout", keyPath, "-out", certPath, "-days", String(VALID_DAYS),
      "-subj", "/CN=siryou-mite-preview-renderer",
      "-addext", `subjectAltName=DNS:${SERVER_NAME}`,
      "-addext", "extendedKeyUsage=serverAuth",
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(certPath, "utf8");
  key = readFileSync(keyPath, "utf8");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const notAfter = new Date(Date.now() + VALID_DAYS * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const token = randomBytes(32).toString("base64url");

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const lines = [
  "# 資料みて！ 撮影サービスのTLS証明書と共有トークン(秘密値を含む。commitしない・共有しない)",
  `# 証明書の名前: ${SERVER_NAME} / 有効期限: ${notAfter}ごろ`,
  `SIRYOU_RENDERER_TLS_CERT=${quote(cert)}`,
  `SIRYOU_RENDERER_TLS_KEY=${quote(key)}`,
  `SIRYOU_RENDERER_AUTH_TOKEN=${quote(token)}`,
  "",
];
writeFileSync(target, lines.join("\n"), { mode: 0o600, flag: "wx" });
console.log(
  `撮影サービスの証明書とトークンを書き出しました(有効期限: ${notAfter}ごろ)。秘密値は表示しません。`,
);
