// ตรรกะหลักของ Hub: ยืนยันตัวตนพนักงาน → แอดมินอนุมัติ → บทบาท → Rich Menu รายคน → /me
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import { entryAliasForRoles, type MenuSets } from './config.js'
import { HttpError, type AppEntry, type LineApi, type RoleCode, type Store, type User, type UserRoleEntry, type VerificationRequest } from './types.js'

export interface MenuSyncResult { ok: boolean; menu: string | null; error?: string }

export interface HubOptions {
  now?: () => Date
  maxFailedAttempts?: number // ต่อ LINE userId ภายในช่วง window
  attemptWindowMs?: number
  /** true = รหัสผ่านถูกแล้วยังต้องรอ superadmin กดอนุมัติ · false = การออกรหัสให้ถือเป็นการอนุมัติ (ค่าเริ่มต้น) */
  requireApproval?: boolean
  /** ผิดรหัสผ่านเปิดใช้งานเกินกี่ครั้งจึงล็อก (ต้องออกรหัสใหม่) */
  maxCodeFailures?: number
}

/** เบอร์โทร → ตัวเลขล้วน (+66 → 0) เพื่อเทียบกัน */
export function normalizePhone(raw: string): string {
  let d = raw.replace(/\D/g, '')
  if (d.startsWith('66') && d.length === 11) d = '0' + d.slice(2)
  return d
}
export const normalizeCode = (raw: string) => raw.trim().toUpperCase()

