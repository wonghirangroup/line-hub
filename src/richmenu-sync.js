// สร้าง/อัปเดต Rich Menu ทั้งชุดใน OA — รันซ้ำได้ (แทนที่เมนูเดิมที่ชื่อขึ้นต้นด้วย "sjhub:")
//   node src/richmenu-sync.js              สร้างจริง ตั้งเมนู guest เป็น default
//   node src/richmenu-sync.js --dry-run    ตรวจ config + แสดงผลลัพธ์ ไม่ยิง API (ไม่ต้องมี token)
//   node src/richmenu-sync.js --no-default      สร้างเมนูทั้งชุดแต่ไม่แตะเมนู default ของ OA (ปลอดภัยเมื่อ OA มีเมนูเดิมที่ตั้งใน OA Manager)
//   node src/richmenu-sync.js --default=staff   ตั้ง default เป็นแท็บอื่นของชุดแอดมิน (ทดสอบ) — staff|admin|web หรือชื่อเต็ม เช่น member-staff
import './env.js'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, buildMenus, validate, todoList, IMAGE_DIR, NAME_PREFIX } from './config.js'
import { LineClient } from './line.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const noDefault = args.includes('--no-default')
const defaultArg = (args.find(a => a.startsWith('--default=')) ?? '--default=guest').split('=')[1]

const config = loadConfig()
const menus = buildMenus(config)
const errs = validate(config, menus)
if (errs.length) {
  console.error('config ไม่ผ่าน:\n' + errs.map(e => '  - ' + e).join('\n'))
  process.exit(1)
}
// ตัวย่อ staff|admin|web = แท็บนั้นของชุดแอดมิน (เห็นครบทุกแท็บ ไว้ทดสอบ)
const defaultKey = menus.some(m => m.key === defaultArg) ? defaultArg : `admin-${defaultArg}`
if (!menus.some(m => m.key === defaultKey)) {
  console.error(`--default=${defaultArg} ไม่มีในเมนู (เลือก: ${menus.map(m => m.key).join(', ')})`)
  process.exit(1)
}

const todos = todoList(config)
console.log(`เมนู ${menus.length} ชุด · ปุ่มที่ยังเป็น TODO ${todos.length} ปุ่ม${todos.length ? ' (กดแล้วบอตตอบ "ยังไม่เปิดใช้งาน") — ดูรายการ: npm run todo' : ''}`)

if (dryRun) {
  for (const m of menus) {
    console.log(`\n● ${m.body.name}${m.alias ? `  (alias ${m.alias})` : ''}  ${m.body.size.width}×${m.body.size.height}  รูป ${m.image}`)
    for (const a of m.body.areas) {
      const b = a.bounds, ac = a.action
      const to = ac.type === 'uri' ? ac.uri : ac.type === 'richmenuswitch' ? `→ ${ac.richMenuAliasId}` : `"${ac.text}"`
      console.log(`   [${b.x},${b.y} ${b.width}×${b.height}] ${ac.type.padEnd(14)} ${to}`)
    }
  }
  console.log('\n(dry-run: ไม่ได้ยิง API)')
  process.exit(0)
}

// รูปต้องมีครบก่อนเริ่ม ไม่งั้นค้างครึ่งทาง
const images = new Map()
for (const m of menus) {
  const file = path.join(IMAGE_DIR, m.image)
  if (!existsSync(file)) {
    console.error(`ไม่พบรูป ${file} — รัน \`npm run richmenu:images\` เพื่อสร้างรูปตัวอย่าง หรือวางรูปของคุณเอง`)
    process.exit(1)
  }
  const buf = readFileSync(file)
  if (buf.length > 1024 * 1024) { console.error(`${m.image} ใหญ่ ${(buf.length / 1048576).toFixed(2)} MB (LINE รับ ≤ 1 MB)`); process.exit(1) }
  images.set(m.key, buf)
}

const line = new LineClient(process.env.LINE_CHANNEL_ACCESS_TOKEN)

// 1) สร้างเมนูใหม่ + อัปโหลดรูปก่อน (เมนูเก่ายังใช้งานได้ระหว่างนี้)
const oldMenus = (await line.listMenus()).filter(m => m.name.startsWith(NAME_PREFIX))
const created = new Map()
for (const m of menus) {
  const id = await line.createMenu(m.body)
  await line.uploadImage(id, images.get(m.key))
  created.set(m.key, id)
  console.log(`สร้าง ${m.body.name} → ${id}`)
}

// 2) ย้าย alias ไปชี้เมนูใหม่ (alias ซ้ำสร้างไม่ได้ ต้องลบก่อน)
const ourAliases = new Set(menus.filter(m => m.alias).map(m => m.alias))
for (const a of (await line.listAliases()).filter(a => ourAliases.has(a.richMenuAliasId))) await line.deleteAlias(a.richMenuAliasId)
for (const m of menus.filter(m => m.alias)) {
  await line.createAlias(m.alias, created.get(m.key))
  console.log(`alias ${m.alias} → ${m.key}`)
}

// 3) ตั้ง default แล้วค่อยลบเมนูเก่า
if (noDefault) console.log('ข้ามการตั้ง default (--no-default) — เมนู default เดิมของ OA ไม่ถูกแตะ')
else {
  await line.setDefault(created.get(defaultKey))
  console.log(`ตั้ง default = ${defaultKey}`)
}
for (const o of oldMenus) {
  await line.deleteMenu(o.richMenuId).catch(e => console.warn(`ลบ ${o.richMenuId} ไม่สำเร็จ: ${e.message}`))
}
console.log(`ลบเมนูเก่า ${oldMenus.length} ชุด · เสร็จ`)
