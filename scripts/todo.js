// แสดง (และเขียน TODO.md) รายการปุ่มที่ยังไม่มี URL / LIFF ID ใน richmenu.config.json
//   npm run todo
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, todoList, ROOT } from '../src/config.js'

const list = todoList(loadConfig())
const lines = [
  '# TODO: ข้อมูลที่ยังต้องกรอกใน richmenu.config.json',
  '',
  `ปุ่มที่ยังเป็น \`TODO\` ${list.length} ปุ่ม (กดแล้วบอตจะตอบ "ยังไม่เปิดใช้งาน") — สร้างอัตโนมัติด้วย \`npm run todo\``,
  '',
  '| เมนู | id | ปุ่ม | ระบบ | ต้องกรอก |',
  '| --- | --- | --- | --- | --- |',
  ...list.map(t => `| ${t.menu} | \`${t.id}\` | ${t.label} | ${t.sub ?? ''} | \`${t.field}\` (${t.type === 'liff' ? 'LIFF ID เช่น 1234567890-AbCdEfGh' : 'URL https://…'}) |`),
  '',
]
writeFileSync(path.join(ROOT, 'TODO.md'), lines.join('\n'))
console.log(lines.join('\n'))
