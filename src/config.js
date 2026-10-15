// โหลด + ตรวจ richmenu.config.json แล้วแปลงเป็น payload ของ LINE Messaging API
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CONFIG_PATH = path.join(ROOT, 'richmenu.config.json')
export const IMAGE_DIR = path.join(ROOT, 'assets', 'richmenu')
export const NAME_PREFIX = 'sjhub:'          // ใช้แยกเมนูที่ Hub จัดการ ออกจากเมนูอื่นใน OA (รันซ้ำแล้วลบเฉพาะของเรา)
export const PLACEHOLDER = 'TODO'

export function loadConfig(file = CONFIG_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export const isPlaceholder = v => !v || String(v).trim().toUpperCase() === PLACEHOLDER

// ปุ่ม → action ของ LINE · ยังไม่มี URL/LIFF ID = ส่งข้อความบอกในแชทแทน (ไม่เปิดลิงก์เสีย)
export function buttonAction(btn) {
  const target = btn.type === 'liff' ? btn.liffId : btn.url
  if (isPlaceholder(target)) {
    return { type: 'message', label: btn.label.slice(0, 20), text: `ยังไม่เปิดใช้งาน: ${btn.label}`.slice(0, 300) }
  }
  // liff: รองรับ path ต่อท้าย (เช่น "/leave") เพื่อเปิดหน้าลึกในแอปที่ผูกกับ LIFF นั้น
  const uri = btn.type === 'liff' ? `https://liff.line.me/${target}${btn.path ?? ''}` : target
  return { type: 'uri', label: btn.label.slice(0, 20), uri }
}

export function todoList(config) {
  const out = []
  const scan = (menuKey, buttons) => {
    for (const b of buttons) {
      const field = b.type === 'liff' ? 'liffId' : 'url'
      if (isPlaceholder(b[field])) out.push({ menu: menuKey, id: b.id, label: b.label, sub: b.sub, type: b.type, field })
    }
  }
  for (const [k, m] of Object.entries(config.menus)) scan(k, m.buttons)
  scan('guest', config.guest.buttons)
  return out
}

function grid(width, top, height, cols, rows) {
  const cells = []
  const cw = Math.floor(width / cols), ch = Math.floor(height / rows)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        x: c * cw, y: top + r * ch,
        width: c === cols - 1 ? width - c * cw : cw,
        height: r === rows - 1 ? height - r * ch : ch,
      })
    }
  }
  return cells
}

export const aliasOf = (config, setId, tabId) => `${config.sets[setId].alias}-${tabId}`
export const menuKey = (setId, tabId) => `${setId}-${tabId}`

// alias ของเมนูแรกที่ผู้ใช้เห็นในแต่ละชุด (ให้ Hub ใช้ผูกเมนูรายคนตามบทบาท)
export function entryAlias(config, setId) {
  const set = config.sets[setId]
  return aliasOf(config, setId, set.tabs[0])
}

// บทบาท → ชุดเมนู (admin ชนะ member) · ไม่ตรงชุดไหน = null = ใช้เมนู guest (default ของ OA)
export function setForRoles(config, roles) {
  for (const id of ['admin', 'member']) {
    if (config.sets[id] && config.sets[id].roles.some(r => roles.includes(r))) return id
  }
  return null
}

