import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadMenuSets } from '../src/config.js'
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
  const app = buildApp({ service, store, line, channelSecret: SECRET, adminToken: ADMIN, verifyLiffId: '2010195603-test', corsOrigins: ['https://allapp.example'] })
  return { store, line, service, app, clock }
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
    const app = (id: string) => ({ id, code: id, name: id, type: 'uri' as const, url: null, liffId: null, icon: null, requiredRole: 'admin', sortOrder: 0, active: true })
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

  it('CORS เฉพาะ origin ที่อนุญาต', async () => {
    const { app } = setup()
    const ok = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://allapp.example' } })
    expect(ok.headers['access-control-allow-origin']).toBe('https://allapp.example')
    const no = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } })
    expect(no.headers['access-control-allow-origin']).toBeUndefined()
  })
})
