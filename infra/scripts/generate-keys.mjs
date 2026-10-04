#!/usr/bin/env node
// staging等のデプロイに使う鍵を生成し、環境変数の形でファイルへ書き出す(設計 §9.5)。
//
//   node infra/scripts/generate-keys.mjs <出力ファイル> [keyId]
//
// - 表示grant署名用のEd25519鍵ペア(秘密鍵はWeb、公開鍵はDisplayが使う)
// - ログ記録用HMAC鍵(32byte、base64)
//
// 秘密値を画面へ出さないよう、ファイルへだけ書き出し、権限を所有者のみ(600)にする。
// 出力ファイルはリポジトリの外に置き、デプロイ前に `set -a; . <出力ファイル>; set +a` で読み込む。
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [outputPath, keyIdArg] = process.argv.slice(2);
if (!outputPath) {
  console.error("usage: node infra/scripts/generate-keys.mjs <output-file> [keyId]");
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

const keyId = keyIdArg ?? `grant-${new Date().toISOString().slice(0, 10)}`;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const verificationKeys = JSON.stringify([{ keyId, publicKey: publicPem }]);
const hmacKey = randomBytes(32).toString("base64");

// シェルの単一引用符で囲む(値に単一引用符は含まれないが、念のためエスケープする)。
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const lines = [
  "# 資料みて！ デプロイ用の鍵(秘密値を含む。commitしない・共有しない)",
  `SIRYOU_GRANT_KEY_ID=${quote(keyId)}`,
  `SIRYOU_GRANT_PRIVATE_KEY=${quote(privatePem)}`,
  `SIRYOU_GRANT_VERIFICATION_KEYS=${quote(verificationKeys)}`,
  `SIRYOU_LOG_HMAC_KEY=${quote(hmacKey)}`,
  "",
];
writeFileSync(target, lines.join("\n"), { mode: 0o600, flag: "wx" });
console.log(`鍵を書き出しました(keyId: ${keyId})。秘密値は表示しません。`);
