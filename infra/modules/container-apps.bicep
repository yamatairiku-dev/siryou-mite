// Container Apps環境と、Web・Display・Preview Job・Maintenance Job・Migration Job・
// DB初期設定Job(設計 §7.1, §7.2, §7.5, §7.6, §7.7)。
// - 環境はsnet-cae(インターネットへの通信をNSGで拒否)へ配置する(設計 §8)
// - WebとDisplayは別オリジンで公開し、staging(開発用テナント)は許可したIPアドレスだけを通す
// - WebだけEasy Auth(authConfigs)を有効にする。Webでは認証sidecarを通らない経路になり得る
//   Daprを有効にしない(設計 §9.1)
// - 各実行単位は専用のManaged IdentityでACR・DB・Storage・Key Vaultへ接続する
// - Web・Display・Migration・Maintenance・DB初期設定は同じNode.js imageをcommandだけ変えて使い、
//   Preview Jobだけ専用image(設計 §7.6)

param namePrefix string
param location string
param tags object
param containerAppsSubnetId string
param logAnalyticsCustomerId string
@secure()
param logAnalyticsSharedKey string

param identities object
param registryLoginServer string
param appImage string
param previewImage string

param allowedClientIpRanges array
@description('Webの最小レプリカ数。Easy Authのログインで起動待ちを避けるため1以上(設計 §7.6)')
@minValue(1)
param webMinReplicas int = 1
@description('Displayの最小レプリカ数。stagingは0、productionは1(設計 §7.6)')
param displayMinReplicas int = 0

@description('Entra IDのtenant ID(Easy Authのissuerとアプリのtid照合)')
param tenantId string
@description('Easy Authが使うEntra IDアプリ登録のclient ID')
param entraClientId string
@description('画面に表示するアプリ名。stagingは本番と見分けられる名前にする')
param appName string

param databaseUrls object
param storageAccountName string
param storageContainerName string
param storageQueueName string
param logHmacKeySecretUri string
param grantSigningKeyId string
param grantSigningPrivateKeySecretUri string
@description('Displayがgrantを検証する公開鍵(keyId付きJSON配列、秘密値ではない)')
param grantVerificationKeys string
@description('DB初期設定Jobへ渡す対象identityの一覧(JSON)')
param dbBootstrapPrincipals string

// WebとDisplayのオリジンは環境の既定ドメインから決まる(staging。productionはカスタムドメイン、設計 §8)
var webName = 'ca-${namePrefix}-web'
var displayName = 'ca-${namePrefix}-display'
var webOrigin = 'https://${webName}.${environment.properties.defaultDomain}'
var displayOrigin = 'https://${displayName}.${environment.properties.defaultDomain}'

var commonEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'DATABASE_AUTH', value: 'entra' }
]
var storageEnv = [
  { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storageAccountName }
  { name: 'AZURE_STORAGE_CONTAINER', value: storageContainerName }
]
var hmacSecretEnv = [ { name: 'LOG_HMAC_KEY', secretRef: 'log-hmac-key' } ]

func hmacSecret(secretUri string, identityId string) object => {
  name: 'log-hmac-key'
  keyVaultUrl: secretUri
  identity: identityId
}

func registryFor(server string, identityId string) object => {
  server: server
  identity: identityId
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: 'cae-${namePrefix}'
  location: location
  tags: tags
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: containerAppsSubnetId
      internal: false
    }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
    zoneRedundant: false
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
  }
}

var ipRestrictions = [for (range, i) in allowedClientIpRanges: {
  name: 'allow-${i}'
  action: 'Allow'
  ipAddressRange: range
}]

// Web(React Router SSR、設計 §7.1)。imageの既定CMDで起動する。
resource web 'Microsoft.App/containerApps@2025-01-01' = {
  name: webName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identities.web.id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        ipSecurityRestrictions: ipRestrictions
      }
      registries: [ registryFor(registryLoginServer, identities.web.id) ]
      secrets: [
        hmacSecret(logHmacKeySecretUri, identities.web.id)
        {
          name: 'grant-signing-private-key'
          keyVaultUrl: grantSigningPrivateKeySecretUri
          identity: identities.web.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: appImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(commonEnv, storageEnv, hmacSecretEnv, [
            { name: 'PORT', value: '8080' }
            { name: 'APP_NAME', value: appName }
            { name: 'APP_ORIGIN', value: webOrigin }
            { name: 'AUTH_MODE', value: 'easyauth' }
            { name: 'ENTRA_TENANT_ID', value: tenantId }
            { name: 'AZURE_CLIENT_ID', value: identities.web.clientId }
            { name: 'DATABASE_URL', value: databaseUrls.web }
            { name: 'DISPLAY_ORIGIN', value: displayOrigin }
            { name: 'AZURE_STORAGE_QUEUE_NAME', value: storageQueueName }
            { name: 'GRANT_SIGNING_KEY_ID', value: grantSigningKeyId }
            { name: 'GRANT_SIGNING_PRIVATE_KEY', secretRef: 'grant-signing-private-key' }
          ])
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: { minReplicas: webMinReplicas, maxReplicas: 3 }
    }
  }
}

