// Web(React Router SSR)をLinux App Serviceのcustom containerで実行する(設計 §7.1, §7.6)。
// - Easy Auth(authsettingsV2)をBicepで管理し、portal上の手変更を正本にしない(設計 §7.1.1)
// - staging(開発用テナント)は社内ネットワークが無いため、許可したIPアドレスからだけ
//   受け付ける公開エンドポイントにする(設計 §8 との差分。OPERATIONS.md参照)
// - DB・Storage・Key VaultへはVNet統合経由でprivate endpointへ接続する

@description('App Serviceの名前(main.bicepが決め、オリジンの計算にも使う)')
param siteName string
param namePrefix string
param location string
param tags object
param appSubnetId string
param logAnalyticsWorkspaceId string

@description('App Service PlanのSKU(設計 §21 で未決。VNet統合とAlways Onを使うためBasic以上)')
param planSkuName string = 'B1'
@description('アクセスを許可するIPアドレス範囲(CIDR)')
param allowedClientIpRanges array

param identity object
param containerImage string
param tenantId string
@description('Easy Authが使うEntra IDアプリ登録のclient ID')
param entraClientId string
param displayOrigin string
@description('passwordを含まないPostgreSQL接続文字列(DATABASE_AUTH=entra)')
param databaseUrl string
param storageAccountName string
param storageContainerName string
param storageQueueName string
param grantSigningKeyId string
param grantSigningPrivateKeySecretUri string
param logHmacKeySecretUri string
@description('画面に表示するアプリ名。stagingは本番と見分けられる名前にする')
param appName string

var appOrigin = 'https://${siteName}.azurewebsites.net'

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: 'asp-${namePrefix}'
  location: location
  tags: tags
  kind: 'linux'
  sku: { name: planSkuName }
  properties: {
    reserved: true
    zoneRedundant: false
  }
}

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: siteName
  location: location
  tags: tags
  kind: 'app,linux,container'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    virtualNetworkSubnetId: appSubnetId
    // Key Vault参照をVNet(private endpoint)経由で解決するため、外向き通信をVNetへ流す。
    // インターネット宛て(Easy AuthのEntra ID等)はsnet-appのNAT Gatewayから出る
    vnetRouteAllEnabled: true
    keyVaultReferenceIdentity: identity.id
    siteConfig: {
      linuxFxVersion: 'DOCKER|${containerImage}'
      acrUseManagedIdentityCreds: true
      acrUserManagedIdentityID: identity.clientId
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/health'
      ipSecurityRestrictionsDefaultAction: 'Deny'
      ipSecurityRestrictions: [for (range, i) in allowedClientIpRanges: {
        name: 'allow-${i}'
        action: 'Allow'
        priority: 100 + i
        ipAddress: range
      }]
      scmIpSecurityRestrictionsUseMain: true
      appSettings: [
        { name: 'WEBSITES_PORT', value: '8080' }
        { name: 'NODE_ENV', value: 'production' }
        { name: 'PORT', value: '8080' }
        { name: 'APP_NAME', value: appName }
        { name: 'APP_ORIGIN', value: appOrigin }
        { name: 'AUTH_MODE', value: 'easyauth' }
        { name: 'ENTRA_TENANT_ID', value: tenantId }
        { name: 'AZURE_CLIENT_ID', value: identity.clientId }
        { name: 'DATABASE_AUTH', value: 'entra' }
        { name: 'DATABASE_URL', value: databaseUrl }
        { name: 'DISPLAY_ORIGIN', value: displayOrigin }
        { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storageAccountName }
        { name: 'AZURE_STORAGE_CONTAINER', value: storageContainerName }
        { name: 'AZURE_STORAGE_QUEUE_NAME', value: storageQueueName }
        { name: 'GRANT_SIGNING_KEY_ID', value: grantSigningKeyId }
        { name: 'GRANT_SIGNING_PRIVATE_KEY', value: '@Microsoft.KeyVault(SecretUri=${grantSigningPrivateKeySecretUri})' }
        { name: 'LOG_HMAC_KEY', value: '@Microsoft.KeyVault(SecretUri=${logHmacKeySecretUri})' }
      ]
    }
  }
}

// Easy Auth(設計 §7.1.1)。Token Storeは使わず、client secretも持たない(IDトークンだけを使う)。
resource auth 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: site
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: [ '/', '/auth/login', '/health' ]
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenantId}/v2.0'
          clientId: entraClientId
        }
        validation: {
          allowedAudiences: [ entraClientId, 'api://${entraClientId}' ]
        }
      }
    }
    login: {
      tokenStore: { enabled: false }
      preserveUrlFragmentsForLogins: false
    }
    httpSettings: {
      requireHttps: true
    }
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: site
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServicePlatformLogs', enabled: true }
    ]
  }
}

output appOrigin string = appOrigin
output siteName string = site.name
