// ข้อมูลสำหรับหน้า monitor: สรุปผู้ใช้ รหัส คำขอ เมนู + สถานะการเชื่อมต่อ LINE + การแจ้งเตือน
import type { LineApi, Store } from './types.js'

export interface Alert { level: 'error' | 'warn' | 'info'; code: string; message: string }

const bangkokDay = (d: Date) => new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10)
const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('หมดเวลา')), ms))])

export interface MonitorOptions { storeKind: string; version: string; startedAt: Date; now?: () => Date; lineCacheMs?: number; maxCodeFailures?: number }

export class MonitorService {
  private now: () => Date
  private lineCache: { at: number; data: LineStatus } | null = null

  constructor(private store: Store, private line: LineApi, private o: MonitorOptions) {
    this.now = o.now ?? (() => new Date())
  }

  /** สถานะฝั่ง LINE (cache สั้นๆ กันยิง API ถี่เวลาเปิดหน้าซ้ำ/รีเฟรชอัตโนมัติ) */
  private async lineStatus(): Promise<LineStatus> {
    const t = Date.now()
    if (this.lineCache && t - this.lineCache.at < (this.o.lineCacheMs ?? 20_000)) return this.lineCache.data
    const [bot, hook, menus] = await Promise.allSettled([withTimeout(this.line.botInfo(), 6000), withTimeout(this.line.webhookEndpoint(), 6000), withTimeout(this.line.listMenus(), 6000)])
    const errors: string[] = []
    if (bot.status === 'rejected') errors.push('ข้อมูล OA: ' + shortErr(bot.reason))
    if (hook.status === 'rejected') errors.push('webhook: ' + shortErr(hook.reason))
    if (menus.status === 'rejected') errors.push('รายการเมนู: ' + shortErr(menus.reason))
    const data: LineStatus = {
      ok: errors.length === 0,
      bot: bot.status === 'fulfilled' ? bot.value : null,
      webhook: hook.status === 'fulfilled' ? hook.value : null,
      oaMenus: menus.status === 'fulfilled' ? menus.value.filter(m => m.name.startsWith('sjhub:')).length : null,
      errors,
    }
    this.lineCache = { at: t, data }
    return data
  }

