import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { z, ZodError } from 'zod'
import { normalizeCode, normalizePhone, type HubService } from './service.js'
import { HttpError, ROLE_CODES, type LineApi, type LineIdentity, type RoleCode, type RosterRow, type Store, type User } from './types.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export interface AppDeps {
  service: HubService
  store: Store
  line: LineApi
  channelSecret: string
  adminToken: string
  verifyLiffId: string
  corsOrigins?: string[]
  logger?: boolean
}

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

const ok = <T>(data: T) => ({ success: true, data })

const RoleList = z.array(z.enum(ROLE_CODES as [RoleCode, ...RoleCode[]])).min(1)

export function buildApp(d: AppDeps): FastifyInstance {
  const app = Fastify({ logger: d.logger ?? false, bodyLimit: 1024 * 1024 })

  // ── CORS (เฉพาะ origin ที่อนุญาต เช่น ALL APP ในเฟส 3) ──
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin
    if (origin && d.corsOrigins?.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin)
      reply.header('Vary', 'Origin')
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
    }
    if (req.method === 'OPTIONS') return reply.code(204).send()
  })
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
  })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ success: false, error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ success: false, error: { code: 'BAD_REQUEST', message: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') } })
    app.log.error(err)
    return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: 'เกิดข้อผิดพลาดภายในระบบ' } })
  })

  // ── auth ──
  const bearer = (req: FastifyRequest) => {
    const h = req.headers.authorization
    return h?.startsWith('Bearer ') ? h.slice(7).trim() : ''
  }
  /** ผู้ใช้ทั่วไป: ตรวจ LIFF ID token กับ LINE ทุกครั้ง (ห้ามเชื่อ userId ที่ client ส่งมา) */
  const lineAuth = async (req: FastifyRequest): Promise<LineIdentity> => {
    const t = bearer(req)
    if (!t) throw new HttpError(401, 'ต้องแนบ LIFF ID token', 'UNAUTHORIZED')
    return d.line.verifyIdToken(t)
  }
  // ผู้กระทำฝั่งแอดมิน (บันทึกว่าใครอนุมัติ/ออกรหัส)
  const actors = new WeakMap<FastifyRequest, string>()
  /**
   * 2 ทางเข้า: (1) โทเค็นกลาง HUB_ADMIN_TOKEN สำหรับสคริปต์/ฉุกเฉิน (2) superadmin ที่ล็อกอินด้วย LINE (LIFF ID token)
   * ทางที่ 2 ตรวจจากฐานข้อมูลทุกครั้งว่ายังเป็น superadmin ที่ ACTIVE — เป็น admin ธรรมดาเข้าไม่ได้
   */
  const adminAuth = async (req: FastifyRequest, _reply: FastifyReply) => {
    const t = bearer(req)
    if (!t) throw new HttpError(401, 'ไม่มีสิทธิ์แอดมิน', 'UNAUTHORIZED')
    if (safeEqual(t, d.adminToken)) {
      const name = String(req.headers['x-admin-name'] ?? '').slice(0, 40)
      actors.set(req, name ? 'token:' + name : 'token')
      return
    }
    let id: LineIdentity
    try { id = await d.line.verifyIdToken(t) } catch { throw new HttpError(401, 'ไม่มีสิทธิ์แอดมิน', 'UNAUTHORIZED') }
    const user = await d.store.findUserByLineId(id.sub)
    const roles = user && user.status === 'ACTIVE' ? await d.store.getRoles(user.id) : []
    if (!user || !roles.some(r => r.roleCode === 'superadmin')) throw new HttpError(403, 'เฉพาะ superadmin เท่านั้น', 'FORBIDDEN')
    actors.set(req, user.employeeCode + ' ' + user.displayName)
  }
  const adminName = (req: FastifyRequest) => actors.get(req) ?? 'unknown'
  const publicUser = (u: User) => {
    const { activationHash, ...rest } = u
    return { ...rest, hasActivationCode: !!activationHash }
  }

  app.get('/health', async () => ({ ok: true }))

  // ── หน้ายืนยันตัวตน (LIFF) ──
  const page = (file: string) => readFileSync(path.resolve(HERE, '..', 'public', file), 'utf8')
  const verifyHtml = page('verify.html')
  const adminHtml = page('admin.html')
  const sendPage = (reply: FastifyReply, html: string) => reply
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('X-Frame-Options', 'DENY')
    .header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.line-scdn.net; connect-src 'self' https://*.line.me https://*.line-scdn.net; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
    .send(html)
  app.get('/verify', async (_req, reply) => sendPage(reply, verifyHtml))
  // หน้าจัดการสำหรับ superadmin — เปิดผ่าน LIFF เดียวกัน: https://liff.line.me/<LIFF ID>/admin (LINE ต่อ path ท้าย endpoint)
  app.get('/verify/admin', async (_req, reply) => sendPage(reply, adminHtml))
  app.get('/verify/config.js', async (_req, reply) => {
    reply.header('Content-Type', 'application/javascript; charset=utf-8').send(`window.HUB_CONFIG = ${JSON.stringify({ liffId: d.verifyLiffId })};`)
  })

  // ── LINE webhook (ตรวจลายเซ็นจาก raw body) ──
  app.register(async s => {
    s.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
    s.post('/webhook', async (req, reply) => {
      const raw = req.body as Buffer
      const sig = String(req.headers['x-line-signature'] ?? '')
      const expected = createHmac('sha256', d.channelSecret).update(raw).digest('base64')
      if (!sig || !safeEqual(sig, expected)) return reply.code(401).send({ success: false, error: { code: 'BAD_SIGNATURE', message: 'ลายเซ็นไม่ถูกต้อง' } })
      const body = JSON.parse(raw.toString('utf8')) as { events?: { type: string; source?: { userId?: string } }[] }
      for (const ev of body.events ?? []) {
        const uid = ev.source?.userId
        // follow: คนที่เคยผูกแล้วกลับมาเพิ่มเพื่อนใหม่ → คืนเมนูตามบทบาท · คนใหม่ได้เมนู guest (default ของ OA) อยู่แล้ว
        if (ev.type === 'follow' && uid) {
          const user = await d.store.findUserByLineId(uid)
          if (user) await d.service.syncUserMenu(user.id)
        }
      }
      return reply.code(200).send({ ok: true })
    })
  })

  // ── ผู้ใช้ (ต้องมี LIFF ID token) ──
  app.post('/api/verify/request', async req => {
    const id = await lineAuth(req)
    const body = z.object({ employee_code: z.string().trim().min(1).max(50), phone: z.string().trim().min(8).max(20), password: z.string().trim().min(4).max(40) }).parse(req.body)
    const r = await d.service.requestVerification({ lineUserId: id.sub, displayName: id.name, employeeCode: normalizeCode(body.employee_code), phone: body.phone, password: body.password })
    return ok({ status: r.status })
  })
  app.get('/api/verify/status', async req => ok(await d.service.verificationStatus((await lineAuth(req)).sub)))
  app.get('/api/me', async req => ok(await d.service.me((await lineAuth(req)).sub)))

  // ── แอดมิน (Bearer HUB_ADMIN_TOKEN) ──
  app.register(async s => {
    s.addHook('preHandler', adminAuth)

    s.get('/api/admin/users', async req => {
      const q = z.object({ status: z.enum(['INVITED', 'ACTIVE', 'INACTIVE']).optional() }).parse(req.query)
      const users = await d.store.listUsers(q.status)
      return ok(await Promise.all(users.map(async u => ({ ...publicUser(u), roles: await d.store.getRoles(u.id) }))))
    })

    s.post('/api/admin/users/import', async req => {
      const body = z.object({
        users: z.array(z.object({
          employee_code: z.string().trim().min(1).max(50),
          display_name: z.string().trim().min(1).max(120),
          phone: z.string().trim().min(8).max(20),
          roles: RoleList.optional(),
        })).min(1).max(2000),
      }).parse(req.body)
      const rows: RosterRow[] = body.users.map(u => ({ employeeCode: normalizeCode(u.employee_code), displayName: u.display_name, phone: normalizePhone(u.phone), roles: u.roles }))
      return ok(await d.store.upsertRoster(rows))
    })

    s.put('/api/admin/users/:id/roles', async req => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const body = z.object({ roles: RoleList }).parse(req.body)
      return ok(await d.service.setRoles(id, body.roles.map(roleCode => ({ roleCode, appId: null }))))
    })

    s.get('/api/admin/whoami', async req => ok({ actor: adminName(req) }))

    // superadmin ออก/ออกใหม่รหัสผ่านเปิดใช้งาน (สุ่มให้ แสดงครั้งเดียว ใช้ครั้งเดียว มีวันหมดอายุ)
    s.post('/api/admin/users/:id/activation-code', async req => {
      const { id } = z.object({ id: z.string() }).parse(req.params)
      const b = z.object({ hours: z.number().int().min(1).max(720).default(72) }).parse(req.body ?? {})
      const r = await d.service.issueCode(id, adminName(req), b.hours)
      return ok({ employee_code: r.employeeCode, display_name: r.displayName, code: r.code, expires_at: r.expiresAt })
    })
    s.post('/api/admin/activation-codes/issue-all', async req => {
      const b = z.object({ hours: z.number().int().min(1).max(720).default(72) }).parse(req.body ?? {})
      const list = await d.service.issueAll(adminName(req), b.hours)
      return ok(list.map(r => ({ employee_code: r.employeeCode, display_name: r.displayName, phone: r.phone, code: r.code, expires_at: r.expiresAt })))
    })

    s.post('/api/admin/users/:id/unlink', async req => ok(await d.service.unlink(z.object({ id: z.string() }).parse(req.params).id)))

    s.get('/api/admin/verification-requests', async req => {
      const q = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }).parse(req.query)
      return ok(await d.store.listRequests(q.status))
    })
    s.post('/api/admin/verification-requests/:id/approve', async req =>
      ok(await d.service.approve(z.object({ id: z.string() }).parse(req.params).id, adminName(req))))
    s.post('/api/admin/verification-requests/:id/reject', async req =>
      ok(await d.service.reject(z.object({ id: z.string() }).parse(req.params).id, adminName(req))))

    s.get('/api/admin/apps', async () => ok(await d.store.listApps()))
    s.put('/api/admin/apps/:code', async req => {
      const { code } = z.object({ code: z.string().min(1).max(60) }).parse(req.params)
      const b = z.object({
        name: z.string().min(1).max(120), type: z.enum(['liff', 'uri']),
        url: z.string().url().nullable().optional(), liff_id: z.string().nullable().optional(),
        icon: z.string().max(20).nullable().optional(), required_role: z.string().nullable().optional(),
        sort_order: z.number().int().default(0), active: z.boolean().default(true),
      }).parse(req.body)
      return ok(await d.store.upsertApp({ code, name: b.name, type: b.type, url: b.url ?? null, liffId: b.liff_id ?? null, icon: b.icon ?? null, requiredRole: b.required_role ?? null, sortOrder: b.sort_order, active: b.active }))
    })

    s.post('/api/admin/relink-all', async () => ok(await d.service.relinkAll()))
  })

  return app
}
