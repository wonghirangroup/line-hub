import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { RoleCode } from './types.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4100),
  HOST: z.string().default('0.0.0.0'),
  HUB_STORE: z.enum(['prisma', 'memory']).default('prisma'),
  DATABASE_URL: z.string().optional(),
  LINE_CHANNEL_SECRET: z.string().min(1, 'ต้องตั้ง LINE_CHANNEL_SECRET (Messaging API ของ OA)'),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1, 'ต้องตั้ง LINE_CHANNEL_ACCESS_TOKEN'),
  // LINE Login channel ที่ LIFF ของ Hub อยู่ (DemoWebsite) — ใช้ตรวจ ID token
  HUB_LINE_LOGIN_CHANNEL_ID: z.string().min(1, 'ต้องตั้ง HUB_LINE_LOGIN_CHANNEL_ID'),
  HUB_VERIFY_LIFF_ID: z.string().default(''),
  // โทเค็นของแอดมิน (ชั่วคราวจนกว่าเฟส 3 จะมีหน้าแอดมินล็อกอินด้วย LINE) — ยาวและสุ่ม
  // true = ใส่รหัสผ่านถูกแล้ว ยังต้องให้ superadmin กดอนุมัติอีกครั้ง · false (ค่าเริ่มต้น) = การที่ superadmin ออกรหัสให้ถือเป็นการอนุมัติแล้ว
  HUB_REQUIRE_APPROVAL: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  HUB_ADMIN_TOKEN: z.string().min(24, 'HUB_ADMIN_TOKEN ต้องยาวอย่างน้อย 24 ตัว'),
  HUB_RICHMENU_CONFIG: z.string().default(path.resolve(HERE, '..', '..', 'richmenu.config.json')),
})
export type Env = z.infer<typeof EnvSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const r = EnvSchema.safeParse(source)
  if (!r.success) {
    throw new Error('ค่า environment ไม่ครบ/ไม่ถูกต้อง:\n' + r.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n'))
  }
  if (r.data.HUB_STORE === 'prisma' && !r.data.DATABASE_URL) throw new Error('HUB_STORE=prisma ต้องตั้ง DATABASE_URL')
  return r.data
}

// ── ชุดเมนูตามบทบาท (อ่านจาก richmenu.config.json ตัวเดียวกับสคริปต์สร้างเมนู) ──
export interface MenuSet { alias: string; tabs: string[]; roles: RoleCode[] }
export interface MenuSets { sets: Record<string, MenuSet>; tabs?: { id: string; label: string }[]; tabBarHeight?: number }

export function loadMenuSets(file: string): MenuSets {
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as { sets: Record<string, MenuSet>; tabs?: { id: string; label: string }[]; tabBarHeight?: number }
  if (!cfg.sets) throw new Error(`${file} ไม่มี "sets"`)
  return { sets: cfg.sets, tabs: cfg.tabs?.map(t => ({ id: t.id, label: t.label })), tabBarHeight: cfg.tabBarHeight }
}

/** alias ของเมนูแรกของชุดที่บทบาทนี้ควรได้ · admin ชนะ member · ไม่ตรงชุดไหน = null (ใช้เมนู guest) */
export function entryAliasForRoles(menu: MenuSets, roles: RoleCode[]): string | null {
  for (const id of ['admin', 'member']) {
    const set = menu.sets[id]
    if (set && set.roles.some(r => roles.includes(r))) return `${set.alias}-${set.tabs[0]}`
  }
  return null
}
