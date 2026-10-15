import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadMenuSets } from '../src/config.js'
import { imageInfo } from '../src/image.js'
import { MenuService } from '../src/menu-service.js'
import { MonitorService } from '../src/monitor.js'
import { canAccess, checkActivation, generateActivationCode, hashActivation, HubService, normalizePhone } from '../src/service.js'
import { MemoryStore } from '../src/store/memory.js'
import { HttpError, type LineApi, type LineIdentity } from '../src/types.js'

const ADMIN = 'a'.repeat(32)
const SECRET = 'channel-secret'

class FakeLine implements LineApi {
  links = new Map<string, string>()
  failLink = false
  aliases = new Set(['tab-m-staff', 'tab-a-staff'])
  async verifyIdToken(idToken: string): Promise<LineIdentity> {
    const m = /^tok:([^:]+):(.*)$/.exec(idToken)
    if (!m) throw new HttpError(401, 'bad token', 'INVALID_ID_TOKEN')
    return { sub: m[1]!, name: m[2] || null }
  }
  async getAliasMenuId(alias: string) { return this.aliases.has(alias) ? `menu:${alias}` : null }
  async linkMenu(uid: string, menuId: string) { if (this.failLink) throw new Error('LINE down'); this.links.set(uid, menuId) }
  async unlinkMenu(uid: string) { this.links.delete(uid) }
  // ── ข้อมูลสถานะ OA ──
  bot = { displayName: 'SJ-Webapp/Demo', basicId: '@test' }
  hook = { endpoint: 'https://hub.example/webhook', active: true }
  failInfo = false
  infoCalls = 0
  async botInfo() { this.infoCalls++; if (this.failInfo) throw new Error('LINE GET /v2/bot/info → 401 Bearer abc.def'); return this.bot }
  async webhookEndpoint() { this.infoCalls++; return this.hook }
  // ── จำลองตัวเมนูใน OA ──
  oa = new Map<string, { name: string; body: any; image?: Buffer }>()
  aliasMap = new Map<string, string>()
  defaultId: string | null = null
  failUpload = false
  private n = 0
  async listMenus() { this.infoCalls++; return [...this.oa].map(([richMenuId, m]) => ({ richMenuId, name: m.name })) }
  async createMenu(body: any) { const id = 'rm' + ++this.n; this.oa.set(id, { name: body.name, body }); return id }
  async uploadMenuImage(id: string, data: Buffer) { if (this.failUpload) throw new Error('upload failed'); this.oa.get(id)!.image = data }
  async deleteMenu(id: string) { this.oa.delete(id) }
  async listAliases() { return [...this.aliasMap].map(([richMenuAliasId, richMenuId]) => ({ richMenuAliasId, richMenuId })) }
  async createAlias(alias: string, id: string) { if (this.aliasMap.has(alias)) throw new Error('alias exists'); this.aliasMap.set(alias, id); this.aliases.add(alias) }
  async deleteAlias(alias: string) { this.aliasMap.delete(alias) }
  async setDefaultMenu(id: string) { this.defaultId = id }
}

/** ภาพจำลอง: มีเฉพาะส่วนหัวที่บอกขนาด (พอให้ imageInfo อ่านได้) */
function png(w: number, h: number, pad = 2000) {
  const b = Buffer.alloc(33 + pad)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return b
}
function jpeg(w: number, h: number) {
  const b = Buffer.alloc(30)
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0; b.writeUInt16BE(17, 4); b[6] = 8
  b.writeUInt16BE(h, 7); b.writeUInt16BE(w, 9)
  return b
}

const tok = (uid: string, name = 'สมหญิง') => ({ authorization: `Bearer tok:${uid}:${name}` })
const adm = { authorization: `Bearer ${ADMIN}` }

