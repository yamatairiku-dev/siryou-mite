// 実行単位ごとのuser-assigned Managed Identity(設計 §7.4「Web、Display、Preview、
// Maintenanceは別々のManaged Identity」、Migration・DB初期設定も専用)。
// identityの名前はPostgreSQL上のrole名にもなる(DB初期設定Jobがobject IDで作る)。

param namePrefix string
param location string
param tags object

resource web 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-web'
  location: location
  tags: tags
}

resource display 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-display'
  location: location
  tags: tags
}

resource preview 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-preview'
  location: location
  tags: tags
}

resource maintenance 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-maintenance'
  location: location
  tags: tags
}

resource migrate 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-migrate'
  location: location
  tags: tags
}

resource dbadmin 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-dbadmin'
  location: location
  tags: tags
}

output identities object = {
  web: {
    id: web.id
    name: web.name
    clientId: web.properties.clientId
    principalId: web.properties.principalId
  }
  display: {
    id: display.id
    name: display.name
    clientId: display.properties.clientId
    principalId: display.properties.principalId
  }
  preview: {
    id: preview.id
    name: preview.name
    clientId: preview.properties.clientId
    principalId: preview.properties.principalId
  }
  maintenance: {
    id: maintenance.id
    name: maintenance.name
    clientId: maintenance.properties.clientId
    principalId: maintenance.properties.principalId
  }
  migrate: {
    id: migrate.id
    name: migrate.name
    clientId: migrate.properties.clientId
    principalId: migrate.properties.principalId
  }
  dbadmin: {
    id: dbadmin.id
    name: dbadmin.name
    clientId: dbadmin.properties.clientId
    principalId: dbadmin.properties.principalId
  }
}
