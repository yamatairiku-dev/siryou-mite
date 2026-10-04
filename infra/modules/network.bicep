// ネットワーク(設計 §8)。staging(開発用テナント)では社内ネットワークが無いため、
// このテンプレートでVNet・サブネット・Private DNSゾーンを新規作成する。
//
// - snet-cae: Container Apps環境(Web・Display・各Job)用。DB・Storage・Key Vaultへは
//   private endpoint経由。NSGでインターネットへの通信を拒否し、
//   コンテナイメージの取得・Entra ID・監視など必要な宛先だけを許可する(設計 §8)
// - snet-pe: private endpoint用
//
// 2025年9月30日以降に作るVNetは既定の外向き通信(default outbound access)が無いため、
// 外向き通信が必要なsnet-caeにはNAT Gatewayを付ける。宛先の制限はNSGで行う。

@description('リソース名の接頭辞(例: siryou-mite-stg)')
param namePrefix string
param location string
param tags object
@description('VNetのアドレス空間')
param addressPrefix string = '10.40.0.0/16'

var privateDnsZoneNames = [
  'privatelink.postgres.database.azure.com'
  #disable-next-line no-hardcoded-env-urls
  'privatelink.blob.core.windows.net'
  #disable-next-line no-hardcoded-env-urls
  'privatelink.queue.core.windows.net'
  'privatelink.vaultcore.azure.net'
]

resource natIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'pip-${namePrefix}-nat'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource nat 'Microsoft.Network/natGateways@2024-05-01' = {
  name: 'ng-${namePrefix}'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    idleTimeoutInMinutes: 4
    publicIpAddresses: [ { id: natIp.id } ]
  }
}

// Container Apps環境のサブネット。インターネットへの通信は最後のルールで拒否する(設計 §8
// 「HTML表示サービスとプレビューワーカーから外部インターネットへの通信を禁止」)。
// 許可する宛先はContainer Apps(workload profiles環境)の動作に必要なものだけ。
resource caeNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-${namePrefix}-cae'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowVnetOutbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRange: '*'
        }
      }
      {
        // Managed IdentityのtokenとEntra ID(WebのEasy Auth sidecarのOIDCメタデータ・署名鍵を含む)
        name: 'AllowEntraIdOutbound'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureActiveDirectory'
          destinationPortRange: '443'
        }
      }
      {
        // アプリのイメージ(ACR)。ACR Basicのレイヤーはリージョンのblob endpointから配信される
        name: 'AllowContainerRegistryOutbound'
        properties: {
          priority: 120
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureContainerRegistry'
          destinationPortRange: '443'
        }
      }
      {
        name: 'AllowRegistryLayerStorageOutbound'
        properties: {
          priority: 125
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'Storage.${location}'
          destinationPortRange: '443'
        }
      }
      {
        // Container Appsの基盤コンテナ(MCR)
        name: 'AllowMicrosoftContainerRegistryOutbound'
        properties: {
          priority: 130
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'MicrosoftContainerRegistry'
          destinationPortRange: '443'
        }
      }
      {
        name: 'AllowFrontDoorFirstPartyOutbound'
        properties: {
          priority: 140
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureFrontDoor.FirstParty'
          destinationPortRange: '443'
        }
      }
      {
        name: 'AllowAzureMonitorOutbound'
        properties: {
          priority: 150
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureMonitor'
          destinationPortRange: '443'
        }
      }
      {
        name: 'DenyInternetOutbound'
        properties: {
          priority: 4000
          direction: 'Outbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: 'Internet'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource peNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-${namePrefix}-pe'
  location: location
  tags: tags
  properties: { securityRules: [] }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-${namePrefix}'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [ addressPrefix ] }
    subnets: [
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: cidrSubnet(addressPrefix, 26, 1)
          defaultOutboundAccess: false
          networkSecurityGroup: { id: peNsg.id }
          privateEndpointNetworkPolicies: 'Enabled'
        }
      }
      {
        // workload profiles環境の最小は/27。Jobの並列実行に備えて/23を確保する
        name: 'snet-cae'
        properties: {
          addressPrefix: cidrSubnet(addressPrefix, 23, 1)
          defaultOutboundAccess: false
          networkSecurityGroup: { id: caeNsg.id }
          natGateway: { id: nat.id }
          delegations: [
            { name: 'cae', properties: { serviceName: 'Microsoft.App/environments' } }
          ]
        }
      }
    ]
  }
}

resource dnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for zone in privateDnsZoneNames: {
  name: zone
  location: 'global'
  tags: tags
}]

resource dnsLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (zone, i) in privateDnsZoneNames: {
  parent: dnsZones[i]
  name: 'link-${namePrefix}'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}]

output vnetId string = vnet.id
output privateEndpointSubnetId string = vnet.properties.subnets[0].id
output containerAppsSubnetId string = vnet.properties.subnets[1].id
output postgresDnsZoneId string = dnsZones[0].id
output blobDnsZoneId string = dnsZones[1].id
output queueDnsZoneId string = dnsZones[2].id
output keyVaultDnsZoneId string = dnsZones[3].id
