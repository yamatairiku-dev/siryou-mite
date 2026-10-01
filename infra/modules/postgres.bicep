// Azure Database for PostgreSQL Flexible Server(設計 §7.4, §16)。
// - Entra ID認証だけを有効にし、password認証は無効にする(Managed Identityで接続)
// - Entra管理者はDB初期設定Job専用のManaged Identity。各実行単位のrole作成と権限付与は
//   そのJob(services/db-bootstrap)が行い、業務DBもそのJobが作る(Bicepでは作らない)
// - private endpointだけで公開し、public network accessは無効にする(設計 §8)
// - バックアップ(point-in-time restore)は7日間。HA・ゾーン冗長は使わない(設計 §16)

param namePrefix string
param location string
param tags object
@minLength(5)
param uniqueSuffix string
param tenantId string
param privateEndpointSubnetId string
param postgresDnsZoneId string
param actionGroupId string

@description('Entra管理者にするManaged Identity(DB初期設定Job)')
param adminIdentityName string
param adminIdentityPrincipalId string

@description('SKU。stagingはBurstable B1ms、productionはGeneral Purpose 2 vCore(設計 §7.4)')
param skuName string = 'Standard_B1ms'
@allowed([ 'Burstable', 'GeneralPurpose', 'MemoryOptimized' ])
param skuTier string = 'Burstable'
param storageSizeGB int = 32
@description('storageの自動拡張。productionは有効(設計 §7.4)')
param storageAutoGrow bool = false
param postgresVersion string = '16'

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-${namePrefix}-${uniqueSuffix}'
  location: location
  tags: tags
  sku: { name: skuName, tier: skuTier }
  properties: {
    version: postgresVersion
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: tenantId
    }
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: storageAutoGrow ? 'Enabled' : 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: {
      publicNetworkAccess: 'Disabled'
    }
  }
}

resource admin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: server
  name: adminIdentityPrincipalId
  properties: {
    principalName: adminIdentityName
    principalType: 'ServicePrincipal'
    tenantId: tenantId
  }
}

module endpoint 'private-endpoint.bicep' = {
  name: 'pe-postgres'
  params: {
    name: 'pe-${namePrefix}-postgres'
    location: location
    tags: tags
    subnetId: privateEndpointSubnetId
    targetResourceId: server.id
    groupId: 'postgresqlServer'
    privateDnsZoneId: postgresDnsZoneId
  }
}

// storage使用率70%で警告、85%で緊急通知(設計 §17)。
resource storageAlerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [for alert in [
  { name: 'warning', threshold: 70, severity: 2 }
  { name: 'critical', threshold: 85, severity: 0 }
]: {
  name: 'alert-${namePrefix}-psql-storage-${alert.name}'
  location: 'global'
  tags: tags
  properties: {
    severity: alert.severity
    enabled: true
    scopes: [ server.id ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'storage_percent'
          criterionType: 'StaticThresholdCriterion'
          metricName: 'storage_percent'
          operator: 'GreaterThanOrEqual'
          threshold: alert.threshold
          timeAggregation: 'Maximum'
        }
      ]
    }
    actions: [ { actionGroupId: actionGroupId } ]
  }
}]

output serverName string = server.name
output fullyQualifiedDomainName string = server.properties.fullyQualifiedDomainName
