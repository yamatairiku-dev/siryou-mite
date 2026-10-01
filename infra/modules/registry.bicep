// コンテナイメージのレジストリ(設計 §8, §19.3)。
// - GitHub-hosted runner・開発者のPCからpushするため、認証付きpublic endpointを有効にする
// - 管理者アカウントは無効にし、実行単位はManaged IdentityのAcrPullで取得する

param namePrefix string
param location string
param tags object
@minLength(5)
param uniqueSuffix string
@description('イメージを取得するidentity(全実行単位)')
param pullPrincipalIds array

var acrPullRole = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: take('cr${replace(namePrefix, '-', '')}${uniqueSuffix}', 50)
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource pullers 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in pullPrincipalIds: {
  scope: registry
  name: guid(registry.id, principalId, acrPullRole)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRole)
  }
}]

output registryName string = registry.name
output loginServer string = registry.properties.loginServer
