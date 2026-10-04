// 「資料みて！」のAzureリソース一式(設計 §7, §8, §19.2)。
//
// staging・productionで同じモジュールを使い、環境ごとの違いはparameter file
// (infra/parameters/*.bicepparam)で切り替える。秘密値・tenant/client IDの実値・
// 許可IP・通知先メールアドレスはリポジトリへ保存せず、デプロイ時の環境変数から渡す。
//
// デプロイは2段階(手順はdocs/OPERATIONS.md「Azureへのデプロイ(staging)」):
//   1. deployApps=false: ネットワーク・DB・Storage・Key Vault・ACRなどの基盤
//   2. ACRへイメージをpushしたあと、deployApps=true: Web・Display・各Job
// 2段階にするのは、Container Appsの作成時にイメージを取得できる必要があるため。

targetScope = 'resourceGroup'

@description('環境名(stg、prodなど)。リソース名に入る')
@maxLength(8)
param environmentName string
param location string = resourceGroup().location
@description('リソース名の接頭辞')
param appPrefix string = 'siryou-mite'

@description('Entra IDのtenant ID(Easy Auth・PostgreSQL・Key Vault)')
param tenantId string = tenant().tenantId
@description('Easy Authが使うEntra IDアプリ登録のclient ID')
param entraClientId string
@description('Web・Displayへのアクセスを許可するIPアドレス範囲(CIDR)')
@minLength(1)
param allowedClientIpRanges array
@description('監視の通知先メールアドレス')
param alertEmailAddress string

@description('Web・Display・Migration・Maintenance・DB初期設定のイメージを作ったあとにtrueにする')
param deployApps bool = false
@description('ACRへpushしたイメージのtag(git commit SHAなど)')
param imageTag string = 'latest'
@description('画面に表示するアプリ名')
param appName string = '資料みて！'

@description('表示grant署名鍵のkeyId')
param grantSigningKeyId string
@secure()
@description('表示grant署名用Ed25519秘密鍵(PEM)')
param grantSigningPrivateKey string
@description('Displayがgrantを検証する公開鍵。[{"keyId":"...","publicKey":"-----BEGIN PUBLIC KEY-----..."}]')
param grantVerificationKeys string
@secure()
@description('ログ記録用HMAC鍵(base64、32byte以上)')
param logHmacKey string

param webMinReplicas int = 1
param postgresSkuName string = 'Standard_B1ms'
param postgresSkuTier string = 'Burstable'
param postgresStorageAutoGrow bool = false
param displayMinReplicas int = 0
param keyVaultPurgeProtection bool = false

var namePrefix = '${appPrefix}-${environmentName}'
var uniqueSuffix = uniqueString(resourceGroup().id)
var tags = {
  application: appPrefix
  environment: environmentName
}
var databaseName = 'siryou_mite'

module network 'modules/network.bicep' = {
  name: 'network'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
  }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
    alertEmailAddress: alertEmailAddress
  }
}

module identities 'modules/identities.bicep' = {
  name: 'identities'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
  }
}

var ids = identities.outputs.identities

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
    uniqueSuffix: uniqueSuffix
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    blobDnsZoneId: network.outputs.blobDnsZoneId
    queueDnsZoneId: network.outputs.queueDnsZoneId
    blobContributorPrincipalIds: [ ids.web.principalId, ids.preview.principalId, ids.maintenance.principalId ]
    blobReaderPrincipalIds: [ ids.display.principalId ]
    queueSenderPrincipalIds: [ ids.web.principalId ]
    queueProcessorPrincipalIds: [ ids.preview.principalId ]
  }
}

