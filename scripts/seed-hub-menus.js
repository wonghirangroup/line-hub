// นำเข้าเมนูชุดเริ่มต้น (จาก richmenu.config.json + assets/richmenu/*.jpg) เข้า Hub เพื่อให้แก้ต่อจากหน้าเว็บ /verify/admin/menu
//   HUB_ADMIN_TOKEN=... node scripts/seed-hub-menus.js [--url=http://127.0.0.1:4100] [--overwrite]
// ไม่ทับเมนูที่มีอยู่แล้วใน Hub เว้นแต่ใส่ --overwrite
import './../src/env.js'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, buildMenus, IMAGE_DIR } from '../src/config.js'

const args = process.argv.slice(2)
const url = (args.find(a => a.startsWith('--url=')) ?? '--url=http://127.0.0.1:4100').split('=')[1]
const overwrite = args.includes('--overwrite')
const token = process.env.HUB_ADMIN_TOKEN
if (!token) { console.error('ต้องตั้ง HUB_ADMIN_TOKEN'); process.exit(1) }

const config = loadConfig()
const menus = buildMenus(config)
const keyOfAlias = new Map(menus.filter(m => m.alias).map(m => [m.alias, m.key]))

function toArea(a) {
  const base = { x: a.bounds.x, y: a.bounds.y, width: a.bounds.width, height: a.bounds.height, label: a.action.label ?? '' }
  const ac = a.action
  if (ac.type === 'uri') {
    const m = /^https:\/\/liff\.line\.me\/(\d{10}-[A-Za-z0-9]{8})(\/.*)?$/.exec(ac.uri)
    return { ...base, action: m ? { type: 'liff', liffId: m[1], ...(m[2] ? { path: m[2] } : {}) } : { type: 'uri', uri: ac.uri } }
  }
  if (ac.type === 'richmenuswitch') {
    const target = keyOfAlias.get(ac.richMenuAliasId)
    const tabLabel = config.tabs.find(t => target?.endsWith('-' + t.id))?.label ?? ''
    return { ...base, label: tabLabel, action: { type: 'tab', target } }
  }
  return { ...base, action: { type: 'message', text: ac.text } }
}

const payload = {
  overwrite,
  menus: menus.map(m => {
    const file = path.join(IMAGE_DIR, m.image)
    if (!existsSync(file)) { console.error('ไม่พบรูป', file); process.exit(1) }
    return {
      key: m.key,
      body: { width: m.body.size.width, height: m.body.size.height, chat_bar_text: config.chatBarText, areas: m.body.areas.map(toArea) },
      image_base64: readFileSync(file).toString('base64'),
    }
  }),
}

const res = await fetch(`${url}/api/admin/richmenus/import`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
const text = await res.text()
if (!res.ok) { console.error('นำเข้าไม่สำเร็จ', res.status, text.slice(0, 400)); process.exit(1) }
console.log('นำเข้า:', JSON.parse(text).data)
