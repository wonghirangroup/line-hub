FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl   # Prisma ต้องใช้ openssl
COPY hub/package*.json ./hub/
RUN cd hub && npm ci
COPY hub ./hub
COPY richmenu.config.json ./richmenu.config.json
RUN cd hub && npx prisma generate && npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
COPY --from=build /app/hub/package*.json ./hub/
RUN cd hub && npm ci --omit=dev
COPY --from=build /app/hub/node_modules/.prisma ./hub/node_modules/.prisma
COPY --from=build /app/hub/dist ./hub/dist
COPY hub/public ./hub/public
COPY hub/prisma ./hub/prisma
COPY richmenu.config.json ./richmenu.config.json
EXPOSE 4100
CMD ["sh", "-c", "cd hub && npx prisma migrate deploy && node dist/server.js"]