function setup(opts: { requireApproval?: boolean } = {}) {
  const clock = { t: Date.parse('2026-10-15T00:00:00Z') }
  const store = new MemoryStore()
  store.now = () => new Date(clock.t)
  const line = new FakeLine()
  const menu = loadMenuSets(new URL('../../richmenu.config.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const service = new HubService(store, line, menu, { now: () => new Date(clock.t), requireApproval: opts.requireApproval })
  const menus = new MenuService(store, line, menu, service)
  const monitor = new MonitorService(store, line, { storeKind: 'memory', version: 'test', startedAt: new Date(clock.t), now: () => new Date(clock.t) })
  const app = buildApp({ service, menus, monitor, store, line, channelSecret: SECRET, adminToken: ADMIN, verifyLiffId: '2010195603-test', corsOrigins: ['https://allapp.example'] })
  return { store, line, service, menus, monitor, app, clock }
}
type T = ReturnType<typeof setup>

async function importRoster(t: T) {
  const r = await t.app.inject({
    method: 'POST', url: '/api/admin/users/import', headers: adm,
    payload: { users: [
      { employee_code: 'e001', display_name: 'สมหญิง ใจดี', phone: '081-234-5678' },
      { employee_code: 'E002', display_name: 'สมชาย ผู้จัดการ', phone: '+66 89 999 0000', roles: ['admin'] },
      { employee_code: 'S001', display_name: 'ซูเปอร์ แอดมิน', phone: '0877777777', roles: ['superadmin'] },
    ] },
  })
  expect(r.statusCode).toBe(200)
  return r.json().data as { created: number; updated: number }
}

/** superadmin ออกรหัสให้ผ่านทางโทเค็นกลาง (ใช้ในเทสต์) — คืนรหัสจริง */
async function issue(t: T, code: string, hours?: number) {
  const u = (await t.store.findUserByCode(code))!
  const r = await t.app.inject({ method: 'POST', url: `/api/admin/users/${u.id}/activation-code`, headers: adm, payload: hours ? { hours } : {} })
  expect(r.statusCode).toBe(200)
  return r.json().data.code as string
}

const verify = (t: T, uid: string, code: string, phone: string, password: string) =>
  t.app.inject({ method: 'POST', url: '/api/verify/request', headers: tok(uid), payload: { employee_code: code, phone, password } })

/** ออกรหัส → พนักงานยืนยัน → (ถ้าต้องอนุมัติ) อนุมัติ */
async function onboard(t: T, uid: string, code: string, phone: string) {
  const pw = await issue(t, code)
  const r = await verify(t, uid, code, phone, pw)
  expect(r.statusCode).toBe(200)
  if (r.json().data.status === 'PENDING') {
    const req = (await t.store.listRequests('PENDING')).find(x => x.lineUserId === uid)!
    expect((await t.app.inject({ method: 'POST', url: `/api/admin/verification-requests/${req.id}/approve`, headers: adm })).statusCode).toBe(200)
  }
}

describe('รหัสผ่านเปิดใช้งานที่ superadmin สุ่มให้', () => {
  it('รูปแบบ XXXX-XXXX ไม่มีตัวอักษรสับสน · แฮชตรวจได้ · พิมพ์เล็ก/ไม่มีขีดก็ใช้ได้ · รหัสผิดไม่ผ่าน', () => {
    for (let i = 0; i < 50; i++) expect(generateActivationCode()).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/)
    const code = generateActivationCode()
    const h = hashActivation(code)
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(h).not.toContain(code.replace('-', ''))
    expect(checkActivation(code, h)).toBe(true)
    expect(checkActivation(code.toLowerCase().replace('-', ' '), h)).toBe(true)
    expect(checkActivation('AAAA-AAAA', h)).toBe(false)
    expect(checkActivation(code, null)).toBe(false)
    expect(hashActivation(code)).not.toBe(h) // salt ต่างกัน
  })

  it('ค่าเริ่มต้น: ใส่รหัสถูกแล้วใช้ได้เลย (การออกรหัสคืออนุมัติ) ผูกเมนูพนักงาน และบันทึกว่าใครอนุมัติ', async () => {
    const t = setup()
    await importRoster(t)
    const u = (await t.store.findUserByCode('E001'))!
    const issued = await t.app.inject({ method: 'POST', url: `/api/admin/users/${u.id}/activation-code`, headers: { ...adm, 'x-admin-name': 'net' }, payload: {} })
    const pw = issued.json().data.code as string
    expect(pw).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/)

    const r = await verify(t, 'U1', ' e001 ', '081 234 5678', pw.toLowerCase())
    expect(r.statusCode).toBe(200)
    expect(r.json().data.status).toBe('APPROVED')
    expect(t.line.links.get('U1')).toBe('menu:tab-m-staff')
    const approved = (await t.store.listRequests('APPROVED'))[0]!
    expect(approved.decidedBy).toBe('token:net') // ผู้ออกรหัสคือผู้อนุมัติ
    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: tok('U1') })).json().data
    expect(me.roles).toEqual(['staff'])
  })

  it('รหัสใช้ได้ครั้งเดียว — คนอื่นเอารหัสเดิมไปใช้ซ้ำไม่ได้', async () => {
    const t = setup()
    await importRoster(t)
    const pw = await issue(t, 'E001')
    expect((await verify(t, 'U1', 'E001', '0812345678', pw)).statusCode).toBe(200)
    expect((await verify(t, 'U9', 'E001', '0812345678', pw)).statusCode).toBe(422)
    expect(t.line.links.has('U9')).toBe(false)
  })

  it('ผิดข้อใดข้อหนึ่ง (รหัสพนักงาน/เบอร์/รหัสผ่าน) → ข้อความเดียวกัน ไม่บอกว่าผิดช่องไหน', async () => {
    const t = setup()
    await importRoster(t)
    const pw = await issue(t, 'E001')
    const msgs = new Set<string>()
    for (const [c, p, w] of [['E001', '0800000000', pw], ['NOPE', '0812345678', pw], ['E001', '0812345678', 'AAAA-AAAA']] as const) {
      const r = await verify(t, 'U3', c, p, w)
      expect(r.statusCode).toBe(422)
      msgs.add(r.json().error.message)
    }
    expect(msgs.size).toBe(1)
  })

  it('รู้รหัสพนักงานกับเบอร์ แต่ไม่มีรหัสผ่านจาก superadmin → เข้าไม่ได้', async () => {
    const t = setup()
    await importRoster(t)
    const r = await verify(t, 'U1', 'E001', '0812345678', 'AAAA-AAAA')
    expect(r.statusCode).toBe(422)
    expect(await t.store.findUserByLineId('U1')).toBeNull()
  })

  it('ไม่ส่งรหัสผ่านมา → 400', async () => {
    const t = setup()
    const r = await t.app.inject({ method: 'POST', url: '/api/verify/request', headers: tok('U1'), payload: { employee_code: 'E001', phone: '0812345678' } })
    expect(r.statusCode).toBe(400)
  })

  it('รหัสหมดอายุ → ใช้ไม่ได้ จนกว่าจะออกใหม่', async () => {
    const t = setup()
    await importRoster(t)
    const pw = await issue(t, 'E001', 24)
    t.clock.t += 25 * 3600 * 1000
    expect((await verify(t, 'U1', 'E001', '0812345678', pw)).statusCode).toBe(422)
    const pw2 = await issue(t, 'E001', 24)
    expect((await verify(t, 'U1', 'E001', '0812345678', pw2)).statusCode).toBe(200)
  })

  it('ผิดรหัสผ่าน 5 ครั้ง → รหัสถูกล็อก แม้ใส่ถูกก็ใช้ไม่ได้ ต้องให้ superadmin ออกใหม่ (ใช้ LINE คนละบัญชีก็ไม่ช่วย)', async () => {
    const t = setup()
    await importRoster(t)
    const pw = await issue(t, 'E001')
    for (let i = 0; i < 5; i++) {
      expect((await verify(t, `X${i}`, 'E001', '0812345678', 'AAAA-AAAA')).statusCode).toBe(422)
    }
    expect((await verify(t, 'U1', 'E001', '0812345678', pw)).statusCode).toBe(422)
    const pw2 = await issue(t, 'E001')
    expect((await verify(t, 'U1', 'E001', '0812345678', pw2)).statusCode).toBe(200)
  })

  it('บัญชี LINE เดียวกันลองผิด 5 ครั้งในหนึ่งชั่วโมง → 429', async () => {
    const t = setup()
    await importRoster(t)
    const pw = await issue(t, 'E001')
    for (let i = 0; i < 5; i++) expect((await verify(t, 'U4', 'NOPE', '0800000000', 'AAAA-AAAA')).statusCode).toBe(422)
    expect((await verify(t, 'U4', 'E001', '0812345678', pw)).statusCode).toBe(429)
  })

  it('ผูก LINE ไปแล้วออกรหัสใหม่ไม่ได้ (409) ต้องยกเลิกการผูกก่อน · ผู้ที่ผูกแล้วเปิดหน้ายืนยันซ้ำได้ APPROVED', async () => {
    const t = setup()
    await importRoster(t)
    await onboard(t, 'U1', 'E001', '0812345678')
    const u = (await t.store.findUserByCode('E001'))!
    expect((await t.app.inject({ method: 'POST', url: `/api/admin/users/${u.id}/activation-code`, headers: adm, payload: {} })).statusCode).toBe(409)
    const again = await verify(t, 'U1', 'E001', '0812345678', 'AAAA-AAAA')
    expect(again.json().data.status).toBe('APPROVED')
  })

  it('แฮชและรหัสผ่านไม่หลุดออกทาง API รายชื่อ', async () => {
    const t = setup()
    await importRoster(t)
    const pw = await issue(t, 'E001')
    const list = await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: adm })
    expect(list.body).not.toContain('scrypt')
    expect(list.body).not.toContain(pw)
    expect(list.json().data.find((u: { employeeCode: string }) => u.employeeCode === 'E001').hasActivationCode).toBe(true)
  })

  it('ออกรหัสให้ทุกคนที่ยังไม่ผูก (issue-all) — ข้ามคนที่ผูกแล้ว', async () => {
    const t = setup()
    await importRoster(t)
    await onboard(t, 'U1', 'E001', '0812345678')
    const r = await t.app.inject({ method: 'POST', url: '/api/admin/activation-codes/issue-all', headers: adm, payload: { hours: 48 } })
    const rows = r.json().data as { employee_code: string; code: string }[]
    expect(rows.map(x => x.employee_code).sort()).toEqual(['E002', 'S001'])
    expect(new Set(rows.map(x => x.code)).size).toBe(2)
  })
})

