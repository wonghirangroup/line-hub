// Store บน Prisma + MariaDB (production)
import { PrismaClient, type Prisma } from '@prisma/client'
import type { AuditEntry, MenuArea, RichMenuDef, AppEntry, RequestStatus, RoleCode, RosterRow, Store, User, UserRoleEntry, UserStatus, VerificationRequest } from '../types.js'

type UserRow = Prisma.UserGetPayload<object>
type ReqRow = Prisma.VerificationRequestGetPayload<object>
type AppRow = Prisma.AppGetPayload<object>

const toUser = (r: UserRow): User => ({
  id: r.id, lineUserId: r.line_user_id, employeeCode: r.employee_code, displayName: r.display_name,
  phone: r.phone, status: r.status, linkedAt: r.linked_at,
  activationHash: r.activation_hash, activationExpiresAt: r.activation_expires_at,
  activationIssuedBy: r.activation_issued_by, activationFailed: r.activation_failed,
})
const toReq = (r: ReqRow): VerificationRequest => ({
  id: r.id, userId: r.user_id, lineUserId: r.line_user_id, lineDisplayName: r.line_display_name,
  status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at, createdAt: r.created_at,
})
const toApp = (r: AppRow): AppEntry => ({
  id: r.id, code: r.code, name: r.name, type: r.type === 'liff' ? 'liff' : 'uri', url: r.url, liffId: r.liff_id,
  icon: r.icon, requiredRole: r.required_role, groupName: r.group_name, sortOrder: r.sort_order, active: r.active,
})

type MenuRow = Prisma.RichMenuGetPayload<{ select: { menu_key: true; width: true; height: true; chat_bar_text: true; areas: true; image_type: true; dirty: true; published_at: true; updated_by: true } }> & { image?: unknown }
const MENU_SELECT = { menu_key: true, width: true, height: true, chat_bar_text: true, areas: true, image_type: true, dirty: true, published_at: true, updated_by: true } as const
const toMenu = (r: MenuRow, hasImage: boolean): RichMenuDef => ({
  key: r.menu_key, width: r.width, height: r.height, chatBarText: r.chat_bar_text, areas: r.areas as unknown as MenuArea[],
  hasImage, imageType: r.image_type, dirty: r.dirty, publishedAt: r.published_at, updatedBy: r.updated_by,
})

export class PrismaStore implements Store {
  constructor(private db: PrismaClient = new PrismaClient()) {}

  /** สร้าง role พื้นฐานถ้ายังไม่มี (เรียกตอนเริ่มระบบ) */
  async ensureRoles(aliases: Partial<Record<RoleCode, string>> = {}) {
    for (const code of ['guest', 'staff', 'driver', 'admin', 'superadmin'] as RoleCode[]) {
      await this.db.role.upsert({ where: { code }, update: { rich_menu_alias: aliases[code] ?? null }, create: { code, rich_menu_alias: aliases[code] ?? null } })
    }
  }

  async findUserByCode(code: string) { const r = await this.db.user.findUnique({ where: { employee_code: code } }); return r ? toUser(r) : null }
  async findUserByLineId(lineUserId: string) { const r = await this.db.user.findUnique({ where: { line_user_id: lineUserId } }); return r ? toUser(r) : null }
  async getUser(id: string) { const r = await this.db.user.findUnique({ where: { id } }); return r ? toUser(r) : null }
  async listUsers(status?: UserStatus) {
    return (await this.db.user.findMany({ where: status ? { status } : {}, orderBy: { employee_code: 'asc' } })).map(toUser)
  }

  async upsertRoster(rows: RosterRow[]) {
    let created = 0, updated = 0
    for (const r of rows) {
      const ex = await this.db.user.findUnique({ where: { employee_code: r.employeeCode } })
      if (ex) {
        await this.db.user.update({ where: { id: ex.id }, data: { display_name: r.displayName, phone: r.phone } })
        if (r.roles) await this.setRoles(ex.id, r.roles.map(roleCode => ({ roleCode, appId: null })))
        updated++
      } else {
        const u = await this.db.user.create({ data: { employee_code: r.employeeCode, display_name: r.displayName, phone: r.phone } })
        await this.setRoles(u.id, (r.roles ?? ['staff']).map(roleCode => ({ roleCode, appId: null })))
        created++
      }
    }
    return { created, updated }
  }

  async updateUser(id: string, patch: Partial<User>) {
    const data: Prisma.UserUpdateInput = {}
    if ('lineUserId' in patch) data.line_user_id = patch.lineUserId ?? null
    if (patch.status) data.status = patch.status
    if ('linkedAt' in patch) data.linked_at = patch.linkedAt ?? null
    if (patch.displayName) data.display_name = patch.displayName
    if (patch.phone) data.phone = patch.phone
    if ('activationHash' in patch) data.activation_hash = patch.activationHash ?? null
    if ('activationExpiresAt' in patch) data.activation_expires_at = patch.activationExpiresAt ?? null
    if ('activationIssuedBy' in patch) data.activation_issued_by = patch.activationIssuedBy ?? null
    if (patch.activationFailed !== undefined) data.activation_failed = patch.activationFailed
    return toUser(await this.db.user.update({ where: { id }, data }))
  }

  async getRoles(userId: string): Promise<UserRoleEntry[]> {
    return (await this.db.userRole.findMany({ where: { user_id: userId } })).map(r => ({ roleCode: r.role_code as RoleCode, appId: r.app_id }))
  }
  async setRoles(userId: string, roles: UserRoleEntry[]) {
    await this.db.$transaction([
      this.db.userRole.deleteMany({ where: { user_id: userId } }),
      this.db.userRole.createMany({ data: roles.map(r => ({ user_id: userId, role_code: r.roleCode, app_id: r.appId })) }),
    ])
  }