module keyVault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
    uniqueSuffix: uniqueSuffix
    tenantId: tenantId
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    keyVaultDnsZoneId: network.outputs.keyVaultDnsZoneId
    enablePurgeProtection: keyVaultPurgeProtection
    grantSigningPrivateKey: grantSigningPrivateKey
    logHmacKey: logHmacKey
    grantKeyReaderPrincipalIds: [ ids.web.principalId ]
    hmacKeyReaderPrincipalIds: [
      ids.web.principalId
      ids.display.principalId
      ids.preview.principalId
      ids.maintenance.principalId
    ]
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
    uniqueSuffix: uniqueSuffix
    tenantId: tenantId
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    postgresDnsZoneId: network.outputs.postgresDnsZoneId
    actionGroupId: monitoring.outputs.actionGroupId
    adminIdentityName: ids.dbadmin.name
    adminIdentityPrincipalId: ids.dbadmin.principalId
    skuName: postgresSkuName
    skuTier: postgresSkuTier
    storageAutoGrow: postgresStorageAutoGrow
  }
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
    uniqueSuffix: uniqueSuffix
    pullPrincipalIds: [
      ids.web.principalId
      ids.display.principalId
      ids.preview.principalId
      ids.maintenance.principalId
      ids.migrate.principalId
      ids.dbadmin.principalId
    ]
  }
}

// ---- 2段階目: アプリとJob ---------------------------------------------------

var appImage = '${registry.outputs.loginServer}/siryou-mite:${imageTag}'
var previewImage = '${registry.outputs.loginServer}/siryou-mite-preview:${imageTag}'

// Managed Identityの名前がPostgreSQLの利用者名になる(passwordは書かない。DATABASE_AUTH=entra)。
func databaseUrl(identityName string, host string, database string) string =>
  'postgres://${uriComponent(identityName)}@${host}:5432/${database}'

var databaseHost = postgres.outputs.fullyQualifiedDomainName
var databaseUrls = {
  web: databaseUrl(ids.web.name, databaseHost, databaseName)
  display: databaseUrl(ids.display.name, databaseHost, databaseName)
  preview: databaseUrl(ids.preview.name, databaseHost, databaseName)
  maintenance: databaseUrl(ids.maintenance.name, databaseHost, databaseName)
  migrate: databaseUrl(ids.migrate.name, databaseHost, databaseName)
  dbadmin: databaseUrl(ids.dbadmin.name, databaseHost, databaseName)
}

// DB初期設定Jobが作るrole(services/db-bootstrap/env.ts)。
var dbBootstrapPrincipals = [
  { name: ids.web.name, objectId: ids.web.principalId, role: 'runtime' }
  { name: ids.display.name, objectId: ids.display.principalId, role: 'runtime' }
  { name: ids.preview.name, objectId: ids.preview.principalId, role: 'runtime' }
  { name: ids.maintenance.name, objectId: ids.maintenance.principalId, role: 'maintenance' }
  { name: ids.migrate.name, objectId: ids.migrate.principalId, role: 'migration' }
]

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: 'log-${namePrefix}'
  dependsOn: [ monitoring ]
}

module containerApps 'modules/container-apps.bicep' = if (deployApps) {
  name: 'container-apps'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
    containerAppsSubnetId: network.outputs.containerAppsSubnetId
    logAnalyticsCustomerId: monitoring.outputs.logAnalyticsCustomerId
    logAnalyticsSharedKey: logs.listKeys().primarySharedKey
    identities: ids
    registryLoginServer: registry.outputs.loginServer
    appImage: appImage
    previewImage: previewImage
    allowedClientIpRanges: allowedClientIpRanges
    webMinReplicas: webMinReplicas
    displayMinReplicas: displayMinReplicas
    tenantId: tenantId
    entraClientId: entraClientId
    appName: appName
    databaseUrls: databaseUrls
    storageAccountName: storage.outputs.accountName
    storageContainerName: storage.outputs.containerName
    storageQueueName: storage.outputs.queueName
    logHmacKeySecretUri: keyVault.outputs.logHmacKeySecretUri
    grantSigningKeyId: grantSigningKeyId
    grantSigningPrivateKeySecretUri: keyVault.outputs.grantSigningPrivateKeySecretUri
    grantVerificationKeys: grantVerificationKeys
    dbBootstrapPrincipals: string(dbBootstrapPrincipals)
  }
}

var appOrigin = deployApps ? containerApps!.outputs.webOrigin : ''

output registryName string = registry.outputs.registryName
output registryLoginServer string = registry.outputs.loginServer
output postgresServerName string = postgres.outputs.serverName
output appOrigin string = appOrigin
output displayOrigin string = deployApps ? containerApps!.outputs.displayOrigin : ''
output jobNames object = deployApps ? containerApps!.outputs.jobNames : {}
output entraRedirectUri string = deployApps ? '${appOrigin}/.auth/login/aad/callback' : ''