describe('โหมดต้องให้ superadmin กดอนุมัติอีกชั้น (HUB_REQUIRE_APPROVAL=true)', () => {
  it('ใส่รหัสถูก → PENDING ยังไม่ผูกเมนู → อนุมัติแล้วผูก และรหัสถูกใช้ไปแล้ว', async () => {
    const t = setup({ requireApproval: true })
    await importRoster(t)
    const pw = await issue(t, 'E001')
    const r = await verify(t, 'U1', 'E001', '0812345678', pw)
    expect(r.json().data.status).toBe('PENDING')
    expect(t.line.links.has('U1')).toBe(false)
    expect((await t.app.inject({ method: 'GET', url: '/api/verify/status', headers: tok('U1') })).json().data.status).toBe('PENDING')

    const id = (await t.store.listRequests('PENDING'))[0]!.id
    const ap = await t.app.inject({ method: 'POST', url: `/api/admin/verification-requests/${id}/approve`, headers: adm })
    expect(ap.json().data.menu).toEqual({ ok: true, menu: 'tab-m-staff' })
    expect((await t.app.inject({ method: 'POST', url: `/api/admin/verification-requests/${id}/approve`, headers: adm })).statusCode).toBe(409)
    expect((await verify(t, 'U8', 'E001', '0812345678', pw)).statusCode).toBe(422)
  })

  it('ปฏิเสธแล้วสถานะเป็น REJECTED และต้องออกรหัสใหม่', async () => {
    const t = setup({ requireApproval: true })
    await importRoster(t)
    const pw = await issue(t, 'E001')
    await verify(t, 'U1', 'E001', '0812345678', pw)
    const id = (await t.store.listRequests('PENDING'))[0]!.id
    await t.app.inject({ method: 'POST', url: `/api/admin/verification-requests/${id}/reject`, headers: adm })
    expect((await t.app.inject({ method: 'GET', url: '/api/verify/status', headers: tok('U1') })).json().data.status).toBe('REJECTED')
  })
})

describe('บทบาท / เมนู / ลาออก', () => {
  it('แอดมินได้เมนูชุด admin · เปลี่ยนบทบาทแล้วเมนูเปลี่ยนตาม · ถอดเหลือ guest เมนูถูกถอด', async () => {
    const t = setup()
    await importRoster(t)
    await onboard(t, 'U2', 'E002', '0899990000')
    expect(t.line.links.get('U2')).toBe('menu:tab-a-staff')
    await onboard(t, 'U1', 'E001', '0812345678')
    const user = (await t.store.findUserByLineId('U1'))!
    const up = await t.app.inject({ method: 'PUT', url: `/api/admin/users/${user.id}/roles`, headers: adm, payload: { roles: ['staff', 'admin', 'admin'] } })
    expect(up.json().data.menu.menu).toBe('tab-a-staff')
    expect((await t.store.getRoles(user.id)).length).toBe(2)
    await t.app.inject({ method: 'PUT', url: `/api/admin/users/${user.id}/roles`, headers: adm, payload: { roles: ['guest'] } })
    expect(t.line.links.has('U1')).toBe(false)
  })

  it('ยกเลิกการผูก (ลาออก): ถอดเมนู ล้าง LINE สถานะ INACTIVE · กลับมาได้ด้วยรหัสใหม่เท่านั้น', async () => {
    const t = setup()
    await importRoster(t)
    await onboard(t, 'U1', 'E001', '0812345678')
    const user = (await t.store.findUserByLineId('U1'))!
    const r = await t.app.inject({ method: 'POST', url: `/api/admin/users/${user.id}/unlink`, headers: adm })
    expect(r.json().data.user.status).toBe('INACTIVE')
    expect(t.line.links.has('U1')).toBe(false)
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: tok('U1') })).json().data.user).toBeNull()
    expect((await verify(t, 'U1', 'E001', '0812345678', 'AAAA-AAAA')).statusCode).toBe(422)
    await onboard(t, 'U1b', 'E001', '0812345678') // ออกรหัสใหม่ → กลับมาใช้ได้
    expect((await t.store.findUserByLineId('U1b'))?.status).toBe('ACTIVE')
  })

  it('LINE ล่มตอนผูกเมนู: ยืนยันสำเร็จแต่ menu.ok=false · relink-all แก้ได้ทีหลัง', async () => {
    const t = setup({ requireApproval: true })
    await importRoster(t)
    const pw = await issue(t, 'E001')
    await verify(t, 'U1', 'E001', '0812345678', pw)
    t.line.failLink = true
    const ap = await t.app.inject({ method: 'POST', url: `/api/admin/verification-requests/${(await t.store.listRequests('PENDING'))[0]!.id}/approve`, headers: adm })
    expect(ap.json().data.menu.ok).toBe(false)
    expect((await t.store.findUserByLineId('U1'))?.status).toBe('ACTIVE')
    t.line.failLink = false
    const re = await t.app.inject({ method: 'POST', url: '/api/admin/relink-all', headers: adm })
    expect(re.json().data).toMatchObject({ total: 1, ok: 1, failed: 0 })
    expect(t.line.links.get('U1')).toBe('menu:tab-m-staff')
  })

  it('alias ยังไม่มีใน OA → รายงานชัดเจน ไม่ crash', async () => {
    const t = setup({ requireApproval: true })
    await importRoster(t)
    t.line.aliases.clear()
    await verify(t, 'U1', 'E001', '0812345678', await issue(t, 'E001'))
    const ap = await t.app.inject({ method: 'POST', url: `/api/admin/verification-requests/${(await t.store.listRequests('PENDING'))[0]!.id}/approve`, headers: adm })
    expect(ap.json().data.menu.error).toMatch(/richmenu:sync/)
  })
})

