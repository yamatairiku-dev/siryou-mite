// 監視(設計 §17)。ログの集約先と、運用担当者へのメール通知先だけを用意する。
// 個別のアラート(Job失敗・ストレージ使用率など)は、対象リソースのモジュールで作る。

param namePrefix string
param location string
param tags object
@description('通知先メールアドレス(運用担当者の共有アドレス)。リポジトリへ実値を保存しない')
param alertEmailAddress string
@description('ログの保持日数')
param logRetentionDays int = 30

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${namePrefix}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: logRetentionDays
  }
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-${namePrefix}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'siryoumite'
    enabled: true
    emailReceivers: [
      {
        name: 'operations'
        emailAddress: alertEmailAddress
        useCommonAlertSchema: true
      }
    ]
  }
}

output logAnalyticsWorkspaceId string = logs.id
output logAnalyticsCustomerId string = logs.properties.customerId
output actionGroupId string = actionGroup.id
