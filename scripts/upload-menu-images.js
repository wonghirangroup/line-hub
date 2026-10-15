// อัปโหลดภาพเมนูจากโฟลเดอร์เข้า Hub (เป็นฉบับร่าง ยังไม่เผยแพร่ไป LINE)
//   HUB_ADMIN_TOKEN=... node scripts/upload-menu-images.js --dir=assets/richmenu-brand [--url=http://127.0.0.1:4100]
import './../src/env.js'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from '../src/config.js'

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')))
const dir = path.resolve(ROOT, args.dir ?? 'assets/richmenu-brand')
const url = args.url ?? 'http://127.0.0.1:4100'
const token = process.env.HUB_ADMIN_TOKEN
if (!token) { console.error('ต้องตั้ง HUB_ADMIN_TOKEN'); process.exit(1) }
const KEYS = ['member-staff', 'member-web', 'admin-staff', 'admin-admin', 'admin-web', 'guest']
let ok = 0
for (const k of KEYS) {
  const f = path.join(dir, `${k}.jpg`)
  if (!existsSync(f)) { console.log('ข้าม (ไม่มีไฟล์)', k); continue }
  const r = await fetch(`${url}/api/admin/richmenus/${k}/image`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: readFileSync(f) })
  const j = await r.json().catch(() => ({}))
  console.log(k, r.status, r.ok ? 'OK' : (j.error?.message ?? ''))
  if (r.ok) ok++
}
console.log(`อัปโหลดแล้ว ${ok}/${KEYS.length}`)