describe('สิทธิ์แอดมิน: เฉพาะ superadmin', () => {
  it('ไม่มี token / token มั่ว → 401', async () => {
    const t = setup()
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users' })).statusCode).toBe(401)
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401)
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: adm })).statusCode).toBe(200)
  })

  it('superadmin ที่ล็อกอินด้วย LINE เข้าได้ · ชื่อของเขาถูกบันทึกเป็นผู้ออกรหัส/ผู้อนุมัติ', async () => {
    const t = setup()
    await importRoster(t)
    await onboard(t, 'USUPER', 'S001', '0877777777')
    const who = await t.app.inject({ method: 'GET', url: '/api/admin/whoami', headers: tok('USUPER') })
    expect(who.statusCode).toBe(200)
    expect(who.json().data.actor).toBe('S001 ซูเปอร์ แอดมิน')

    const u = (await t.store.findUserByCode('E001'))!
    const iss = await t.app.inject({ method: 'POST', url: `/api/admin/users/${u.id}/activation-code`, headers: tok('USUPER'), payload: {} })
    expect(iss.statusCode).toBe(200)
    await verify(t, 'U1', 'E001', '0812345678', iss.json().data.code)
    expect((await t.store.listRequests('APPROVED')).find(r => r.lineUserId === 'U1')?.decidedBy).toBe('S001 ซูเปอร์ แอดมิน')
  })

  it('admin ธรรมดา / คนที่ยังไม่ผูก เรียก endpoint แอดมินไม่ได้ (403) · token ปลอม 401', async () => {
    const t = setup()
    await importRoster(t)
    await onboard(t, 'U2', 'E002', '0899990000') // admin ไม่ใช่ superadmin
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: tok('U2') })).statusCode).toBe(403)
    expect((await t.app.inject({ method: 'POST', url: '/api/admin/activation-codes/issue-all', headers: tok('U2'), payload: {} })).statusCode).toBe(403)
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: tok('NOBODY') })).statusCode).toBe(403)
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: { authorization: 'Bearer forged' } })).statusCode).toBe(401)
  })

  it('superadmin ที่ถูกยกเลิกการผูกแล้ว หมดสิทธิ์ทันที', async () => {
    const t = setup()
    await importRoster(t)
    await onboard(t, 'USUPER', 'S001', '0877777777')
    await onboard(t, 'USUPER2', 'E002', '0899990000')
    const u2 = (await t.store.findUserByCode('E002'))!
    await t.app.inject({ method: 'PUT', url: `/api/admin/users/${u2.id}/roles`, headers: adm, payload: { roles: ['superadmin'] } })
    const s1 = (await t.store.findUserByCode('S001'))!
    await t.app.inject({ method: 'POST', url: `/api/admin/users/${s1.id}/unlink`, headers: adm })
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: tok('USUPER') })).statusCode).toBe(403)
  })

  it('ถอดสิทธิ์/ยกเลิกการผูก superadmin คนสุดท้ายไม่ได้ (409)', async () => {
    const t = setup()
    await importRoster(t)
    await onboard(t, 'USUPER', 'S001', '0877777777')
    const s = (await t.store.findUserByCode('S001'))!
    const demote = await t.app.inject({ method: 'PUT', url: `/api/admin/users/${s.id}/roles`, headers: adm, payload: { roles: ['staff'] } })
    expect(demote.statusCode).toBe(409)
    expect(demote.json().error.code).toBe('LAST_SUPERADMIN')
    expect((await t.app.inject({ method: 'POST', url: `/api/admin/users/${s.id}/unlink`, headers: adm })).statusCode).toBe(409)
  })
})

describe('การยืนยันตัวตนของผู้ใช้ทั่วไป', () => {
  it('ต้องมี ID token ที่ผ่านการตรวจ — ไม่เชื่อ userId ที่ client ส่งมา', async () => {
    const { app } = setup()
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer forged' } })).statusCode).toBe(401)
    const forged = await app.inject({ method: 'POST', url: '/api/verify/request', headers: { authorization: 'Bearer forged' }, payload: { employee_code: 'E001', phone: '0812345678', password: 'AAAA-AAAA', line_user_id: 'U-someone-else' } })
    expect(forged.statusCode).toBe(401)
  })
})

