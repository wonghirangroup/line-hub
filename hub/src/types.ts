// โดเมนของ LINE Hub — Store (ชั้นเก็บข้อมูล) และ LineApi (ชั้นคุยกับ LINE) เป็น interface
// เพื่อเทสต์ได้โดยไม่ต้องมีฐานข้อมูลหรือ LINE จริง

export type RoleCode = 'guest' | 'staff' | 'driver' | 'admin' | 'superadmin'
export const ROLE_CODES: RoleCode[] = ['guest', 'staff', 'driver', 'admin', 'superadmin']

export type UserStatus = 'INVITED' | 'ACTIVE' | 'INACTIVE'
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

export interface User {
  id: string
  lineUserId: string | null
  employeeCode: string
  displayName: string
  phone: string // ตัวเลขล้วน
  status: UserStatus
  linkedAt: Date | null
  activationHash: string | null
  activationExpiresAt: Date | null
  activationIssuedBy: string | null
  activationFailed: number
}

export interface UserRoleEntry { roleCode: RoleCode; appId: string | null }

export interface AppEntry {
  id: string
  code: string
  name: string
  type: 'liff' | 'uri'
  url: string | null
  liffId: string | null
  icon: string | null
  requiredRole: string | null
  sortOrder: number
  active: boolean
}

export interface VerificationRequest {
  id: string
  userId: string
  lineUserId: string
  lineDisplayName: string | null
  status: RequestStatus
  decidedBy: string | null
  decidedAt: Date | null
  createdAt: Date
}

// ── Rich Menu ที่แก้ได้จากหน้าเว็บ ──
export type MenuAction =
  | { type: 'uri'; uri: string }
  | { type: 'liff'; liffId: string; path?: string }
  | { type: 'tab'; target: string } // สลับไปแท็บอื่นในชุดเดียวกัน (target = คีย์เมนู เช่น member-web)
  | { type: 'message'; text: string }
export interface MenuArea { x: number; y: number; width: number; height: number; label: string; action: MenuAction }
export interface RichMenuDef {
  key: string
  width: number
  height: number
  chatBarText: string
  areas: MenuArea[]
  hasImage: boolean
  imageType: string | null
  dirty: boolean // แก้ไขแล้วแต่ยังไม่เผยแพร่
  publishedAt: Date | null
  updatedBy: string | null
}

export interface RosterRow { employeeCode: string; displayName: string; phone: string; roles?: RoleCode[] }

export interface Store {
  // users
  findUserByCode(code: string): Promise<User | null>
  findUserByLineId(lineUserId: string): Promise<User | null>
  getUser(id: string): Promise<User | null>
  listUsers(status?: UserStatus): Promise<User[]>
  /** นำเข้า/อัปเดตรายชื่อ (ไม่แตะผู้ใช้ที่ผูก LINE แล้วนอกจากชื่อ/เบอร์) */
  upsertRoster(rows: RosterRow[]): Promise<{ created: number; updated: number }>
  updateUser(id: string, patch: Partial<Pick<User, 'lineUserId' | 'status' | 'linkedAt' | 'displayName' | 'phone' | 'activationHash' | 'activationExpiresAt' | 'activationIssuedBy' | 'activationFailed'>>): Promise<User>
  // roles
  getRoles(userId: string): Promise<UserRoleEntry[]>
  setRoles(userId: string, roles: UserRoleEntry[]): Promise<void>
  // verification requests
  createRequest(input: { userId: string; lineUserId: string; lineDisplayName: string | null }): Promise<VerificationRequest>
  getRequest(id: string): Promise<VerificationRequest | null>
  findPendingRequestByLine(lineUserId: string): Promise<VerificationRequest | null>
  latestRequestByLine(lineUserId: string): Promise<VerificationRequest | null>
  listRequests(status?: RequestStatus): Promise<(VerificationRequest & { user: User })[]>
  updateRequest(id: string, patch: Partial<Pick<VerificationRequest, 'status' | 'decidedBy' | 'decidedAt' | 'lineDisplayName'>>): Promise<VerificationRequest>
  // attempts (กันเดารหัสพนักงาน/เบอร์)
  recordAttempt(lineUserId: string, success: boolean): Promise<void>
  countFailedAttempts(lineUserId: string, since: Date): Promise<number>
  // rich menus
  listRichMenus(): Promise<RichMenuDef[]>
  getRichMenu(key: string): Promise<RichMenuDef | null>
  upsertRichMenu(def: { key: string; width: number; height: number; chatBarText: string; areas: MenuArea[] }, by: string, opts?: { clearImage?: boolean }): Promise<RichMenuDef>
  getRichMenuImage(key: string): Promise<{ type: string; data: Buffer } | null>
  setRichMenuImage(key: string, type: string, data: Buffer, by: string): Promise<void>
  markRichMenusPublished(keys: string[]): Promise<void>
  // apps
  listApps(): Promise<AppEntry[]>
  upsertApp(app: Omit<AppEntry, 'id'>): Promise<AppEntry>
}

export interface LineIdentity { sub: string; name: string | null }

export interface LineApi {
  /** ตรวจ LIFF ID token กับ LINE (โยน error ถ้าไม่ผ่าน) */
  verifyIdToken(idToken: string): Promise<LineIdentity>
  getAliasMenuId(alias: string): Promise<string | null>
  linkMenu(lineUserId: string, richMenuId: string): Promise<void>
  unlinkMenu(lineUserId: string): Promise<void>
  // จัดการตัวเมนูใน OA (ใช้ตอนเผยแพร่)
  listMenus(): Promise<{ richMenuId: string; name: string }[]>
  createMenu(body: unknown): Promise<string>
  uploadMenuImage(richMenuId: string, data: Buffer, contentType: string): Promise<void>
  deleteMenu(richMenuId: string): Promise<void>
  listAliases(): Promise<{ richMenuAliasId: string; richMenuId: string }[]>
  createAlias(alias: string, richMenuId: string): Promise<void>
  deleteAlias(alias: string): Promise<void>
  setDefaultMenu(richMenuId: string): Promise<void>
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'ERROR') {
    super(message)
  }
}
