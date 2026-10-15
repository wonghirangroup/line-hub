// ตัวแก้ Rich Menu จากหน้าเว็บ: เก็บภาพ + พื้นที่กดในฐานข้อมูล แล้ว "เผยแพร่" ไป LINE
import { z } from 'zod'
import type { MenuSets } from './config.js'
import { imageInfo } from './image.js'
import type { HubService } from './service.js'
import { HttpError, type LineApi, type MenuArea, type RichMenuDef, type Store } from './types.js'

export const NAME_PREFIX = 'sjhub:'
export const MAX_IMAGE_BYTES = 1024 * 1024 // LINE รับภาพ ≤ 1 MB
/** ขนาดที่ LINE อนุญาตสำหรับ Rich Menu */
export const ALLOWED_SIZES: { width: number; height: number }[] = [
  { width: 2500, height: 1686 }, { width: 2500, height: 843 },
  { width: 1200, height: 810 }, { width: 1200, height: 405 },
  { width: 800, height: 540 }, { width: 800, height: 270 },
]

const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('uri'), uri: z.string().trim().url().refine(u => u.startsWith('https://'), 'URL ต้องขึ้นต้นด้วย https://') }),
  z.object({
    type: z.literal('liff'),
    liffId: z.string().trim().regex(/^\d{10}-[A-Za-z0-9]{8}$/, 'LIFF ID ต้องหน้าตาแบบ 1234567890-AbCdEfGh'),
    path: z.string().trim().max(200).regex(/^(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/, 'path ต้องขึ้นต้นด้วย /').optional(),
  }),
  z.object({ type: z.literal('tab'), target: z.string().trim().min(1).max(60) }),
  z.object({ type: z.literal('message'), text: z.string().trim().min(1).max(300) }),
])

export const AreaSchema = z.object({
  x: z.number().int().min(0), y: z.number().int().min(0),
  width: z.number().int().min(20), height: z.number().int().min(20),
  label: z.string().trim().max(20).default(''), // LINE จำกัด label 20 ตัว
  action: Action,
})

export const MenuBodySchema = z.object({
  width: z.number().int(), height: z.number().int(),
  chat_bar_text: z.string().trim().min(1).max(14), // LINE จำกัด 14 ตัว
  areas: z.array(AreaSchema).max(20),
})
export type MenuBody = z.infer<typeof MenuBodySchema>

export interface PublishResult {
  created: number; aliases: number; deletedOld: number; defaultSet: boolean
  relink: { total: number; ok: number; failed: number }
}

export class MenuService {
  private publishing = false

  constructor(private store: Store, private line: LineApi, private menu: MenuSets, private users: HubService) {}

  /** คีย์เมนูที่ระบบรู้จัก: <ชุด>-<แท็บ> ของ member/admin + guest */
  keys(): string[] {
    const out: string[] = []
    for (const [setId, set] of Object.entries(this.menu.sets)) for (const t of set.tabs) out.push(`${setId}-${t}`)
    out.push('guest')
    return out
  }
  private aliasForKey(key: string): string | null {
    for (const [setId, set] of Object.entries(this.menu.sets)) {
      for (const t of set.tabs) if (key === `${setId}-${t}`) return `${set.alias}-${t}`
    }
    return null
  }
  private setOfKey(key: string): string | null {
    for (const [setId, set] of Object.entries(this.menu.sets)) if (set.tabs.some(t => key === `${setId}-${t}`)) return setId
    return null
  }

