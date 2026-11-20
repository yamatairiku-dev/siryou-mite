// staging(開発用テナント)のパラメーター。
// 実値(tenant/client ID、許可IP、通知先、鍵)はリポジトリへ保存せず、デプロイを実行する
// シェルの環境変数から読む(設計 §19.2)。手順はdocs/OPERATIONS.md「Azureへのデプロイ(staging)」。
using '../main.bicep'

param environmentName = 'stg'
param appName = '資料みて！(検証)'

param tenantId = readEnvironmentVariable('SIRYOU_TENANT_ID')
param entraClientId = readEnvironmentVariable('SIRYOU_ENTRA_CLIENT_ID')
// カンマ区切りのCIDR(例: 203.0.113.10/32,198.51.100.0/24)
param allowedClientIpRanges = split(readEnvironmentVariable('SIRYOU_ALLOWED_IP_RANGES'), ',')
param alertEmailAddress = readEnvironmentVariable('SIRYOU_ALERT_EMAIL')

param deployApps = bool(readEnvironmentVariable('SIRYOU_DEPLOY_APPS', 'false'))
param imageTag = readEnvironmentVariable('SIRYOU_IMAGE_TAG', 'latest')

param grantSigningKeyId = readEnvironmentVariable('SIRYOU_GRANT_KEY_ID')
param grantSigningPrivateKey = readEnvironmentVariable('SIRYOU_GRANT_PRIVATE_KEY')
param grantVerificationKeys = readEnvironmentVariable('SIRYOU_GRANT_VERIFICATION_KEYS')
param logHmacKey = readEnvironmentVariable('SIRYOU_LOG_HMAC_KEY')
// 撮影サービスのTLS証明書・秘密鍵・共有トークン(infra/scripts/generate-renderer-tls.mjs)。
// 基盤だけのデプロイ(1段階目)では使わない
param rendererTlsCertificate = readEnvironmentVariable('SIRYOU_RENDERER_TLS_CERT', '')
param rendererTlsPrivateKey = readEnvironmentVariable('SIRYOU_RENDERER_TLS_KEY', '')
param rendererAuthToken = readEnvironmentVariable('SIRYOU_RENDERER_AUTH_TOKEN', '')

// 設計 §7.4, §7.6 のstaging値
param webMinReplicas = 1
param postgresSkuName = 'Standard_B1ms'
param postgresSkuTier = 'Burstable'
param postgresStorageAutoGrow = false
param displayMinReplicas = 1
param keyVaultPurgeProtection = false