describe('webhook', () => {
  const body = JSON.stringify({ events: [{ type: 'follow', source: { userId: 'U1' } }] })
  const sign = (b: string, secret = SECRET) => createHmac('sha256', secret).update(b).digest('base64')

  it('ลายเซ็นผิด/ไม่มี → 401', async () => {
    const { app } = setup()
    const h = { 'content-type': 'application/json' }
    expect((await app.inject({ method: 'POST', url: '/webhook', headers: h, payload: body })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/webhook', headers: { ...h, 'x-line-signature': sign(body, 'other') }, payload: body })).statusCode).toBe(401)
  })

  it('follow ของคนที่เคยผูกไว้ → คืนเมนูตามบทบาท · คนใหม่ไม่ผูกอะไร', async () => {
    const t = setup()
    await importRoster(t)
    await onboard(t, 'U1', 'E001', '0812345678')
    t.line.links.clear()
    const r = await t.app.inject({ method: 'POST', url: '/webhook', headers: { 'content-type': 'application/json', 'x-line-signature': sign(body) }, payload: body })
    expect(r.statusCode).toBe(200)
    expect(t.line.links.get('U1')).toBe('menu:tab-m-staff')

    const nb = JSON.stringify({ events: [{ type: 'follow', source: { userId: 'NEW' } }] })
    await t.app.inject({ method: 'POST', url: '/webhook', headers: { 'content-type': 'application/json', 'x-line-signature': sign(nb) }, payload: nb })
    expect(t.line.links.has('NEW')).toBe(false)
  })
})

describe('/me และรายการระบบ', () => {
  it('การ์ดตามบทบาท: guest / พนักงาน / แอดมิน / superadmin', async () => {
    const t = setup()
    const put = (code: string, name: string, required_role: string | null, order: number) =>
      t.app.inject({ method: 'PUT', url: `/api/admin/apps/${code}`, headers: adm, payload: { name, type: 'uri', url: `https://${code}.example`, required_role, sort_order: order } })
    await put('shop', 'ร้านค้า', 'guest', 1)
    await put('yoonai', 'Yoonai', null, 2)
    await put('yoonai-admin', 'Yoonai Admin', 'admin', 3)
    await put('yoonai-super', 'Yoonai Superadmin', 'superadmin', 4)
    const codes = async (uid: string) => ((await t.app.inject({ method: 'GET', url: '/api/me', headers: tok(uid) })).json().data.apps as { code: string }[]).map(a => a.code)

    expect(await codes('G')).toEqual(['shop'])
    await importRoster(t)
    await onboard(t, 'U1', 'E001', '0812345678')
    await onboard(t, 'U2', 'E002', '0899990000')
    await onboard(t, 'US', 'S001', '0877777777')
    expect(await codes('U1')).toEqual(['shop', 'yoonai'])
    expect(await codes('U2')).toEqual(['shop', 'yoonai', 'yoonai-admin'])
    expect(await codes('US')).toEqual(['shop', 'yoonai', 'yoonai-admin', 'yoonai-super'])
  })

  it('สิทธิ์เฉพาะระบบ: admin ของแอปหนึ่งไม่เห็นหลังบ้านของแอปอื่น', () => {
    const app = (id: string) => ({ id, code: id, name: id, type: 'uri' as const, url: null, liffId: null, icon: null, requiredRole: 'admin', groupName: null, sortOrder: 0, active: true })
    const roles = [{ roleCode: 'admin' as const, appId: 'a1' }]
    expect(canAccess(app('a1'), roles)).toBe(true)
    expect(canAccess(app('a2'), roles)).toBe(false)
    expect(canAccess({ ...app('a1'), active: false }, roles)).toBe(false)
  })

  it('normalizePhone', () => {
    expect(normalizePhone('081-234-5678')).toBe('0812345678')
    expect(normalizePhone('+66 81 234 5678')).toBe('0812345678')
  })
})

describe('ตัวแก้ Rich Menu', () => {
  const SET_KEYS = ['member-staff', 'member-web', 'admin-staff', 'admin-admin', 'admin-web', 'guest']
  const sizeOf = (k: string) => (k === 'guest' ? { width: 2500, height: 843 } : { width: 2500, height: 1686 })
  const area = (x: number, y: number, w: number, h: number, action: Record<string, unknown>, label = 'ปุ่ม') => ({ x, y, width: w, height: h, label, action })
  const body = (k: string, areas: unknown[]) => ({ ...sizeOf(k), chat_bar_text: 'เมนู SJ', areas })
  const baseAreas = (k: string) => {
    const tab = k.startsWith('member') ? 'member' : k.startsWith('admin') ? 'admin' : null
    const top = tab ? 243 : 0
    const a = [
      area(0, top, 800, 600, { type: 'uri', uri: 'https://ok.example/' }, 'ลิงก์'),
      area(800, top, 800, 600, { type: 'liff', liffId: '2010057364-BtB7eW1f', path: '/leave' }, 'วันลา'),
      area(1600, top, 800, 600, { type: 'message', text: 'ยังไม่เปิดใช้งาน' }, 'ยังไม่เปิด'),
    ]
    if (tab) a.push(area(0, 0, 833, 243, { type: 'tab', target: tab + '-' + (tab === 'member' ? 'web' : 'admin') }, 'สลับ'))
    return a
  }
  const seed = async (t: T, withImages = true) => {
    const r = await t.app.inject({
      method: 'POST', url: '/api/admin/richmenus/import', headers: adm,
      payload: { menus: SET_KEYS.map(k => ({ key: k, body: body(k, baseAreas(k)), image_base64: withImages ? png(sizeOf(k).width, sizeOf(k).height).toString('base64') : undefined })) },
    })
    expect(r.statusCode).toBe(200)
    return r.json().data as { imported: number; skipped: number }
  }
  const imageUrl = (k: string) => '/api/admin/richmenus/' + k + '/image'

  it('อ่านขนาดภาพ PNG/JPEG ได้ และปฏิเสธไฟล์ที่ไม่ใช่ภาพ', () => {
    expect(imageInfo(png(2500, 1686))).toEqual({ type: 'image/png', width: 2500, height: 1686 })
    expect(imageInfo(jpeg(2500, 843))).toEqual({ type: 'image/jpeg', width: 2500, height: 843 })
    expect(imageInfo(Buffer.from('hello world, not an image at all'))).toBeNull()
  })

  it('นำเข้าชุดเริ่มต้น แล้วดู/แก้ได้ · นำเข้าซ้ำไม่ทับของที่แก้แล้ว', async () => {
    const t = setup()
    expect(await seed(t)).toEqual({ imported: 6, skipped: 0 })
    expect(await seed(t)).toEqual({ imported: 0, skipped: 6 })
    const list = (await t.app.inject({ method: 'GET', url: '/api/admin/richmenus', headers: adm })).json().data
    expect(list.menus.map((m: { key: string }) => m.key)).toEqual(SET_KEYS)
    expect(list.allowedSizes.length).toBe(6)
    expect(list.menus.every((m: { hasImage: boolean }) => m.hasImage)).toBe(true)

    const edit = await t.app.inject({ method: 'PUT', url: '/api/admin/richmenus/member-staff', headers: adm, payload: body('member-staff', [area(10, 300, 900, 700, { type: 'uri', uri: 'https://new.example/' }, 'ใหม่')]) })
    expect(edit.statusCode).toBe(200)
    expect(edit.json().data.dirty).toBe(true)
    expect(edit.json().data.areas.length).toBe(1)
    expect(edit.json().data.hasImage).toBe(true) // ขนาดเท่าเดิม ภาพยังอยู่
    expect(await seed(t)).toEqual({ imported: 0, skipped: 6 })
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/richmenus/member-staff', headers: adm })).json().data.areas[0].label).toBe('ใหม่')
  })

  it('ตรวจข้อมูลก่อนบันทึก: ขนาด LINE · เกินขอบภาพ · tab ข้ามชุด · http · LIFF ID · เกิน 20 พื้นที่ · เมนูที่ไม่รู้จัก', async () => {
    const t = setup(); await seed(t)
    const put = (k: string, p: unknown) => t.app.inject({ method: 'PUT', url: '/api/admin/richmenus/' + k, headers: adm, payload: p })
    const ok = area(0, 0, 100, 100, { type: 'uri', uri: 'https://ok.example/' })
    expect((await put('member-staff', { ...body('member-staff', [ok]), width: 1000, height: 1000 })).json().error.code).toBe('BAD_SIZE')
    expect((await put('member-staff', body('member-staff', [area(2450, 0, 100, 100, { type: 'uri', uri: 'https://ok.example/' })]))).json().error.code).toBe('AREA_OUT_OF_BOUNDS')
    expect((await put('member-staff', body('member-staff', [area(0, 0, 100, 100, { type: 'tab', target: 'admin-admin' })]))).json().error.code).toBe('BAD_TAB_TARGET')
    expect((await put('guest', body('guest', [area(0, 0, 100, 100, { type: 'tab', target: 'member-web' })]))).json().error.code).toBe('BAD_TAB_TARGET')
    expect((await put('member-staff', body('member-staff', [area(0, 0, 100, 100, { type: 'uri', uri: 'http://insecure.example' })]))).statusCode).toBe(400)
    expect((await put('member-staff', body('member-staff', [area(0, 0, 100, 100, { type: 'liff', liffId: 'abc' })]))).statusCode).toBe(400)
    expect((await put('member-staff', body('member-staff', Array.from({ length: 21 }, () => ok)))).statusCode).toBe(400)
    expect((await put('nope', body('guest', [ok]))).json().error.code).toBe('UNKNOWN_MENU')
    expect((await put('member-staff', { ...body('member-staff', [ok]), chat_bar_text: 'ยาวเกินสิบสี่ตัวอักษรแน่นอน' })).statusCode).toBe(400)
  })

  it('อัปโหลดภาพ: ขนาดต้องพอดี · ≤ 1 MB · ต้องเป็นภาพ · เปลี่ยนขนาดเมนูแล้วภาพเดิมถูกล้าง', async () => {
    const t = setup(); await seed(t, false)
    const up = (k: string, buf: Buffer, type = 'image/png') => t.app.inject({ method: 'PUT', url: imageUrl(k), headers: { ...adm, 'content-type': type }, payload: buf })
    expect((await up('member-staff', png(2500, 843))).json().error.code).toBe('BAD_IMAGE_SIZE')
    expect((await up('member-staff', Buffer.from('not an image'))).json().error.code).toBe('BAD_IMAGE')
    expect((await up('member-staff', png(2500, 1686, 1_100_000))).statusCode).toBe(413)
    const good = await up('member-staff', png(2500, 1686))
    expect(good.statusCode).toBe(200)
    expect(good.json().data.hasImage).toBe(true)
    expect(good.json().data.imageType).toBe('image/png')
    const got = await t.app.inject({ method: 'GET', url: imageUrl('member-staff'), headers: adm })
    expect(got.headers['content-type']).toBe('image/png')
    expect(imageInfo(got.rawPayload)?.width).toBe(2500)
    const resized = await t.app.inject({ method: 'PUT', url: '/api/admin/richmenus/member-staff', headers: adm, payload: { width: 2500, height: 843, chat_bar_text: 'เมนู', areas: [area(0, 0, 100, 100, { type: 'uri', uri: 'https://ok.example/' })] } })
    expect(resized.json().data.hasImage).toBe(false)
    expect((await t.app.inject({ method: 'GET', url: imageUrl('member-staff'), headers: adm })).statusCode).toBe(404)
  })

  it('เผยแพร่: ต้องมีภาพครบก่อน · สร้างเมนู/alias ใหม่ ลบของเก่า ไม่แตะ default · แปลงปุ่มถูกชนิด · ผูกเมนูผู้ใช้ใหม่', async () => {
    const t = setup(); await seed(t, false)
    const notReady = await t.app.inject({ method: 'POST', url: '/api/admin/richmenus/publish', headers: adm, payload: {} })
    expect(notReady.statusCode).toBe(409)
    expect(notReady.json().error.message).toContain('member-staff: ยังไม่มีภาพ')

    for (const k of SET_KEYS) {
      const r = await t.app.inject({ method: 'PUT', url: imageUrl(k), headers: { ...adm, 'content-type': 'image/jpeg' }, payload: jpeg(sizeOf(k).width, sizeOf(k).height) })
      expect(r.statusCode).toBe(200)
    }
    await importRoster(t)
    await onboard(t, 'U1', 'E001', '0812345678')
    t.line.oa.set('old1', { name: 'sjhub:member-staff', body: {} }) // เมนูเก่าของเรา → ต้องถูกลบ
    t.line.oa.set('other', { name: 'จาก OA Manager', body: {} }) // เมนูอื่นของ OA → ต้องไม่ถูกแตะ
    t.line.aliasMap.set('tab-m-staff', 'old1')

    const pub = await t.app.inject({ method: 'POST', url: '/api/admin/richmenus/publish', headers: adm, payload: {} })
    expect(pub.statusCode).toBe(200)
    expect(pub.json().data).toMatchObject({ created: 6, aliases: 5, deletedOld: 1, defaultSet: false, relink: { total: 1, ok: 1, failed: 0 } })
    expect(t.line.oa.has('old1')).toBe(false)
    expect(t.line.oa.has('other')).toBe(true)
    expect(t.line.defaultId).toBeNull()
    expect([...t.line.aliasMap.keys()].sort()).toEqual(['tab-a-admin', 'tab-a-staff', 'tab-a-web', 'tab-m-staff', 'tab-m-web'])

    const ms = [...t.line.oa.values()].find(m => m.name === 'sjhub:member-staff')!
    const acts = ms.body.areas.map((a: { action: Record<string, string> }) => a.action)
    expect(acts[0]).toMatchObject({ type: 'uri', uri: 'https://ok.example/' })
    expect(acts[1]).toMatchObject({ type: 'uri', uri: 'https://liff.line.me/2010057364-BtB7eW1f/leave' })
    expect(acts[2]).toMatchObject({ type: 'message', text: 'ยังไม่เปิดใช้งาน' })
    expect(acts[3]).toMatchObject({ type: 'richmenuswitch', richMenuAliasId: 'tab-m-web', data: 'tab=member-web' })
    expect(ms.image?.length).toBeGreaterThan(0)
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/richmenus', headers: adm })).json().data.menus.every((m: { dirty: boolean }) => !m.dirty)).toBe(true)

    const pub2 = await t.app.inject({ method: 'POST', url: '/api/admin/richmenus/publish', headers: adm, payload: { set_default_guest: true } })
    expect(pub2.json().data.defaultSet).toBe(true)
    expect(t.line.oa.get(t.line.defaultId!)?.name).toBe('sjhub:guest')
    expect([...t.line.oa.values()].filter(m => m.name.startsWith('sjhub:')).length).toBe(6) // รันซ้ำไม่มีเมนูซ้ำ
  })

  it('เผยแพร่ล้มเหลวกลางทาง: ล้างเมนูใหม่ที่สร้างค้าง ไม่ทิ้งขยะใน OA และลองใหม่ได้', async () => {
    const t = setup(); await seed(t)
    t.line.failUpload = true
    const r = await t.app.inject({ method: 'POST', url: '/api/admin/richmenus/publish', headers: adm, payload: {} })
    expect(r.statusCode).toBe(500)
    expect([...t.line.oa.values()].filter(m => m.name.startsWith('sjhub:')).length).toBe(0)
    t.line.failUpload = false
    expect((await t.app.inject({ method: 'POST', url: '/api/admin/richmenus/publish', headers: adm, payload: {} })).statusCode).toBe(200)
  })

  it('เฉพาะ superadmin แก้เมนูได้ (admin ธรรมดา 403)', async () => {
    const t = setup(); await seed(t)
    await importRoster(t)
    await onboard(t, 'U2', 'E002', '0899990000')
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/richmenus', headers: tok('U2') })).statusCode).toBe(403)
    expect((await t.app.inject({ method: 'POST', url: '/api/admin/richmenus/publish', headers: tok('U2'), payload: {} })).statusCode).toBe(403)
  })

  it('หน้าแก้เมนู /verify/admin/menu ส่ง HTML', async () => {
    const t = setup()
    const p = await t.app.inject({ method: 'GET', url: '/verify/admin/menu' })
    expect(p.statusCode).toBe(200)
    expect(p.headers['x-frame-options']).toBe('DENY')
  })
})

describe('Monitor และบันทึกกิจกรรม', () => {
  const snap = async (t: T) => (await t.app.inject({ method: 'GET', url: '/api/admin/monitor', headers: adm })).json().data
  const audit = async (t: T, q = '') => (await t.app.inject({ method: 'GET', url: '/api/admin/audit' + q, headers: adm })).json().data as { actor: string; action: string; target: string | null; detail: unknown }[]

  it('สรุปผู้ใช้/บทบาท/รหัส/คำขอ ถูกต้อง และแจ้งเตือนตามสถานการณ์', async () => {
    const t = setup({ requireApproval: true })
    await importRoster(t)
    await issue(t, 'E001')                          // มีรหัสที่ยังไม่ใช้ 1 คน
    await verify(t, 'U2', 'E002', '0899990000', 'AAAA-AAAA') // ไม่มีรหัสของ E002 → ล้มเหลว 1
    const s0 = await snap(t)
    expect(s0.users).toEqual({ total: 3, active: 0, invited: 3, inactive: 0 })
    expect(s0.roles).toEqual({ staff: 1, admin: 1, superadmin: 1 })
    expect(s0.codes).toMatchObject({ outstanding: 1, expiringSoon: 0, locked: 0, invitedWithoutCode: 2 })
    expect(s0.attempts.last24h).toEqual({ ok: 0, fail: 1 })
    expect(s0.attempts.days).toHaveLength(7)
    expect(s0.attempts.days[6]).toMatchObject({ date: '2026-10-15', fail: 1 })
    expect(s0.db.ok).toBe(true)
    expect(s0.line).toMatchObject({ ok: true, bot: { displayName: 'SJ-Webapp/Demo' }, webhook: { active: true } })
    expect(s0.alerts.map((a: { code: string }) => a.code)).toContain('no-code')

    const pw = await issue(t, 'E002')
    await verify(t, 'U2', 'E002', '0899990000', pw)  // ต้องอนุมัติ → pending
    const s1 = await snap(t)
    expect(s1.requests.pending).toBe(1)
    expect(s1.attempts.last24h.ok).toBe(1)
    expect(s1.alerts.map((a: { code: string }) => a.code)).toContain('pending')
  })

  it('รหัสที่จะหมดอายุใน 24 ชม. / ถูกล็อก / หมดอายุแล้ว นับแยกกัน', async () => {
    const t = setup()
    await importRoster(t)
    await issue(t, 'E001', 12)   // หมดใน 12 ชม.
    await issue(t, 'E002', 72)
    await issue(t, 'S001', 72)
    for (let i = 0; i < 5; i++) await verify(t, `X${i}`, 'S001', '0877777777', 'AAAA-AAAA') // ล็อก S001
    let s = await snap(t)
    expect(s.codes).toMatchObject({ outstanding: 2, expiringSoon: 1, locked: 1 })
    expect(s.alerts.map((a: { code: string }) => a.code)).toEqual(expect.arrayContaining(['locked', 'expiring']))
    t.clock.t += 80 * 3600 * 1000
    s = await snap(t)
    expect(s.codes).toMatchObject({ outstanding: 0, expired: 3 })
  })

  it('สถานะเมนู: ยังไม่เผยแพร่/แก้ไขแล้ว และเตือนเมื่อไม่มีเมนูของ Hub ใน OA', async () => {
    const t = setup()
    await t.app.inject({ method: 'POST', url: '/api/admin/richmenus/import', headers: adm, payload: { menus: [{ key: 'guest', body: { width: 2500, height: 843, chat_bar_text: 'เมนู', areas: [{ x: 0, y: 0, width: 2500, height: 843, label: 'a', action: { type: 'message', text: 'x' } }] }, image_base64: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 9, 196, 0, 0, 3, 75]), Buffer.alloc(30)]).toString('base64') }] } })
    const s = await snap(t)
    expect(s.menus).toMatchObject({ total: 1, withImage: 1, dirty: 1, lastPublishedAt: null })
    const codes = s.alerts.map((a: { code: string }) => a.code)
    expect(codes).toEqual(expect.arrayContaining(['menu-dirty', 'menu-missing']))
  })

  it('Webhook ยังไม่เปิด → เตือน · LINE ล่ม → รายงานแต่ไม่ล้ม · ใช้ cache ไม่ยิง LINE ซ้ำถี่ๆ', async () => {
    const t = setup()
    t.line.hook = { endpoint: 'https://hub.example/webhook', active: false }
    let s = await snap(t)
    expect(s.alerts.map((a: { code: string }) => a.code)).toContain('webhook')
    const calls = t.line.infoCalls
    await snap(t); await snap(t)
    expect(t.line.infoCalls).toBe(calls) // อยู่ใน cache

    const t2 = setup()
    t2.line.failInfo = true
    s = await snap(t2)
    expect(s.line.ok).toBe(false)
    expect(s.line.errors.length).toBeGreaterThan(0)
    expect(s.alerts.find((a: { code: string }) => a.code === 'line').level).toBe('error')
    expect(JSON.stringify(s)).not.toContain('abc.def') // โทเค็นในข้อความ error ต้องถูกปิดบัง
    expect(JSON.stringify(s)).toContain('access token ไม่ถูกต้อง') // แปลเป็นข้อความอ่านง่าย ไม่โชว์ JSON ดิบจาก LINE
  })

  it('ฐานข้อมูลอ่านไม่ได้ → db.ok=false และมี alert error (ไม่ล้ม)', async () => {
    const t = setup()
    t.store.listUsers = async () => { throw new Error('connection refused') }
    const s = await snap(t)
    expect(s.db.ok).toBe(false)
    expect(s.alerts[0]).toMatchObject({ level: 'error', code: 'db' })
  })

  it('บันทึกกิจกรรม: ออกรหัส/ยืนยัน/อนุมัติ/บทบาท/ยกเลิกผูก/เมนู/ระบบ — ไม่มีรหัสผ่าน เบอร์ หรือ LINE userId', async () => {
    const t = setup()
    await importRoster(t)
    const u = (await t.store.findUserByCode('E001'))!
    const iss = await t.app.inject({ method: 'POST', url: `/api/admin/users/${u.id}/activation-code`, headers: { ...adm, 'x-admin-name': 'net' }, payload: { hours: 24 } })
    const pw = iss.json().data.code as string
    await verify(t, 'ULINE-SECRET-1', 'E001', '0812345678', 'AAAA-AAAA')       // ผิด
    await verify(t, 'ULINE-SECRET-1', 'E001', '0812345678', pw)                // ถูก
    await t.app.inject({ method: 'PUT', url: `/api/admin/users/${u.id}/roles`, headers: adm, payload: { roles: ['staff', 'admin'] } })
    await t.app.inject({ method: 'PUT', url: '/api/admin/apps/x-app', headers: adm, payload: { name: 'X', type: 'uri', url: 'https://x.example' } })
    await t.app.inject({ method: 'POST', url: `/api/admin/users/${u.id}/unlink`, headers: adm })

    const rows = await audit(t)
    const actions = rows.map(r => r.action)
    expect(actions).toEqual(expect.arrayContaining(['users.import', 'code.issue', 'verify.fail', 'verify.success', 'user.roles', 'app.save', 'user.unlink']))
    expect(rows.find(r => r.action === 'code.issue')).toMatchObject({ actor: 'token:net', target: 'E001' })
    const all = JSON.stringify(rows)
    expect(all).not.toContain(pw)
    expect(all).not.toContain('AAAA-AAAA')
    expect(all).not.toContain('0812345678')
    expect(all).not.toContain('ULINE-SECRET-1')
    expect((await audit(t, '?prefix=verify.')).every(r => r.action.startsWith('verify.'))).toBe(true)
    expect((await audit(t, '?limit=2')).length).toBe(2)
  })

  it('/admin และ / ไปแดชบอร์ด · หน้าแดชบอร์ดส่ง HTML · เฉพาะ superadmin เรียก monitor/audit ได้', async () => {
    const t = setup()
    const a = await t.app.inject({ method: 'GET', url: '/admin' })
    expect(a.statusCode).toBe(302)
    expect(a.headers.location).toBe('/verify/admin/dashboard')
    expect((await t.app.inject({ method: 'GET', url: '/' })).headers.location).toBe('/verify/admin/dashboard')
    const p = await t.app.inject({ method: 'GET', url: '/verify/admin/dashboard' })
    expect(p.statusCode).toBe(200)
    expect(p.headers['x-frame-options']).toBe('DENY')
    await importRoster(t)
    await onboard(t, 'U2', 'E002', '0899990000')
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/monitor', headers: tok('U2') })).statusCode).toBe(403)
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/audit', headers: tok('U2') })).statusCode).toBe(403)
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/monitor' })).statusCode).toBe(401)
  })
})

