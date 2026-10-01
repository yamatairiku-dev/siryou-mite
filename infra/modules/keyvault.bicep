// 秘密値(grant署名用Ed25519秘密鍵・ログ用HMAC鍵)の保管(設計 §9.5、OPERATIONS.md「シークレット更新」)。
// - private endpointだけで公開し、public network accessは無効にする(設計 §8)
// - アクセス制御はAzure RBAC。秘密値を読めるのは指定したManaged Identityだけ
// - 秘密値はデプロイ時の@secureパラメーターで受け取り、リポジトリへ保存しない

param namePrefix string
param location string
param tags object
@minLength(5)
param uniqueSuffix string
param tenantId string
param privateEndpointSubnetId string
param keyVaultDnsZoneId string
@description('soft deleteの保持日数(7〜90)。stagingは作り直しやすいよう短くする')
@minValue(7)
@maxValue(90)
param softDeleteRetentionDays int = 7
@description('purge protection。有効にすると保持期間中は同名で作り直せない。本番は有効にする')
param enablePurgeProtection bool = false

@secure()
@description('表示grant署名用Ed25519秘密鍵(PEM)。Webだけが使う')
param grantSigningPrivateKey string
@secure()
@description('ログ記録用HMAC鍵(base64、32byte以上)')
param logHmacKey string

@description('grant署名用秘密鍵を読めるidentity(Webだけ)')
param grantKeyReaderPrincipalIds array
@description('HMAC鍵を読めるidentity(Web・Display・Preview・Maintenance)')
param hmacKeyReaderPrincipalIds array

var secretsUserRole = '4633458b-17de-408a-b874-0445c86b69e6'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('kv-${namePrefix}-${uniqueSuffix}', 24)
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionDays
    enablePurgeProtection: enablePurgeProtection ? true : null
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
    }
  }
}

resource grantKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'grant-signing-private-key'
  properties: { value: grantSigningPrivateKey }
}

resource hmacKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'log-hmac-key'
  properties: { value: logHmacKey }
}

module endpoint 'private-endpoint.bicep' = {
  name: 'pe-vault'
  params: {
    name: 'pe-${namePrefix}-vault'
    location: location
    tags: tags
    subnetId: privateEndpointSubnetId
    targetResourceId: vault.id
    groupId: 'vault'
    privateDnsZoneId: keyVaultDnsZoneId
  }
}

// 秘密値ごとに読めるidentityを分ける(vault全体へは与えない)。
resource grantKeyReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in grantKeyReaderPrincipalIds: {
  scope: grantKeySecret
  name: guid(grantKeySecret.id, principalId, secretsUserRole)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRole)
  }
}]

resource hmacKeyReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in hmacKeyReaderPrincipalIds: {
  scope: hmacKeySecret
  name: guid(hmacKeySecret.id, principalId, secretsUserRole)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRole)
  }
}]

output vaultName string = vault.name
output grantSigningPrivateKeySecretUri string = grantKeySecret.properties.secretUri
output logHmacKeySecretUri string = hmacKeySecret.properties.secretUri