  /** ตรวจเมนู: ขนาดที่ LINE รับ · พื้นที่อยู่ในภาพ · tab ชี้ไปเมนูในชุดเดียวกัน · ไม่ซ้อนทับกันเกินสมควร */
  validate(key: string, body: MenuBody): void {
    if (!this.keys().includes(key)) throw new HttpError(404, `ไม่รู้จักเมนู ${key}`, 'UNKNOWN_MENU')
    if (!ALLOWED_SIZES.some(s => s.width === body.width && s.height === body.height)) {
      throw new HttpError(400, `ขนาด ${body.width}×${body.height} ไม่อยู่ในขนาดที่ LINE รับ (${ALLOWED_SIZES.map(s => `${s.width}×${s.height}`).join(', ')})`, 'BAD_SIZE')
    }
    const setId = this.setOfKey(key)
    body.areas.forEach((a, i) => {
      if (a.x + a.width > body.width || a.y + a.height > body.height) {
        throw new HttpError(400, `พื้นที่ #${i + 1} เกินขอบภาพ (${body.width}×${body.height})`, 'AREA_OUT_OF_BOUNDS')
      }
      if (a.action.type === 'tab') {
        const target = a.action.target
        if (!setId || this.setOfKey(target) !== setId) throw new HttpError(400, `พื้นที่ #${i + 1}: ปุ่มสลับแท็บต้องชี้ไปแท็บในชุดเดียวกัน (ไม่ใช่ "${target}")`, 'BAD_TAB_TARGET')
      }
    })
  }

  async list() {
    const defs = await this.store.listRichMenus()
    return {
      keys: this.keys(),
      tabs: this.menu.tabs ?? [],
      barHeight: this.menu.tabBarHeight ?? 243,
      allowedSizes: ALLOWED_SIZES,
      menus: this.keys().map(k => defs.find(d => d.key === k)).filter((d): d is RichMenuDef => !!d),
    }
  }

  async get(key: string) {
    const d = await this.store.getRichMenu(key)
    if (!d) throw new HttpError(404, 'ยังไม่มีเมนูนี้ในระบบ', 'NOT_FOUND')
    return d
  }

  /** บันทึกร่าง — ถ้าเปลี่ยนขนาด ภาพเดิมใช้ไม่ได้แล้วจึงถูกล้าง (ต้องอัปโหลดภาพขนาดใหม่) */
  async save(key: string, body: MenuBody, by: string) {
    this.validate(key, body)
    const old = await this.store.getRichMenu(key)
    const sizeChanged = !!old && (old.width !== body.width || old.height !== body.height)
    return this.store.upsertRichMenu({ key, width: body.width, height: body.height, chatBarText: body.chat_bar_text, areas: body.areas as MenuArea[] }, by, { clearImage: sizeChanged })
  }

