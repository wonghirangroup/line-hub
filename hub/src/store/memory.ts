// Store ในหน่วยความจำ — ใช้ในเทสต์ และรัน Hub ทดลองในเครื่องโดยไม่ต้องมี DB (HUB_STORE=memory)
import { randomUUID } from 'node:crypto'
import type { AuditEntry, MenuArea, RichMenuDef, AppEntry, RequestStatus, RosterRow, Store, User, UserRoleEntry, UserStatus, VerificationRequest } from '../types.js'

export class MemoryStore implements Store {
  users = new Map<string, User>()
  roles = new Map<string, UserRoleEntry[]>()
  requests = new Map<string, VerificationRequest>()
  attempts: { lineUserId: string; success: boolean; at: Date }[] = []
  apps = new Map<string, AppEntry>()
  now: () => Date = () => new Date()

  async findUserByCode(code: string) { return [...this.users.values()].find(u => u.employeeCode === code) ?? null }
  async findUserByLineId(lineUserId: string) { return [...this.users.values()].find(u => u.lineUserId === lineUserId) ?? null }
  async getUser(id: string) { return this.users.get(id) ?? null }
  async listUsers(status?: UserStatus) { return [...this.users.values()].filter(u => !status || u.status === status) }

  async upsertRoster(rows: RosterRow[]) {
    let created = 0, updated = 0
    for (const r of rows) {
      const ex = await this.findUserByCode(r.employeeCode)
      if (ex) {
        ex.displayName = r.displayName; ex.phone = r.phone; updated++
        if (r.roles) this.roles.set(ex.id, r.roles.map(roleCode => ({ roleCode, appId: null })))
      } else {
        const u: User = { id: randomUUID(), lineUserId: null, employeeCode: r.employeeCode, displayName: r.displayName, phone: r.phone, status: 'INVITED', linkedAt: null, activationHash: null, activationExpiresAt: null, activationIssuedBy: null, activationFailed: 0 }
        this.users.set(u.id, u)
        this.roles.set(u.id, (r.roles ?? ['staff']).map(roleCode => ({ roleCode, appId: null })))
        created++
      }
    }
    return { created, updated }
  }

  async updateUser(id: string, patch: Partial<User>) {
    const u = this.users.get(id)
    if (!u) throw new Error('user not found')
    Object.assign(u, patch)
    return u
  }

  async getRoles(userId: string) { return this.roles.get(userId) ?? [] }
  async setRoles(userId: string, roles: UserRoleEntry[]) { this.roles.set(userId, roles) }

  async createRequest(input: { userId: string; lineUserId: string; lineDisplayName: string | null }) {
    const r: VerificationRequest = { id: randomUUID(), ...input, status: 'PENDING', decidedBy: null, decidedAt: null, createdAt: this.now() }
    this.requests.set(r.id, r)
    return r
  }
  async getRequest(id: string) { return this.requests.get(id) ?? null }
  async findPendingRequestByLine(lineUserId: string) {
    return [...this.requests.values()].find(r => r.lineUserId === lineUserId && r.status === 'PENDING') ?? null
  }
  async latestRequestByLine(lineUserId: string) {
    const all = [...this.requests.values()].filter(r => r.lineUserId === lineUserId)
    return all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
  }
  async listRequests(status?: RequestStatus) {
    return [...this.requests.values()].filter(r => !status || r.status === status).map(r => ({ ...r, user: this.users.get(r.userId)! }))
  }
  async updateRequest(id: string, patch: Partial<VerificationRequest>) {
    const r = this.requests.get(id)
    if (!r) throw new Error('request not found')
    Object.assign(r, patch)
    return r
  }

  async recordAttempt(lineUserId: string, success: boolean) { this.attempts.push({ lineUserId, success, at: this.now() }) }
  async countFailedAttempts(lineUserId: string, since: Date) {
    return this.attempts.filter(a => a.lineUserId === lineUserId && !a.success && a.at >= since).length
  }

  menus = new Map<string, { def: RichMenuDef; image: { type: string; data: Buffer } | null }>()
  async listRichMenus() { return [...this.menus.values()].map(m => m.def) }
  async getRichMenu(key: string) { return this.menus.get(key)?.def ?? null }
  async upsertRichMenu(def: { key: string; width: number; height: number; chatBarText: string; areas: MenuArea[] }, by: string, opts: { clearImage?: boolean } = {}) {
    const ex = this.menus.get(def.key)
    const image = opts.clearImage ? null : ex?.image ?? null
    const d: RichMenuDef = { key: def.key, width: def.width, height: def.height, chatBarText: def.chatBarText, areas: def.areas, hasImage: !!image, imageType: image?.type ?? null, dirty: true, publishedAt: ex?.def.publishedAt ?? null, updatedBy: by }
    this.menus.set(def.key, { def: d, image })
    return d
  }
  async getRichMenuImage(key: string) { return this.menus.get(key)?.image ?? null }
  async setRichMenuImage(key: string, type: string, data: Buffer, by: string) {
    const m = this.menus.get(key)
    if (!m) throw new Error('menu not found')
    m.image = { type, data }
    Object.assign(m.def, { hasImage: true, imageType: type, dirty: true, updatedBy: by })
  }
  async markRichMenusPublished(keys: string[]) {
    for (const k of keys) { const m = this.menus.get(k); if (m) Object.assign(m.def, { dirty: false, publishedAt: this.now() }) }
  }

  audit: AuditEntry[] = []
  async addAudit(e: { actor: string; action: string; target?: string | null; detail?: unknown }) {
    this.audit.push({ id: String(this.audit.length + 1), actor: e.actor, action: e.action, target: e.target ?? null, detail: e.detail ?? null, createdAt: this.now() })
  }
  async listAudit(opts: { limit: number; actionPrefix?: string }) {
    return this.audit.filter(a => !opts.actionPrefix || a.action.startsWith(opts.actionPrefix)).slice().reverse().slice(0, opts.limit)
  }
  async attemptsSince(since: Date) { return this.attempts.filter(a => a.at >= since).map(a => ({ success: a.success, at: a.at })) }

  async listApps() { return [...this.apps.values()].sort((a, b) => a.sortOrder - b.sortOrder) }
  async upsertApp(app: Omit<AppEntry, 'id'>) {
    const ex = [...this.apps.values()].find(a => a.code === app.code)
    const entry: AppEntry = { id: ex?.id ?? randomUUID(), ...app }
    this.apps.set(entry.id, entry)
    return entry
  }
}