describe('จัดการรายการระบบ (apps)', () => {
  const put = (t: T, code: string, payload: Record<string, unknown>, headers: Record<string, string> = adm) =>
    t.app.inject({ method: 'PUT', url: '/api/admin/apps/' + code, headers, payload })

  it('เพิ่ม/แก้/ปิดใช้งานระบบได้ — ปิดแล้วหายจากการ์ดของผู้ใช้', async () => {
    const t = setup()
    expect((await put(t, 'workpath', { name: 'Workpath', type: 'uri', url: 'https://workpath.example/', icon: '✅', sort_order: 1 })).statusCode).toBe(200)
    expect((await put(t, 'weajer', { name: 'WEA-JER', type: 'liff', liff_id: '2009853780-AbCdEfGh', required_role: 'driver', sort_order: 2 })).statusCode).toBe(200)
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/apps', headers: adm })).json().data.length).toBe(2)
    await importRoster(t)
    await onboard(t, 'U1', 'E001', '0812345678')
    const mine = async () => ((await t.app.inject({ method: 'GET', url: '/api/me', headers: tok('U1') })).json().data.apps as { code: string }[]).map(a => a.code)
    expect(await mine()).toEqual(['workpath'])
    await put(t, 'workpath', { name: 'Workpath', type: 'uri', url: 'https://workpath.example/', active: false })
    expect(await mine()).toEqual([])
    const edited = await put(t, 'workpath', { name: 'Workpath 2', type: 'uri', url: 'https://workpath.example/', active: true })
    expect(edited.json().data.name).toBe('Workpath 2')
  })

  it('จัดกลุ่มระบบ: บันทึกกลุ่ม แล้ว /api/me ส่งกลุ่มและสิทธิ์ให้หน้า ALL APP จัดหมวด', async () => {
    const t = setup()
    await put(t, 'yoonai-checkin', { name: 'เช็คอิน', type: 'liff', liff_id: '2010057364-BtB7eW1f', group: 'Yoonai', sort_order: 10 })
    await put(t, 'yoonai-admin', { name: 'Yoonai Admin', type: 'uri', url: 'https://admin.example/', required_role: 'admin', group: ' Yoonai ', sort_order: 11 })
    await put(t, 'workpath', { name: 'Workpath', type: 'uri', url: 'https://workpath.example/', group: 'Workpath', sort_order: 20 })
    await put(t, 'misc', { name: 'อื่นๆ', type: 'uri', url: 'https://misc.example/', group: '', sort_order: 99 })
    const list = (await t.app.inject({ method: 'GET', url: '/api/admin/apps', headers: adm })).json().data as { code: string; groupName: string | null }[]
    expect(list.find(a => a.code === 'yoonai-admin')?.groupName).toBe('Yoonai')   // ตัดช่องว่าง
    expect(list.find(a => a.code === 'misc')?.groupName).toBeNull()                // ว่าง = ไม่มีกลุ่ม
    await importRoster(t)
    await onboard(t, 'U1', 'E001', '0812345678')
    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: tok('U1') })).json().data.apps as { code: string; group: string | null; requiredRole: string | null }[]
    expect(me.map(a => [a.code, a.group])).toEqual([['yoonai-checkin', 'Yoonai'], ['workpath', 'Workpath'], ['misc', null]]) // staff ไม่เห็นหลังบ้าน
    expect((await put(t, 'x', { name: 'x', type: 'uri', url: 'https://ok.example', group: 'ก'.repeat(61) })).statusCode).toBe(400)
  })

  it('ตรวจข้อมูล: LIFF ต้องมี LIFF ID รูปแบบถูก · ลิงก์ต้อง https · role ต้องอยู่ในรายการ · code ต้องเป็น slug', async () => {
    const t = setup()
    expect((await put(t, 'a', { name: 'x', type: 'liff' })).statusCode).toBe(400)
    expect((await put(t, 'a', { name: 'x', type: 'liff', liff_id: 'abc' })).statusCode).toBe(400)
    expect((await put(t, 'a', { name: 'x', type: 'uri' })).statusCode).toBe(400)
    expect((await put(t, 'a', { name: 'x', type: 'uri', url: 'http://insecure.example' })).statusCode).toBe(400)
    expect((await put(t, 'a', { name: 'x', type: 'uri', url: 'javascript:alert(1)' })).statusCode).toBe(400)
    expect((await put(t, 'a', { name: 'x', type: 'uri', url: 'https://ok.example', required_role: 'boss' })).statusCode).toBe(400)
    expect((await put(t, 'Bad_Code', { name: 'x', type: 'uri', url: 'https://ok.example' })).statusCode).toBe(400)
    expect((await put(t, 'ok-code', { name: 'x', type: 'uri', url: 'https://ok.example' })).statusCode).toBe(200)
  })

  it('จัดการระบบได้เฉพาะ superadmin (admin ธรรมดา 403)', async () => {
    const t = setup()
    await importRoster(t)
    await onboard(t, 'U2', 'E002', '0899990000')
    expect((await put(t, 'x', { name: 'x', type: 'uri', url: 'https://ok.example' }, tok('U2'))).statusCode).toBe(403)
  })
})

