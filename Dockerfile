FROM node:24.14-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24.14-alpine AS build
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
# Web(build/client, build/server)とservices(build/services)の両方を同じimageへ入れる。
# Web・Display・Migration・MaintenanceでNode.js imageは1種類だけ使い、起動commandで
# 実行単位を切り替える(設計 §7.6)。`npm run build`がbuild/を作り直すため順序は固定。
RUN npm run build && npm run build:services

FROM node:24.14-alpine AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24.14-alpine
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/build ./build
RUN chown -R node:node /app
USER node
EXPOSE 8080
# 既定commandはWeb(App Service)。Display・Migration・MaintenanceはContainer Apps側で
# commandを差し替える(例: Displayは `node build/services/display/index.js`、設計 §7.6)。
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "node_modules/@react-router/serve/bin.cjs", "./build/server/index.js"]