// Easy Auth(設計 §7.1.1)。Token Storeは使わず、client secretも持たない(IDトークンだけを使う)。
resource webAuth 'Microsoft.App/containerApps/authConfigs@2025-01-01' = {
  parent: web
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: [ '/', '/auth/login', '/health' ]
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: '${az.environment().authentication.loginEndpoint}${tenantId}/v2.0'
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

resource display 'Microsoft.App/containerApps@2025-01-01' = {
  name: displayName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identities.display.id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        ipSecurityRestrictions: ipRestrictions
      }
      registries: [ registryFor(registryLoginServer, identities.display.id) ]
      secrets: [ hmacSecret(logHmacKeySecretUri, identities.display.id) ]
    }
    template: {
      containers: [
        {
          name: 'display'
          image: appImage
          command: [ 'node', 'build/services/display/index.js' ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(commonEnv, storageEnv, hmacSecretEnv, [
            { name: 'PORT', value: '8080' }
            { name: 'APP_ORIGIN', value: webOrigin }
            { name: 'AZURE_CLIENT_ID', value: identities.display.clientId }
            { name: 'DATABASE_URL', value: databaseUrls.display }
            { name: 'GRANT_VERIFICATION_KEYS', value: grantVerificationKeys }
          ])
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: { minReplicas: displayMinReplicas, maxReplicas: 3 }
    }
  }
}

// Preview Job: Queueにメッセージがある場合だけ起動し、1実行で1メッセージを処理する(設計 §7.5)。
// 再試行はQueueの再配信で行うため、Job側の再試行は0にする。
resource previewJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'caj-${namePrefix}-preview'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identities.preview.id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Event'
      replicaTimeout: 45
      replicaRetryLimit: 0
      eventTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: 2
          pollingInterval: 10
          rules: [
            {
              name: 'preview-queue'
              type: 'azure-queue'
              metadata: {
                accountName: storageAccountName
                queueName: storageQueueName
                queueLength: '1'
              }
              identity: identities.preview.id
            }
          ]
        }
      }
      registries: [ registryFor(registryLoginServer, identities.preview.id) ]
      secrets: [ hmacSecret(logHmacKeySecretUri, identities.preview.id) ]
    }
    template: {
      containers: [
        {
          name: 'preview'
          image: previewImage
          command: [ 'node', 'build/services/preview/index.js' ]
          resources: { cpu: json('1'), memory: '2Gi' }
          env: concat(commonEnv, storageEnv, hmacSecretEnv, [
            { name: 'AZURE_CLIENT_ID', value: identities.preview.clientId }
            { name: 'DATABASE_URL', value: databaseUrls.preview }
            { name: 'AZURE_STORAGE_QUEUE_NAME', value: storageQueueName }
          ])
          // Chromiumは書き込み可能な/tmpを必要とする(OPERATIONS.md「Preview Job専用image」)
          volumeMounts: [ { volumeName: 'tmp', mountPath: '/tmp' } ]
        }
      ]
      volumes: [ { name: 'tmp', storageType: 'EmptyDir' } ]
    }
  }
}

// Maintenance Job: 毎日UTC 18:00(JST 03:00)に1回、並列実行しない(設計 §7.7)。
resource maintenanceJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'caj-${namePrefix}-maintenance'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identities.maintenance.id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      // Job実行上限(既定900秒)+強制終了までの猶予60秒
      replicaTimeout: 960
      replicaRetryLimit: 0
      scheduleTriggerConfig: {
        cronExpression: '0 18 * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [ registryFor(registryLoginServer, identities.maintenance.id) ]
      secrets: [ hmacSecret(logHmacKeySecretUri, identities.maintenance.id) ]
    }
    template: {
      containers: [
        {
          name: 'maintenance'
          image: appImage
          command: [ 'node', 'build/services/maintenance/index.js' ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(commonEnv, storageEnv, hmacSecretEnv, [
            { name: 'AZURE_CLIENT_ID', value: identities.maintenance.clientId }
            { name: 'DATABASE_URL', value: databaseUrls.maintenance }
          ])
        }
      ]
    }
  }
}

// Migration Job: deploy前に手動(またはCI/CD)で1回起動する(設計 §7.4)。
resource migrateJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'caj-${namePrefix}-migrate'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identities.migrate.id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [ registryFor(registryLoginServer, identities.migrate.id) ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: appImage
          command: [ 'node', 'build/services/migrate/index.js' ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(commonEnv, [
            { name: 'AZURE_CLIENT_ID', value: identities.migrate.clientId }
            { name: 'DATABASE_URL', value: databaseUrls.migrate }
          ])
        }
      ]
    }
  }
}

// DB初期設定Job: 構築時とidentityの追加・作り直し時に手動で起動する(冪等)。Migration Jobより先。
resource dbBootstrapJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'caj-${namePrefix}-dbbootstrap'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identities.dbadmin.id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 300
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [ registryFor(registryLoginServer, identities.dbadmin.id) ]
    }
    template: {
      containers: [
        {
          name: 'db-bootstrap'
          image: appImage
          command: [ 'node', 'build/services/db-bootstrap/index.js' ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(commonEnv, [
            { name: 'AZURE_CLIENT_ID', value: identities.dbadmin.clientId }
            { name: 'DATABASE_URL', value: databaseUrls.dbadmin }
            { name: 'DB_BOOTSTRAP_PRINCIPALS', value: dbBootstrapPrincipals }
          ])
        }
      ]
    }
  }
}

output webOrigin string = webOrigin
output displayOrigin string = displayOrigin
output environmentName string = environment.name
output jobNames object = {
  preview: previewJob.name
  maintenance: maintenanceJob.name
  migrate: migrateJob.name
  dbBootstrap: dbBootstrapJob.name
}