// คืนรายการเมนูที่ต้องสร้าง: ชุด member (2 แท็บ) + ชุด admin (3 แท็บ) + guest
// แยกชุดเพราะ Rich Menu ซ่อนแท็บรายคนไม่ได้ — พนักงานทั่วไปต้องไม่เห็นแท็บแอดมินเลย
export function buildMenus(config) {
  const { width, height } = config.size
  const bar = config.tabBarHeight
  const menus = []

  for (const [setId, set] of Object.entries(config.sets)) {
    const tabs = set.tabs.map(id => {
      const t = config.tabs.find(x => x.id === id)
      if (!t) throw new Error(`sets.${setId} อ้าง tab "${id}" ที่ไม่มีใน tabs`)
      return t
    })
    const tabCells = grid(width, 0, bar, tabs.length, 1)
    const btnCells = grid(width, bar, height - bar, 3, 2)
    for (const tab of tabs) {
      const m = config.menus[tab.id]
      if (!m) throw new Error(`ไม่มี menus.${tab.id}`)
      const areas = [
        ...tabs.map((t, i) => ({
          bounds: tabCells[i],
          action: { type: 'richmenuswitch', richMenuAliasId: aliasOf(config, setId, t.id), data: `tab=${t.id}` },
        })),
        ...m.buttons.map((b, i) => ({ bounds: btnCells[i], action: buttonAction(b) })),
      ]
      const key = menuKey(setId, tab.id)
      menus.push({
        key, set: setId, tabId: tab.id, tabs: tabs.map(t => t.id), alias: aliasOf(config, setId, tab.id), image: `${key}.jpg`, kind: 'tabbed',
        body: { size: { width, height }, selected: true, name: `${NAME_PREFIX}${key}`, chatBarText: config.chatBarText, areas },
      })
    }
  }

  const g = config.guest
  const gCells = grid(g.size.width, 0, g.size.height, g.buttons.length, 1)
  menus.push({
    key: 'guest', set: null, tabId: null, tabs: [], alias: null, image: 'guest.jpg', kind: 'guest',
    body: {
      size: g.size, selected: true, name: `${NAME_PREFIX}guest`, chatBarText: config.chatBarText,
      areas: g.buttons.map((b, i) => ({ bounds: gCells[i], action: buttonAction(b) })),
    },
  })
  return menus
}

// ตรวจกฎของ LINE ก่อนยิง API จริง — คืนรายการข้อผิดพลาด (ว่าง = ผ่าน)
export function validate(config, menus = buildMenus(config)) {
  const errs = []
  if (config.chatBarText.length > 14) errs.push(`chatBarText ยาว ${config.chatBarText.length} ตัว (ต้อง ≤ 14)`)
  const aliases = new Set()
  for (const m of menus.filter(m => m.alias)) {
    if (!/^[a-z0-9_-]{1,32}$/.test(m.alias)) errs.push(`alias "${m.alias}" ต้องเป็น a-z 0-9 _ - ไม่เกิน 32 ตัว`)
    if (aliases.has(m.alias)) errs.push(`alias ซ้ำ: ${m.alias}`)
    aliases.add(m.alias)
  }
  const ids = new Set()
  for (const m of menus) {
    const { size, areas } = m.body
    if (size.width < 800 || size.width > 2500 || size.height < 250) errs.push(`${m.key}: ขนาด ${size.width}×${size.height} ไม่อยู่ในช่วงที่ LINE รับ`)
    if (areas.length > 20) errs.push(`${m.key}: มี ${areas.length} พื้นที่ (สูงสุด 20)`)
    for (const [i, a] of areas.entries()) {
      const b = a.bounds
      if (b.x < 0 || b.y < 0 || b.x + b.width > size.width || b.y + b.height > size.height) errs.push(`${m.key}: พื้นที่ #${i + 1} เกินขอบรูป`)
      if (a.action.type === 'uri' && !a.action.uri.startsWith('https://')) errs.push(`${m.key}: URL ต้องขึ้นต้นด้วย https:// → ${a.action.uri}`)
      if (a.action.type === 'richmenuswitch' && !aliases.has(a.action.richMenuAliasId)) errs.push(`${m.key}: สลับไป alias ที่ไม่มี ${a.action.richMenuAliasId}`)
    }
  }
  for (const [k, mm] of [...Object.entries(config.menus), ['guest', config.guest]]) {
    const n = mm.buttons.length
    if (k === 'guest' ? n < 1 || n > 6 : n !== 6) errs.push(`${k}: มีปุ่ม ${n} ปุ่ม (${k === 'guest' ? '1-6' : 'ต้อง 6'})`)
    for (const b of mm.buttons) {
      if (ids.has(b.id)) errs.push(`id ปุ่มซ้ำ: ${b.id}`)
      ids.add(b.id)
      if (!['liff', 'uri'].includes(b.type)) errs.push(`${b.id}: type ต้องเป็น liff หรือ uri`)
    }
  }
  return errs
}
