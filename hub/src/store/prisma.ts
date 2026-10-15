// Store บน Prisma + MariaDB (production)
import { PrismaClient, type Prisma } from '@prisma/client'
import type { AppEntry, RequestStatus, RoleCode, RosterRow, Store, User, UserRoleEntry, UserStatus, VerificationRequest } from '../types.js'

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
  icon: r.icon, requiredRole: r.required_role, sortOrder: r.sort_order, active: r.active,
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

  async listApps() { return (await this.db.app.findMany({ orderBy: { sort_order: 'asc' } })).map(toApp) }
  async upsertApp(app: Omit<AppEntry, 'id'>) {
    const data = { name: app.name, type: app.type, url: app.url, liff_id: app.liffId, icon: app.icon, required_role: app.requiredRole, sort_order: app.sortOrder, active: app.active }
    return toApp(await this.db.app.upsert({ where: { code: app.code }, update: data, create: { code: app.code, ...data } }))
  }
}