// ── รหัสผ่านเปิดใช้งาน (superadmin สุ่มออกให้) ─────────────────────────────
// ตัวอักษรที่ไม่สับสนกัน (ตัด 0/O, 1/I/L) · 8 ตัว ≈ 40 บิต · แสดงแบบ XXXX-XXXX · เก็บเฉพาะแฮช scrypt
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export function generateActivationCode(): string {
  let c = ''
  for (let i = 0; i < 8; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return c.slice(0, 4) + '-' + c.slice(4)
}
export const normalizeActivation = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
export function hashActivation(code: string): string {
  const salt = randomBytes(16)
  return 'scrypt$' + salt.toString('hex') + '$' + scryptSync(normalizeActivation(code), salt, 32).toString('hex')
}
export function checkActivation(code: string, stored: string | null): boolean {
  // ไม่มีแฮช = ยังคำนวณเทียบกับค่าหลอก เพื่อให้เวลาตอบไม่บอกใบ้ว่ามีรหัสหรือไม่
  const [kind, saltHex, hashHex] = (stored ?? 'scrypt$00$00').split('$')
  const salt = Buffer.from(saltHex ?? '00', 'hex')
  const expected = Buffer.from(hashHex ?? '00', 'hex')
  const actual = scryptSync(normalizeActivation(code), salt.length ? salt : Buffer.alloc(16), 32)
  if (!stored || kind !== 'scrypt' || expected.length !== 32) return false
  return timingSafeEqual(actual, expected)
}

export function canAccess(app: AppEntry, roles: UserRoleEntry[]): boolean {
  if (!app.active) return false
  if (app.requiredRole === 'guest') return true
  // ไม่ระบุบทบาท = ผู้ใช้ที่ยืนยันตัวตนแล้วทุกคน (guest ไม่เห็น)
  if (!app.requiredRole) return roles.some(r => r.roleCode !== 'guest')
  const all = roles.map(r => r.roleCode)
  if (all.includes('superadmin' as RoleCode)) return true
  return roles.some(r => r.roleCode === app.requiredRole && (r.appId === null || r.appId === app.id))
}

export class HubService {
  private now: () => Date
  private maxFailed: number
  private windowMs: number
  private requireApproval: boolean
  private maxCodeFailures: number

  constructor(private store: Store, private line: LineApi, private menu: MenuSets, o: HubOptions = {}) {
    this.now = o.now ?? (() => new Date())
    this.maxFailed = o.maxFailedAttempts ?? 5
    this.windowMs = o.attemptWindowMs ?? 60 * 60 * 1000
    this.requireApproval = o.requireApproval ?? false
    this.maxCodeFailures = o.maxCodeFailures ?? 5
  }

  /** บันทึกกิจกรรม — ห้ามทำให้งานหลักล้มเหลวถ้าบันทึกไม่สำเร็จ (ไม่เก็บรหัสผ่าน/เบอร์/LINE userId) */
  async audit(actor: string, action: string, target?: string | null, detail?: unknown) {
    try { await this.store.addAudit({ actor, action, target, detail }) } catch { /* ignore */ }
  }

  // ── superadmin ออกรหัสผ่านเปิดใช้งาน ─────────────────────────────────
  /** ออก/ออกใหม่ — คืนรหัสแบบตัวอักษรจริง "ครั้งเดียว" (ในฐานข้อมูลเก็บเฉพาะแฮช) */
  async issueCode(userId: string, issuedBy: string, hours = 72) {
    const user = await this.mustUser(userId)
    if (user.status === 'ACTIVE') throw new HttpError(409, 'พนักงานคนนี้ผูก LINE อยู่แล้ว — ยกเลิกการผูกก่อนจึงออกรหัสใหม่ได้', 'ALREADY_ACTIVE')
    const code = generateActivationCode()
    const expiresAt = new Date(this.now().getTime() + Math.min(Math.max(hours, 1), 24 * 30) * 3600 * 1000)
    await this.store.updateUser(user.id, { activationHash: hashActivation(code), activationExpiresAt: expiresAt, activationIssuedBy: issuedBy, activationFailed: 0 })
    return { employeeCode: user.employeeCode, displayName: user.displayName, code, expiresAt }
  }

  /** ออกรหัสให้ทุกคนที่ยังไม่ผูก LINE (สถานะ INVITED) — ใช้ตอนเปิดใช้งานทั้งบริษัท */
  async issueAll(issuedBy: string, hours = 72) {
    const out: { employeeCode: string; displayName: string; phone: string; code: string; expiresAt: Date }[] = []
    for (const u of await this.store.listUsers('INVITED')) {
      const r = await this.issueCode(u.id, issuedBy, hours)
      out.push({ employeeCode: r.employeeCode, displayName: r.displayName, phone: u.phone, code: r.code, expiresAt: r.expiresAt })
    }
    return out
  }

  // ── ยืนยันตัวตน (พนักงานกดจาก LIFF): รหัสพนักงาน + เบอร์โทร + รหัสผ่านจาก superadmin ──
  async requestVerification(input: { lineUserId: string; displayName: string | null; employeeCode: string; phone: string; password: string }) {
    const since = new Date(this.now().getTime() - this.windowMs)
    if ((await this.store.countFailedAttempts(input.lineUserId, since)) >= this.maxFailed) {
      throw new HttpError(429, 'ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่ หรือติดต่อผู้ดูแลระบบ', 'TOO_MANY_ATTEMPTS')
    }
    const user = await this.store.findUserByCode(normalizeCode(input.employeeCode))

    // ผูกกับ LINE บัญชีนี้อยู่แล้ว = ตอบ APPROVED เลย (ไม่ต้องใช้รหัสซ้ำ)
    if (user && user.status === 'ACTIVE' && user.lineUserId === input.lineUserId && user.phone === normalizePhone(input.phone)) {
      return { status: 'APPROVED' as const }
    }

    const codeUsable = !!user && !!user.activationHash && !!user.activationExpiresAt && user.activationExpiresAt > this.now() && user.activationFailed < this.maxCodeFailures
    const phoneOk = !!user && user.phone === normalizePhone(input.phone)
    const codeOk = checkActivation(input.password, user?.activationHash ?? null)
    const holder = await this.store.findUserByLineId(input.lineUserId)
    const lineFree = !holder || holder.id === user?.id
    const ok = !!user && codeUsable && phoneOk && codeOk && lineFree && (user.lineUserId === null || user.lineUserId === input.lineUserId)

    if (!ok || !user) {
      await this.store.recordAttempt(input.lineUserId, false)
      // นับความพยายามผิดที่ตัวพนักงานด้วย — ครบ 5 ครั้งรหัสถูกล็อก ต้องให้ superadmin ออกรหัสใหม่
      if (user?.activationHash) await this.store.updateUser(user.id, { activationFailed: user.activationFailed + 1 })
      await this.audit('verify', 'verify.fail', input.employeeCode.slice(0, 50), { lockedNow: !!user && user.activationFailed + 1 >= this.maxCodeFailures })
      throw new HttpError(422, 'ข้อมูลไม่ถูกต้อง หรือรหัสผ่านหมดอายุ/ถูกล็อก กรุณาตรวจสอบอีกครั้ง หรือติดต่อผู้ดูแลระบบ (superadmin) เพื่อขอรหัสใหม่', 'VERIFY_MISMATCH')
    }
    await this.store.recordAttempt(input.lineUserId, true)

    const issuedBy = user.activationIssuedBy ?? 'unknown'
    await this.audit(user.employeeCode, 'verify.success', user.employeeCode, { issuedBy, needsApproval: this.requireApproval })
    // รหัสใช้ได้ครั้งเดียว — ใช้แล้วลบทิ้งทันที
    await this.store.updateUser(user.id, { activationHash: null, activationExpiresAt: null, activationFailed: 0 })

    if (!this.requireApproval) {
      // superadmin เป็นคนออกรหัสให้ ถือว่าอนุมัติแล้ว — บันทึกเป็นคำขอที่อนุมัติโดยผู้ออกรหัส (เก็บประวัติไว้ตรวจสอบ)
      const req = await this.store.createRequest({ userId: user.id, lineUserId: input.lineUserId, lineDisplayName: input.displayName })
      const r = await this.activate(user, req, issuedBy)
      return { status: 'APPROVED' as const, requestId: req.id, menu: r.menu }
    }

    const pending = await this.store.findPendingRequestByLine(input.lineUserId)
    if (pending) await this.store.updateRequest(pending.id, { status: 'REJECTED', decidedBy: 'system:replaced', decidedAt: this.now() })
    const req = await this.store.createRequest({ userId: user.id, lineUserId: input.lineUserId, lineDisplayName: input.displayName })
    return { status: 'PENDING' as const, requestId: req.id }
  }

  async verificationStatus(lineUserId: string) {
    const user = await this.store.findUserByLineId(lineUserId)
    if (user && user.status === 'ACTIVE') return { status: 'APPROVED' as const }
    const latest = await this.store.latestRequestByLine(lineUserId)
    return { status: latest ? latest.status : ('NONE' as const) }
  }

  // ── แอดมิน ──────────────────────────────────────────────────────────
  async approve(requestId: string, decidedBy: string): Promise<{ user: User; menu: MenuSyncResult }> {
    const req = await this.mustPending(requestId)
    const user = await this.store.getUser(req.userId)
    if (!user) throw new HttpError(404, 'ไม่พบผู้ใช้', 'NOT_FOUND')
    return this.activate(user, req, decidedBy)
  }

  /** ผูก LINE กับพนักงาน + ตั้งบทบาทเริ่มต้น + ผูก Rich Menu (ใช้ทั้งตอนอนุมัติและตอนใส่รหัสผ่านถูกแล้วอนุมัติอัตโนมัติ) */
  private async activate(user: User, req: VerificationRequest, decidedBy: string): Promise<{ user: User; menu: MenuSyncResult }> {
    const holder = await this.store.findUserByLineId(req.lineUserId)
    if (holder && holder.id !== user.id) throw new HttpError(409, 'บัญชี LINE นี้ผูกกับพนักงานคนอื่นอยู่แล้ว', 'LINE_ALREADY_LINKED')
    if (user.lineUserId && user.lineUserId !== req.lineUserId) throw new HttpError(409, 'พนักงานคนนี้ผูกกับบัญชี LINE อื่นอยู่แล้ว — ยกเลิกการผูกเดิมก่อน', 'USER_ALREADY_LINKED')

    const updated = await this.store.updateUser(user.id, { lineUserId: req.lineUserId, status: 'ACTIVE', linkedAt: this.now() })
    if ((await this.store.getRoles(user.id)).length === 0) await this.store.setRoles(user.id, [{ roleCode: 'staff', appId: null }])
    await this.store.updateRequest(req.id, { status: 'APPROVED', decidedBy, decidedAt: this.now() })
    return { user: updated, menu: await this.syncUserMenu(updated.id) }
  }

  async reject(requestId: string, decidedBy: string): Promise<VerificationRequest> {
    const req = await this.mustPending(requestId)
    return this.store.updateRequest(req.id, { status: 'REJECTED', decidedBy, decidedAt: this.now() })
  }

  /** จำนวน superadmin ที่ ACTIVE (ไม่นับ excludeId) */
  private async otherSuperadmins(excludeId: string) {
    let n = 0
    for (const u of await this.store.listUsers('ACTIVE')) {
      if (u.id !== excludeId && (await this.store.getRoles(u.id)).some(r => r.roleCode === 'superadmin')) n++
    }
    return n
  }

  async setRoles(userId: string, roles: UserRoleEntry[]) {
    const user = await this.mustUser(userId)
    const wasSuper = (await this.store.getRoles(user.id)).some(r => r.roleCode === 'superadmin')
    if (wasSuper && !roles.some(r => r.roleCode === 'superadmin') && (await this.otherSuperadmins(user.id)) === 0) {
      throw new HttpError(409, 'ถอดสิทธิ์ superadmin คนสุดท้ายไม่ได้ — ตั้งคนอื่นเป็น superadmin ก่อน', 'LAST_SUPERADMIN')
    }
    // กัน role ซ้ำ (unique ของ MySQL ไม่กัน app_id = NULL)
    const uniq = roles.filter((r, i) => roles.findIndex(x => x.roleCode === r.roleCode && x.appId === r.appId) === i)
    await this.store.setRoles(user.id, uniq)
    return { roles: uniq, menu: await this.syncUserMenu(user.id) }
  }

  /** ยกเลิกการผูก (เช่น ลาออก): ถอดเมนูรายคนกลับเป็น guest, ล้าง LINE userId, สถานะ INACTIVE */
  async unlink(userId: string) {
    const user = await this.mustUser(userId)
    if ((await this.store.getRoles(user.id)).some(r => r.roleCode === 'superadmin') && (await this.otherSuperadmins(user.id)) === 0) {
      throw new HttpError(409, 'ยกเลิกการผูก superadmin คนสุดท้ายไม่ได้ — ตั้งคนอื่นเป็น superadmin ก่อน', 'LAST_SUPERADMIN')
    }
    let menu: MenuSyncResult = { ok: true, menu: null }
    if (user.lineUserId) {
      try { await this.line.unlinkMenu(user.lineUserId) } catch (e) { menu = { ok: false, menu: null, error: (e as Error).message } }
    }
    const updated = await this.store.updateUser(user.id, { lineUserId: null, status: 'INACTIVE' })
    return { user: updated, menu }
  }

  // ── Rich Menu รายคน ─────────────────────────────────────────────────
  async syncUserMenu(userId: string): Promise<MenuSyncResult> {
    const user = await this.store.getUser(userId)
    if (!user || !user.lineUserId) return { ok: true, menu: null }
    try {
      const roles = (await this.store.getRoles(user.id)).map(r => r.roleCode)
      const alias = user.status === 'ACTIVE' ? entryAliasForRoles(this.menu, roles) : null
      if (!alias) { await this.line.unlinkMenu(user.lineUserId); return { ok: true, menu: null } }
      const menuId = await this.line.getAliasMenuId(alias)
      if (!menuId) return { ok: false, menu: alias, error: `ไม่พบ Rich Menu alias "${alias}" ใน OA — รัน npm run richmenu:sync ก่อน` }
      await this.line.linkMenu(user.lineUserId, menuId)
      return { ok: true, menu: alias }
    } catch (e) {
      return { ok: false, menu: null, error: (e as Error).message }
    }
  }

  /** ผูกเมนูให้ทุกคนที่ ACTIVE ใหม่ — ต้องรันหลัง richmenu:sync เพราะเมนูเก่าถูกลบพร้อมการผูกรายคน */
  async relinkAll() {
    const users = await this.store.listUsers('ACTIVE')
    let ok = 0, failed = 0
    const errors: { userId: string; error: string }[] = []
    for (const u of users) {
      const r = await this.syncUserMenu(u.id)
      if (r.ok) ok++; else { failed++; errors.push({ userId: u.id, error: r.error ?? 'unknown' }) }
    }
    return { total: users.length, ok, failed, errors }
  }

  // ── ฝั่งผู้ใช้ ──────────────────────────────────────────────────────
  async me(lineUserId: string) {
    const user = await this.store.findUserByLineId(lineUserId)
    const apps = await this.store.listApps()
    if (!user || user.status !== 'ACTIVE') {
      const status = (await this.verificationStatus(lineUserId)).status
      return { user: null, status, roles: ['guest'] as RoleCode[], apps: apps.filter(a => canAccess(a, [{ roleCode: 'guest', appId: null }])).map(publicApp) }
    }
    const roles = await this.store.getRoles(user.id)
    return {
      user: { id: user.id, employeeCode: user.employeeCode, displayName: user.displayName },
      status: 'APPROVED' as const,
      roles: [...new Set(roles.map(r => r.roleCode))],
      apps: apps.filter(a => canAccess(a, roles)).map(publicApp),
    }
  }

  private async mustPending(id: string) {
    const req = await this.store.getRequest(id)
    if (!req) throw new HttpError(404, 'ไม่พบคำขอ', 'NOT_FOUND')
    if (req.status !== 'PENDING') throw new HttpError(409, 'คำขอนี้ถูกดำเนินการไปแล้ว', 'ALREADY_DECIDED')
    return req
  }
  private async mustUser(id: string) {
    const u = await this.store.getUser(id)
    if (!u) throw new HttpError(404, 'ไม่พบผู้ใช้', 'NOT_FOUND')
    return u
  }
}

const publicApp = (a: AppEntry) => ({ code: a.code, name: a.name, type: a.type, url: a.url, liffId: a.liffId, icon: a.icon, group: a.groupName, requiredRole: a.requiredRole })
