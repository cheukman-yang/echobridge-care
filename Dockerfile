# Cloud Run用。画面（Next.js）と通話のWebSocketを1つのNodeプロセスで配る（server/index.ts）。
# 認証はCloud Runのサービスアカウント（ADC）を使い、鍵や .env はイメージに入れない。

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
  && rm -rf .next/cache \
  && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src ./src
USER node
# Cloud Runが PORT（既定8080）を渡す。
EXPOSE 8080
# npmを挟まず、SIGTERMをNodeが直接受け取る。
CMD ["node", "--import", "tsx", "server/index.ts"]
