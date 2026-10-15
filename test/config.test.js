import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, buildMenus, validate, todoList, buttonAction, setForRoles, entryAlias } from '../src/config.js'

const config = loadConfig()
const menus = buildMenus(config)

test('มี 6 เมนู: ชุด member 2 แท็บ + ชุด admin 3 แท็บ + guest', () => {
  assert.deepEqual(menus.map(m => m.key), ['member-staff', 'member-web', 'admin-staff', 'admin-admin', 'admin-web', 'guest'])
})

test('config ผ่านการตรวจกฎของ LINE', () => {
  assert.deepEqual(validate(config, menus), [])
})

test('ชุด member ไม่มีแท็บแอดมินเลย และชุด admin มีครบ 3 แท็บ', () => {
  for (const m of menus.filter(m => m.set === 'member')) {
    const sw = m.body.areas.filter(a => a.action.type === 'richmenuswitch').map(a => a.action.richMenuAliasId)
    assert.deepEqual(sw, ['tab-m-staff', 'tab-m-web'])
    assert.equal(m.body.areas.length, 8)
  }
  for (const m of menus.filter(m => m.set === 'admin')) {
    const sw = m.body.areas.filter(a => a.action.type === 'richmenuswitch').map(a => a.action.richMenuAliasId)
    assert.deepEqual(sw, ['tab-a-staff', 'tab-a-admin', 'tab-a-web'])
    assert.equal(m.body.areas.length, 9)
  }
})

test('ปุ่มหลังบ้านปรากฏเฉพาะแท็บแอดมินของชุด admin เท่านั้น', () => {
  const adminLabels = new Set(config.menus.admin.buttons.map(b => b.label))
  for (const m of menus.filter(m => m.key !== 'admin-admin')) {
    for (const a of m.body.areas) assert.ok(!adminLabels.has(a.action.label), `${m.key} มีปุ่มหลังบ้าน ${a.action.label}`)
  }
})

test('บทบาท → ชุดเมนู', () => {
  assert.equal(setForRoles(config, ['staff']), 'member')
  assert.equal(setForRoles(config, ['driver']), 'member')
  assert.equal(setForRoles(config, ['staff', 'admin']), 'admin')
  assert.equal(setForRoles(config, ['superadmin']), 'admin')
  assert.equal(setForRoles(config, ['guest']), null)
  assert.equal(setForRoles(config, []), null)
  assert.equal(entryAlias(config, 'member'), 'tab-m-staff')
})

test('พื้นที่ในเมนูไม่ซ้อนกันและเต็มรูปพอดี', () => {
  for (const m of menus) {
    const { width, height } = m.body.size
    let sum = 0
    for (const a of m.body.areas) sum += a.bounds.width * a.bounds.height
    assert.equal(sum, width * height)
  }
})

test('เมนู guest ต้องไม่มีลิงก์หลังบ้าน', () => {
  const guest = menus.find(m => m.key === 'guest')
  const admin = config.menus.admin.buttons.map(b => b.url).filter(u => u && u !== 'TODO')
  for (const a of guest.body.areas) assert.ok(!admin.includes(a.action.uri))
  assert.equal(config.guest.buttons.some(b => b.id.startsWith('admin-')), false)
})

test('ปุ่มที่ยังเป็น TODO ส่งข้อความแทนการเปิดลิงก์เสีย', () => {
  const a = buttonAction({ label: 'ทดสอบ', type: 'uri', url: 'TODO' })
  assert.equal(a.type, 'message')
  assert.match(a.text, /ยังไม่เปิดใช้งาน/)
})

test('LIFF ID กลายเป็น https://liff.line.me/<id>', () => {
  assert.equal(buttonAction({ label: 'x', type: 'liff', liffId: '123-abc' }).uri, 'https://liff.line.me/123-abc')
})

test('todoList นับตรงกับปุ่ม TODO', () => {
  assert.ok(todoList(config).length > 0)
  assert.ok(todoList(config).every(t => ['liffId', 'url'].includes(t.field)))
})

test('liff ที่มี path ต่อท้ายเปิดหน้าลึกในแอป', () => {
  assert.equal(buttonAction({ label: 'x', type: 'liff', liffId: '123-abc', path: '/leave' }).uri, 'https://liff.line.me/123-abc/leave')
})