  async snapshot() {
    const now = this.now()
    const maxFail = this.o.maxCodeFailures ?? 5
    const alerts: Alert[] = []

    // ฐานข้อมูล (ถ้าอ่านไม่ได้ ถือว่าล่ม และคืนเท่าที่รู้)
    let db = { ok: true, error: '' }
    let users: Awaited<ReturnType<Store['listUsers']>> = []
    let pending = 0, apps: Awaited<ReturnType<Store['listApps']>> = [], menus: Awaited<ReturnType<Store['listRichMenus']>> = [], attempts: { success: boolean; at: Date }[] = []
    const roleCounts: Record<string, number> = {}
    try {
      users = await this.store.listUsers()
      pending = (await this.store.listRequests('PENDING')).length
      apps = await this.store.listApps()
      menus = await this.store.listRichMenus()
      attempts = await this.store.attemptsSince(new Date(now.getTime() - 7 * 24 * 3600 * 1000))
      for (const u of users.filter(x => x.status !== 'INACTIVE')) {
        for (const r of new Set((await this.store.getRoles(u.id)).map(x => x.roleCode))) roleCounts[r] = (roleCounts[r] ?? 0) + 1
      }
    } catch (e) {
      db = { ok: false, error: shortErr(e) }
      alerts.push({ level: 'error', code: 'db', message: 'อ่านฐานข้อมูลไม่ได้: ' + db.error })
    }

    const count = (s: string) => users.filter(u => u.status === s).length
    const holders = users.filter(u => u.activationHash)
    const codes = {
      outstanding: holders.filter(u => u.activationExpiresAt && u.activationExpiresAt > now && u.activationFailed < maxFail).length,
      expiringSoon: holders.filter(u => u.activationExpiresAt && u.activationExpiresAt > now && u.activationExpiresAt.getTime() < now.getTime() + 24 * 3600 * 1000 && u.activationFailed < maxFail).length,
      expired: holders.filter(u => !u.activationExpiresAt || u.activationExpiresAt <= now).length,
      locked: holders.filter(u => u.activationFailed >= maxFail).length,
      invitedWithoutCode: users.filter(u => u.status === 'INVITED' && !u.activationHash).length,
    }

    // ความพยายามยืนยันตัวตน 7 วันล่าสุด (วันตามเวลาไทย)
    const days: { date: string; ok: number; fail: number }[] = []
    for (let i = 6; i >= 0; i--) days.push({ date: bangkokDay(new Date(now.getTime() - i * 24 * 3600 * 1000)), ok: 0, fail: 0 })
    for (const a of attempts) { const d = days.find(x => x.date === bangkokDay(a.at)); if (d) { if (a.success) d.ok++; else d.fail++ } }
    const since24 = now.getTime() - 24 * 3600 * 1000
    const last24h = { ok: attempts.filter(a => a.success && a.at.getTime() >= since24).length, fail: attempts.filter(a => !a.success && a.at.getTime() >= since24).length }

    const published = menus.map(m => m.publishedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
    const menuInfo = { total: menus.length, withImage: menus.filter(m => m.hasImage).length, dirty: menus.filter(m => m.dirty).length, lastPublishedAt: published }

    const line = await this.lineStatus()

    // การแจ้งเตือน
    if (!line.ok) alerts.push({ level: 'error', code: 'line', message: 'เชื่อมต่อ LINE ไม่ครบ: ' + line.errors.join(' · ') })
    if (line.webhook && !line.webhook.active) alerts.push({ level: 'warn', code: 'webhook', message: 'ยังไม่ได้เปิด "Use webhook" ใน LINE Developers Console (Hub จะไม่ได้รับเหตุการณ์เพิ่มเพื่อน)' })
    if (line.webhook && line.webhook.endpoint === '') alerts.push({ level: 'warn', code: 'webhook-url', message: 'ยังไม่ได้ตั้ง Webhook URL' })
    if (pending > 0) alerts.push({ level: 'warn', code: 'pending', message: `มีคำขอยืนยันตัวตนรออนุมัติ ${pending} รายการ` })
    if (codes.locked > 0) alerts.push({ level: 'warn', code: 'locked', message: `มีรหัสผ่านที่ถูกล็อก (ใส่ผิดเกินกำหนด) ${codes.locked} คน — ต้องออกรหัสใหม่ให้` })
    if (codes.expiringSoon > 0) alerts.push({ level: 'info', code: 'expiring', message: `มีรหัสผ่านที่จะหมดอายุใน 24 ชั่วโมง ${codes.expiringSoon} คน` })
    if (codes.invitedWithoutCode > 0) alerts.push({ level: 'info', code: 'no-code', message: `มีพนักงาน ${codes.invitedWithoutCode} คนที่ยังไม่ได้รับรหัสผ่าน` })
    if (menuInfo.dirty > 0) alerts.push({ level: 'info', code: 'menu-dirty', message: `เมนู LINE มี ${menuInfo.dirty} ชุดที่แก้ไขแล้วแต่ยังไม่เผยแพร่` })
    if (menuInfo.total > 0 && line.oaMenus === 0) alerts.push({ level: 'warn', code: 'menu-missing', message: 'ยังไม่มีเมนูของ Hub ใน OA — กดเผยแพร่เมนูที่หน้า "เมนู LINE"' })
    if (last24h.fail >= 10) alerts.push({ level: 'warn', code: 'verify-fails', message: `มีการยืนยันตัวตนล้มเหลว ${last24h.fail} ครั้งใน 24 ชั่วโมง — อาจมีคนเดารหัส` })
    if (db.ok && alerts.length === 0) alerts.push({ level: 'info', code: 'all-ok', message: 'ทุกอย่างปกติ' })

    return {
      generatedAt: now,
      uptimeSec: Math.round((now.getTime() - this.o.startedAt.getTime()) / 1000),
      version: this.o.version,
      storeKind: this.o.storeKind,
      db,
      users: { total: users.length, active: count('ACTIVE'), invited: count('INVITED'), inactive: count('INACTIVE') },
      roles: roleCounts,
      codes,
      requests: { pending },
      attempts: { last24h, days },
      apps: { total: apps.length, active: apps.filter(a => a.active).length },
      menus: menuInfo,
      line,
      alerts,
    }
  }
}

export interface LineStatus {
  ok: boolean
  bot: { displayName: string; basicId: string } | null
  webhook: { endpoint: string; active: boolean } | null
  oaMenus: number | null
  errors: string[]
}

function shortErr(e: unknown): string {
  const raw = (e instanceof Error ? e.message : String(e)).replace(/Bearer\s+\S+/g, 'Bearer ***')
  // ข้อความจาก LINE → ภาษาที่อ่านง่าย (ไม่โชว์ JSON ดิบ)
  const status = /→ (\d{3})/.exec(raw)?.[1]
  if (status === '401') return 'access token ไม่ถูกต้องหรือถูกยกเลิก (ออกใหม่ที่ LINE Developers Console แล้วอัปเดต .env)'
  if (status === '403') return 'ไม่มีสิทธิ์เรียก API นี้ (403)'
  if (status === '429') return 'เรียก LINE ถี่เกินไป (429) — รอสักครู่'
  if (status && status.startsWith('5')) return 'LINE ขัดข้องชั่วคราว (' + status + ')'
  return raw.slice(0, 160)
}
