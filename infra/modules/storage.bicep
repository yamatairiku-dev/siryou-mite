// HTML・プレビュー画像(Blob)とプレビュー生成メッセージ(Queue)(設計 §7.3, §7.5, §16)。
// - private endpointだけで公開し、public network accessは無効にする(設計 §8)
// - アカウントキー(Shared Key)を無効にし、Managed Identity(Entra ID)だけで接続する
// - Blob soft deleteを7日間有効にする(設計 §16)。LRS(設計 §7.3)
// - 権限は実行単位ごとに最小にする(設計 §7.4)

param namePrefix string
param location string
param tags object
@description('グローバルに一意な名前の接尾辞')
@minLength(5)
param uniqueSuffix string
param privateEndpointSubnetId string
param blobDnsZoneId string
param queueDnsZoneId string
param containerName string = 'documents'
param queueName string = 'preview-generation'

@description('Blobの読み書き・削除(Web・Preview・Maintenance)')
param blobContributorPrincipalIds array
@description('Blobの読み取りだけ(Display)')
param blobReaderPrincipalIds array
@description('Queueへの送信だけ(Web)')
param queueSenderPrincipalIds array
@description('Queueの受信・削除(Preview Job)')
param queueProcessorPrincipalIds array

var roles = {
  blobContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  blobReader: '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
  queueSender: 'c6a89b2d-59bc-44d0-9896-0f6e12d7b80a'
  queueProcessor: '8a0f0c08-91a1-4084-bc3d-661d67233fed'
  // Preview JobのKEDA scalerがキュー長を読むため
  queueReader: '19e7f393-937e-4f77-808e-94535e297925'
}

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('st${replace(namePrefix, '-', '')}${uniqueSuffix}', 24)
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: { publicAccess: 'None' }
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: account
  name: 'default'
}

resource queue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: queueName
}

module blobEndpoint 'private-endpoint.bicep' = {
  name: 'pe-blob'
  params: {
    name: 'pe-${namePrefix}-blob'
    location: location
    tags: tags
    subnetId: privateEndpointSubnetId
    targetResourceId: account.id
    groupId: 'blob'
    privateDnsZoneId: blobDnsZoneId
  }
}

module queueEndpoint 'private-endpoint.bicep' = {
  name: 'pe-queue'
  params: {
    name: 'pe-${namePrefix}-queue'
    location: location
    tags: tags
    subnetId: privateEndpointSubnetId
    targetResourceId: account.id
    groupId: 'queue'
    privateDnsZoneId: queueDnsZoneId
  }
}

// 権限はcontainer・queue単位に絞る(アカウント全体へは与えない)。
resource blobContributors 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in blobContributorPrincipalIds: {
  scope: container
  name: guid(container.id, principalId, roles.blobContributor)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobContributor)
  }
}]

resource blobReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in blobReaderPrincipalIds: {
  scope: container
  name: guid(container.id, principalId, roles.blobReader)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobReader)
  }
}]

resource queueSenders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in queueSenderPrincipalIds: {
  scope: queue
  name: guid(queue.id, principalId, roles.queueSender)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.queueSender)
  }
}]

resource queueProcessors 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in queueProcessorPrincipalIds: {
  scope: queue
  name: guid(queue.id, principalId, roles.queueProcessor)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.queueProcessor)
  }
}]

resource queueReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in queueProcessorPrincipalIds: {
  scope: queue
  name: guid(queue.id, principalId, roles.queueReader)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.queueReader)
  }
}]

output accountName string = account.name
output accountId string = account.id
output containerName string = container.name
output queueName string = queue.name
