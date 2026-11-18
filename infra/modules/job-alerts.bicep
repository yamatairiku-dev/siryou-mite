// Container Apps Jobの失敗通知(設計 §17「Preview・Migration・Maintenance Jobの失敗」)。
//
// Log Analyticsのログ検索アラートで、Action Group(運用担当者の共有メールアドレス)へ通知する。
//
// - Migration・Maintenance・DB初期設定: 実行の失敗(終了コード0以外、実行上限の超過)。
//   いずれもJob側の再試行は0(`replicaRetryLimit: 0`)なので、失敗した実行ごとに
//   `BackoffLimitExceeded`がシステムログへ出る。実行上限の超過は`DeadlineExceeded`
// - Preview: 終了コード1は「Queueの再配信で再試行する」という意味でも使う(OPERATIONS
//   「Preview Job」)。再試行のたびに通知しないよう、運用ログの恒久失敗
//   (`preview_generation_failed`: 3回目の失敗でプレビューを`failed`にした)と、
//   想定外の例外(`preview_job_failed`)だけを対象にする。実行上限の超過は上と同じく通知する
//
// 環境を作った直後はログのtableがまだ無いため、クエリの事前検証は行わない
// (`skipQueryValidation`)。

param namePrefix string
param location string
param tags object
@description('Log AnalyticsワークスペースのリソースID')
param logAnalyticsWorkspaceId string
param actionGroupId string
@description('container-apps.bicepの出力jobNames(preview・maintenance・migrate・dbBootstrap)')
param jobNames object

var previewJobName = jobNames.preview
var executionJobNames = [
  jobNames.preview
  jobNames.maintenance
  jobNames.migrate
  jobNames.dbBootstrap
]

// 15分ごとに直近15分を調べる。1件でもあれば、Jobごと(またはイベントごと)に通知する。
var schedule = {
  evaluationFrequency: 'PT15M'
  windowSize: 'PT15M'
}

var rules = [
  {
    name: 'alert-${namePrefix}-job-execution-failed'
    displayName: '${namePrefix}: Jobの実行失敗'
    description: 'Migration・Maintenance・DB初期設定Jobの実行が失敗した、またはいずれかのJobが実行上限を超えた(設計 §17)。ContainerAppSystemLogs_CLとJobのログで原因を確認する'
    dimension: 'JobName_s'
    // 複数行文字列は補間できないため、{jobs}・{preview}をあとで置き換える
    query: '''
let jobs = dynamic({jobs});
ContainerAppSystemLogs_CL
| where JobName_s in (jobs)
| where Reason_s == "DeadlineExceeded"
    or (Reason_s == "BackoffLimitExceeded" and JobName_s != "{preview}")
| summarize Failures = count() by JobName_s
'''
  }
  {
    name: 'alert-${namePrefix}-preview-failed'
    displayName: '${namePrefix}: プレビュー生成の恒久失敗'
    description: 'プレビュー生成が3回失敗してfailedになった、またはPreview Jobが想定外の例外で終了した(設計 §17)。直前のpreview_capture_failedのreasonで原因を確認する'
    dimension: 'Event'
    query: '''
ContainerAppConsoleLogs_CL
| where ContainerJobName_s == "{preview}"
| extend Event = tostring(parse_json(Log_s).event)
| where Event in ("preview_generation_failed", "preview_job_failed")
| summarize Failures = count() by Event
'''
  }
]

resource alerts 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = [for rule in rules: {
  name: rule.name
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: rule.displayName
    description: rule.description
    severity: 2
    enabled: true
    scopes: [ logAnalyticsWorkspaceId ]
    evaluationFrequency: schedule.evaluationFrequency
    windowSize: schedule.windowSize
    skipQueryValidation: true
    // 失敗ごとに通知する(解決の通知は送らない)。評価の窓と間隔が同じなので、同じ失敗を
    // 二重に通知しない
    autoMitigate: false
    criteria: {
      allOf: [
        {
          query: replace(replace(rule.query, '{jobs}', string(executionJobNames)), '{preview}', previewJobName)
          timeAggregation: 'Total'
          metricMeasureColumn: 'Failures'
          operator: 'GreaterThan'
          threshold: 0
          dimensions: [
            { name: rule.dimension, operator: 'Include', values: [ '*' ] }
          ]
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [ actionGroupId ]
    }
  }
}]

output alertRuleNames array = [for (rule, i) in rules: alerts[i].name]
