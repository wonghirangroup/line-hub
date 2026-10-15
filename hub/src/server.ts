import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { loadEnv, loadMenuSets } from './config.js'
import { LineClient } from './line.js'
import { MenuService } from './menu-service.js'
import { HubService } from './service.js'
import { MemoryStore } from './store/memory.js'
import type { Store } from './types.js'

// โหลด .env ถ้ามี (Node 20.12+) — ค้นที่ hub/.env แล้วค่อย ../.env
const HERE = path.dirname(fileURLToPath(import.meta.url))
for (const f of [path.resolve(HERE, '..', '.env'), path.resolve(HERE, '..', '..', '.env')]) {
  if (existsSync(f)) { process.loadEnvFile(f); break }
}

const env = loadEnv()
const menu = loadMenuSets(env.HUB_RICHMENU_CONFIG)

let store: Store
if (env.HUB_STORE === 'memory') {
  store = new MemoryStore()
  console.warn('[hub] ใช้ MemoryStore — ข้อมูลหายเมื่อรีสตาร์ท (ใช้ทดลองเท่านั้น)')
} else {
  const { PrismaStore } = await import('./store/prisma.js')
  const ps = new PrismaStore()
  await ps.ensureRoles()
  store = ps
}

const line = new LineClient({ accessToken: env.LINE_CHANNEL_ACCESS_TOKEN, loginChannelId: env.HUB_LINE_LOGIN_CHANNEL_ID })
const service = new HubService(store, line, menu, { requireApproval: env.HUB_REQUIRE_APPROVAL })
const menus = new MenuService(store, line, menu, service)
const app = buildApp({
  service, menus, store, line,
  channelSecret: env.LINE_CHANNEL_SECRET,
  adminToken: env.HUB_ADMIN_TOKEN,
  verifyLiffId: env.HUB_VERIFY_LIFF_ID,
  corsOrigins: (process.env.HUB_CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  logger: true,
})

await app.listen({ port: env.PORT, host: env.HOST })