  async createRequest(input: { userId: string; lineUserId: string; lineDisplayName: string | null }) {
    return toReq(await this.db.verificationRequest.create({ data: { user_id: input.userId, line_user_id: input.lineUserId, line_display_name: input.lineDisplayName } }))
  }
  async getRequest(id: string) { const r = await this.db.verificationRequest.findUnique({ where: { id } }); return r ? toReq(r) : null }
  async findPendingRequestByLine(lineUserId: string) {
    const r = await this.db.verificationRequest.findFirst({ where: { line_user_id: lineUserId, status: 'PENDING' } })
    return r ? toReq(r) : null
  }
  async latestRequestByLine(lineUserId: string) {
    const r = await this.db.verificationRequest.findFirst({ where: { line_user_id: lineUserId }, orderBy: { created_at: 'desc' } })
    return r ? toReq(r) : null
  }
  async listRequests(status?: RequestStatus) {
    const rows = await this.db.verificationRequest.findMany({ where: status ? { status } : {}, include: { user: true }, orderBy: { created_at: 'desc' } })
    return rows.map(r => ({ ...toReq(r), user: toUser(r.user) }))
  }
  async updateRequest(id: string, patch: Partial<VerificationRequest>) {
    const data: Prisma.VerificationRequestUpdateInput = {}
    if (patch.status) data.status = patch.status
    if ('decidedBy' in patch) data.decided_by = patch.decidedBy ?? null
    if ('decidedAt' in patch) data.decided_at = patch.decidedAt ?? null
    if ('lineDisplayName' in patch) data.line_display_name = patch.lineDisplayName ?? null
    return toReq(await this.db.verificationRequest.update({ where: { id }, data }))
  }

  async recordAttempt(lineUserId: string, success: boolean) { await this.db.verificationAttempt.create({ data: { line_user_id: lineUserId, success } }) }
  async countFailedAttempts(lineUserId: string, since: Date) {
    return this.db.verificationAttempt.count({ where: { line_user_id: lineUserId, success: false, created_at: { gte: since } } })
  }

  // ภาพไม่ถูกดึงมาตอน list (ใหญ่) — ใช้ image_type ที่ไม่ว่างเป็นตัวบอกว่ามีภาพ
  async listRichMenus() {
    const rows = await this.db.richMenu.findMany({ select: MENU_SELECT, orderBy: { menu_key: 'asc' } })
    return rows.map(r => toMenu(r, !!r.image_type))
  }
  async getRichMenu(key: string) {
    const r = await this.db.richMenu.findUnique({ where: { menu_key: key }, select: MENU_SELECT })
    return r ? toMenu(r, !!r.image_type) : null
  }
  async upsertRichMenu(def: { key: string; width: number; height: number; chatBarText: string; areas: MenuArea[] }, by: string, opts: { clearImage?: boolean } = {}) {
    const data = { width: def.width, height: def.height, chat_bar_text: def.chatBarText, areas: def.areas as unknown as Prisma.InputJsonValue, dirty: true, updated_by: by }
    const clear = opts.clearImage ? { image: null, image_type: null } : {}
    const r = await this.db.richMenu.upsert({ where: { menu_key: def.key }, update: { ...data, ...clear }, create: { menu_key: def.key, ...data }, select: MENU_SELECT })
    return toMenu(r, !!r.image_type)
  }
  async getRichMenuImage(key: string) {
    const r = await this.db.richMenu.findUnique({ where: { menu_key: key }, select: { image: true, image_type: true } })
    return r?.image && r.image_type ? { type: r.image_type, data: Buffer.from(r.image) } : null
  }
  async setRichMenuImage(key: string, type: string, data: Buffer, by: string) {
    await this.db.richMenu.update({ where: { menu_key: key }, data: { image: data, image_type: type, dirty: true, updated_by: by } })
  }
  async markRichMenusPublished(keys: string[]) {
    await this.db.richMenu.updateMany({ where: { menu_key: { in: keys } }, data: { dirty: false, published_at: new Date() } })
  }

  async addAudit(e: { actor: string; action: string; target?: string | null; detail?: unknown }) {
    await this.db.auditLog.create({ data: { actor: e.actor.slice(0, 190), action: e.action.slice(0, 190), target: e.target?.slice(0, 190) ?? null, detail: (e.detail ?? undefined) as Prisma.InputJsonValue | undefined } })
  }
  async listAudit(opts: { limit: number; actionPrefix?: string }): Promise<AuditEntry[]> {
    const rows = await this.db.auditLog.findMany({ where: opts.actionPrefix ? { action: { startsWith: opts.actionPrefix } } : {}, orderBy: { created_at: 'desc' }, take: opts.limit })
    return rows.map(r => ({ id: r.id, actor: r.actor, action: r.action, target: r.target, detail: r.detail, createdAt: r.created_at }))
  }
  async attemptsSince(since: Date) {
    const rows = await this.db.verificationAttempt.findMany({ where: { created_at: { gte: since } }, select: { success: true, created_at: true }, take: 20000 })
    return rows.map(r => ({ success: r.success, at: r.created_at }))
  }

  async listApps() { return (await this.db.app.findMany({ orderBy: { sort_order: 'asc' } })).map(toApp) }
  async upsertApp(app: Omit<AppEntry, 'id'>) {
    const data = { name: app.name, type: app.type, url: app.url, liff_id: app.liffId, icon: app.icon, required_role: app.requiredRole, group_name: app.groupName, sort_order: app.sortOrder, active: app.active }
    return toApp(await this.db.app.upsert({ where: { code: app.code }, update: data, create: { code: app.code, ...data } }))
  }
}