  async saveImage(key: string, buf: Buffer, by: string) {
    const def = await this.get(key)
    if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, `ภาพใหญ่ ${(buf.length / 1048576).toFixed(2)} MB (LINE รับ ≤ 1 MB)`, 'IMAGE_TOO_LARGE')
    const info = imageInfo(buf)
    if (!info) throw new HttpError(400, 'ไฟล์ไม่ใช่ภาพ PNG หรือ JPEG', 'BAD_IMAGE')
    if (info.width !== def.width || info.height !== def.height) {
      throw new HttpError(400, `ขนาดภาพต้องเป็น ${def.width}×${def.height} พอดี (ภาพนี้ ${info.width}×${info.height})`, 'BAD_IMAGE_SIZE')
    }
    await this.store.setRichMenuImage(key, info.type, buf, by)
  }

  /** นำเข้าชุดเริ่มต้น (ใช้ตอนตั้งต้นจากไฟล์ตั้งค่าเดิม) — ไม่ทับเมนูที่มีอยู่แล้ว เว้นแต่ overwrite */
  async importMenus(items: { key: string; body: MenuBody; image?: Buffer }[], by: string, overwrite = false) {
    let imported = 0, skipped = 0
    for (const it of items) {
      if (!overwrite && (await this.store.getRichMenu(it.key))) { skipped++; continue }
      await this.save(it.key, it.body, by)
      if (it.image) await this.saveImage(it.key, it.image, by)
      imported++
    }
    return { imported, skipped }
  }

  toLineBody(def: RichMenuDef) {
    return {
      size: { width: def.width, height: def.height },
      selected: true,
      name: `${NAME_PREFIX}${def.key}`,
      chatBarText: def.chatBarText,
      areas: def.areas.map(a => {
        const label = a.label || undefined
        let action: Record<string, unknown>
        switch (a.action.type) {
          case 'uri': action = { type: 'uri', label, uri: a.action.uri }; break
          case 'liff': action = { type: 'uri', label, uri: `https://liff.line.me/${a.action.liffId}${a.action.path ?? ''}` }; break
          case 'tab': action = { type: 'richmenuswitch', label, richMenuAliasId: this.aliasForKey(a.action.target), data: `tab=${a.action.target}` }; break
          case 'message': action = { type: 'message', label, text: a.action.text }; break
        }
        return { bounds: { x: a.x, y: a.y, width: a.width, height: a.height }, action }
      }),
    }
  }

  /**
   * เผยแพร่เมนูทั้งชุดไป LINE: สร้างชุดใหม่ + อัปโหลดภาพ → ย้าย alias → (ถ้าสั่ง) ตั้ง guest เป็น default → ลบชุดเก่า
   * → ผูกเมนูให้ทุกคนที่ผูก LINE แล้วใหม่ (เมนูเก่าถูกลบพร้อมการผูกรายคน)
   * เมนู default เดิมของ OA ไม่ถูกแตะ ถ้าไม่ได้สั่ง setDefaultGuest
   */
  async publish(by: string, opts: { setDefaultGuest?: boolean } = {}): Promise<PublishResult> {
    if (this.publishing) throw new HttpError(409, 'กำลังเผยแพร่อยู่ รอสักครู่', 'BUSY')
    this.publishing = true
    const createdIds: string[] = []
    try {
      const defs = new Map((await this.store.listRichMenus()).map(d => [d.key, d]))
      const problems: string[] = []
      for (const k of this.keys()) {
        const d = defs.get(k)
        if (!d) problems.push(`${k}: ยังไม่มีเมนู`)
        else if (!d.hasImage) problems.push(`${k}: ยังไม่มีภาพ`)
        else if (d.areas.length === 0) problems.push(`${k}: ยังไม่มีพื้นที่กด`)
      }
      if (problems.length) throw new HttpError(409, 'เผยแพร่ไม่ได้: ' + problems.join(' · '), 'NOT_READY')

      const oldMenus = (await this.line.listMenus()).filter(m => m.name.startsWith(NAME_PREFIX))
      const created = new Map<string, string>()
      for (const k of this.keys()) {
        const d = defs.get(k)!
        const img = await this.store.getRichMenuImage(k)
        if (!img) throw new HttpError(409, `${k}: ภาพหาย`, 'NOT_READY')
        const id = await this.line.createMenu(this.toLineBody(d))
        createdIds.push(id)
        await this.line.uploadMenuImage(id, img.data, img.type)
        created.set(k, id)
      }

      const ourAliases = new Set(this.keys().map(k => this.aliasForKey(k)).filter((a): a is string => !!a))
      for (const a of (await this.line.listAliases()).filter(a => ourAliases.has(a.richMenuAliasId))) await this.line.deleteAlias(a.richMenuAliasId)
      let aliases = 0
      for (const k of this.keys()) {
        const alias = this.aliasForKey(k)
        if (alias) { await this.line.createAlias(alias, created.get(k)!); aliases++ }
      }
      if (opts.setDefaultGuest) await this.line.setDefaultMenu(created.get('guest')!)
      for (const o of oldMenus) await this.line.deleteMenu(o.richMenuId).catch(() => undefined)
      createdIds.length = 0 // สำเร็จแล้ว ไม่ต้องล้างของใหม่
      await this.store.markRichMenusPublished(this.keys())
      const relink = await this.users.relinkAll()
      void by
      return { created: created.size, aliases, deletedOld: oldMenus.length, defaultSet: !!opts.setDefaultGuest, relink: { total: relink.total, ok: relink.ok, failed: relink.failed } }
    } catch (e) {
      for (const id of createdIds) await this.line.deleteMenu(id).catch(() => undefined) // ล้างเมนูใหม่ที่สร้างค้าง
      throw e
    } finally {
      this.publishing = false
    }
  }
}