describe('หน้ายืนยันตัวตนและ CORS', () => {
  it('/verify ส่ง HTML (มีช่องรหัสผ่าน) พร้อม CSP และ config.js มี LIFF ID', async () => {
    const { app } = setup()
    const page = await app.inject({ method: 'GET', url: '/verify' })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-security-policy']).toContain('static.line-scdn.net')
    expect(page.body).toContain('รหัสผ่านจากผู้ดูแล')
    expect((await app.inject({ method: 'GET', url: '/verify/config.js' })).body).toContain('2010195603-test')
  })

  it('หน้าจัดการ /verify/admin ส่ง HTML (ตัวหน้าไม่มีข้อมูล — ข้อมูลมาจาก API ที่ต้องเป็น superadmin)', async () => {
    const { app } = setup()
    const page = await app.inject({ method: 'GET', url: '/verify/admin' })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('จัดการผู้ใช้ LINE Hub')
    expect(page.headers['x-frame-options']).toBe('DENY')
    expect(page.body).not.toContain('Bearer ' + 'a'.repeat(32))
  })

  it('หน้า ALL APP ส่ง HTML และ /apps ไปหน้านั้น', async () => {
    const { app } = setup()
    const p = await app.inject({ method: 'GET', url: '/verify/apps' })
    expect(p.statusCode).toBe(200)
    expect(p.body).toContain('ALL APP')
    expect(p.headers['x-frame-options']).toBe('DENY')
    expect((await app.inject({ method: 'GET', url: '/apps' })).headers.location).toBe('/verify/apps')
  })

  it('ไฟล์สไตล์/รูปมาสคอตส่งได้ (ชนิดถูก) · ชื่อไฟล์แปลก/พยายามออกนอกโฟลเดอร์ ถูกปฏิเสธ · CSP ยอมฟอนต์ Google', async () => {
    const { app } = setup()
    const css = await app.inject({ method: 'GET', url: '/verify/assets/hub.css' })
    expect(css.statusCode).toBe(200)
    expect(css.headers['content-type']).toContain('text/css')
    expect(css.body).toContain('--blue')
    const owl = await app.inject({ method: 'GET', url: '/verify/assets/owl.webp' })
    expect(owl.statusCode).toBe(200)
    expect(owl.headers['content-type']).toBe('image/webp')
    for (const bad of ['..%2f..%2fpackage.json', '%2e%2e%2fsrc%2fapp.ts', 'app.ts', 'nope.css', '.env', 'hub.css%00.png']) {
      expect([400, 404]).toContain((await app.inject({ method: 'GET', url: '/verify/assets/' + bad })).statusCode)
    }
    const page = await app.inject({ method: 'GET', url: '/verify' })
    expect(page.headers['content-security-policy']).toContain('fonts.gstatic.com')
    expect(page.body).toContain('/verify/assets/hub.css')
  })

  it('CORS เฉพาะ origin ที่อนุญาต', async () => {
    const { app } = setup()
    const ok = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://allapp.example' } })
    expect(ok.headers['access-control-allow-origin']).toBe('https://allapp.example')
    const no = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } })
    expect(no.headers['access-control-allow-origin']).toBeUndefined()
  })
})
