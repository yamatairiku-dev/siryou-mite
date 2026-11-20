// 撮影サービス(services/preview-renderer、設計 §7.5, §7.6, §8, §9.5)。
// Azure Container Instances(ACI、標準SKU)で常駐させる。
//
// ACIに置く理由(Q-066): Container AppsのJobではseccompによりChromium sandboxを有効にできない。
// sandboxが使えたdynamic sessions(カスタムコンテナのセッションプール)は、待機セッションを
// 最低1つ置く必要があり、専用のE16インスタンスが常時課金される(stagingで約245円/時)。
// ACIの標準SKUではsandbox有効のままChromiumを起動できる(2026-11-15に確認)。
//
// - snet-aciへプライベートIPで置く。IPはACIが割り当てる(VNet内のACIはIPを指定できず、
//   指定しても無視される。2026-11-20にstagingで確認)。割り当てられたIPをendpointとして出力し、
//   Preview Jobへ渡す。コンテナグループが別のホストへ移されるとIPが変わることがあり、その場合は
//   再デプロイするまでプレビュー生成が失敗する(preview-failedアラートで気付く、docs/OPERATIONS.md)
// - NSGでPreview Job(snet-cae)からのHTTPSだけを受け付け、外向きの通信はすべて拒否する
//   (infra/modules/network.bicep)
// - 証明書のSANはIPではなく固定のDNS名にし、Preview Jobはその名前で検証する(DNSには登録しない)
// - 自己署名証明書でHTTPSを待ち受け、共有トークンで呼び出し元を確かめる(設計 §9.5)。
//   秘密鍵とトークンはsecure環境変数で渡す(リソースのプロパティにもデプロイ履歴にも出ない)
// - Managed IdentityはACRからのimage取得にだけ使う。Queue・DB・Blob・Key Vaultの権限は持たない
// - 撮影のたびにChromiumを起動し直す。コンテナ自体は使い回す(資料ごとの分離は行わない。
//   sandboxが破られた場合の残留リスクは受け入れた。Q-066)

param namePrefix string
param location string
param tags object
@description('ACIへ委任したサブネット(snet-aci)')
param subnetId string
param rendererPort int
param logAnalyticsCustomerId string
@secure()
param logAnalyticsSharedKey string

@description('撮影サービス専用のManaged Identity({ id, ... })。ACRからのimage取得にだけ使う')
param identity object
param registryLoginServer string
param rendererImage string

@description('撮影サービスのTLS証明書(PEM、秘密値ではない)')
param tlsCertificate string
@secure()
@description('撮影サービスのTLS秘密鍵(PEM)')
param tlsPrivateKey string
@secure()
@description('Preview Jobとの共有トークン')
param authToken string

resource renderer 'Microsoft.ContainerInstance/containerGroups@2023-05-01' = {
  name: 'ci-${namePrefix}-renderer'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    sku: 'Standard'
    osType: 'Linux'
    restartPolicy: 'Always'
    subnetIds: [ { id: subnetId } ]
    ipAddress: {
      type: 'Private'
      ports: [ { port: rendererPort, protocol: 'TCP' } ]
    }
    imageRegistryCredentials: [
      { server: registryLoginServer, identity: identity.id }
    ]
    containers: [
      {
        name: 'renderer'
        properties: {
          image: rendererImage
          ports: [ { port: rendererPort, protocol: 'TCP' } ]
          // 設計 §7.6: 1 vCPU、2GB
          resources: { requests: { cpu: 1, memoryInGB: 2 } }
          environmentVariables: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: string(rendererPort) }
            { name: 'RENDERER_TLS_CERT', value: tlsCertificate }
            { name: 'RENDERER_TLS_KEY', secureValue: tlsPrivateKey }
            { name: 'RENDERER_AUTH_TOKEN', secureValue: authToken }
          ]
          livenessProbe: {
            httpGet: { path: '/health', port: rendererPort, scheme: 'https' }
            initialDelaySeconds: 10
            periodSeconds: 30
            timeoutSeconds: 3
            failureThreshold: 3
          }
        }
      }
    ]
    diagnostics: {
      logAnalytics: {
        workspaceId: logAnalyticsCustomerId
        workspaceKey: logAnalyticsSharedKey
        logType: 'ContainerInstanceLogs'
      }
    }
  }
}

output containerGroupName string = renderer.name
output endpoint string = 'https://${renderer.properties.ipAddress.ip}:${rendererPort}'
