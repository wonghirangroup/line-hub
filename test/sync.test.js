// รัน richmenu-sync.js จริงกับเซิร์ฟเวอร์ LINE จำลอง — ตรวจลำดับการเรียกและว่ารันซ้ำแล้วไม่สร้างเมนูซ้ำ
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { ROOT } from '../src/config.js'

const run = promisify(execFile)

function fakeLine() {
  const menus = new Map(), aliases = new Map(), log = []
  let n = 0, defaultId = null
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = req.url, body = Buffer.concat(chunks)
      log.push(`${req.method} ${url}`)
      const send = (obj = {}, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (req.headers.authorization !== 'Bearer test-token') return send({ message: 'unauthorized' }, 401)
      let m
      if (req.method === 'GET' && url === '/v2/bot/richmenu/list') return send({ richmenus: [...menus].map(([richMenuId, b]) => ({ richMenuId, ...b })) })
      if (req.method === 'POST' && url === '/v2/bot/richmenu') { const id = `rm-${++n}`; menus.set(id, JSON.parse(body)); return send({ richMenuId: id }) }
      if (req.method === 'POST' && (m = url.match(/^\/v2\/bot\/richmenu\/(rm-\d+)\/content$/))) { assert.ok(menus.has(m[1])); assert.ok(body.length > 1000); return send() }
      if (req.method === 'DELETE' && (m = url.match(/^\/v2\/bot\/richmenu\/(rm-\d+)$/))) { menus.delete(m[1]); return send() }
      if (req.method === 'GET' && url === '/v2/bot/richmenu/alias/list') return send({ aliases: [...aliases].map(([richMenuAliasId, richMenuId]) => ({ richMenuAliasId, richMenuId })) })
      if (req.method === 'POST' && url === '/v2/bot/richmenu/alias') { const b = JSON.parse(body); if (aliases.has(b.richMenuAliasId)) return send({ message: 'conflict' }, 400); aliases.set(b.richMenuAliasId, b.richMenuId); return send() }
      if (req.method === 'DELETE' && (m = url.match(/^\/v2\/bot\/richmenu\/alias\/(.+)$/))) { aliases.delete(m[1]); return send() }
      if (req.method === 'POST' && (m = url.match(/^\/v2\/bot\/user\/all\/richmenu\/(rm-\d+)$/))) { defaultId = m[1]; return send() }
      send({ message: 'not found' }, 404)
    })
  })
  return { server, menus, aliases, log, get defaultId() { return defaultId } }
}

test('sync สร้าง 6 เมนู + 5 alias + ตั้ง default=guest และรันซ้ำไม่ซ้ำซ้อน', async () => {
  const f = fakeLine()
  await new Promise(r => f.server.listen(0, r))
  const base = `http://127.0.0.1:${f.server.address().port}`
  const env = { ...process.env, LINE_CHANNEL_ACCESS_TOKEN: 'test-token', LINE_API_BASE: base, LINE_API_DATA_BASE: base }
  const script = path.join(ROOT, 'src', 'richmenu-sync.js')
  try {
    await run(process.execPath, [script], { env })
    assert.equal(f.menus.size, 6)
    assert.deepEqual([...f.aliases.keys()].sort(), ['tab-a-admin', 'tab-a-staff', 'tab-a-web', 'tab-m-staff', 'tab-m-web'])
    assert.equal(f.menus.get(f.defaultId).name, 'sjhub:guest')
    const firstIds = [...f.menus.keys()]

    await run(process.execPath, [script, '--default=staff'], { env })   // รันซ้ำ
    assert.equal(f.menus.size, 6, 'รันซ้ำต้องไม่มีเมนูซ้ำ')
    assert.ok(firstIds.every(id => !f.menus.has(id)), 'เมนูเก่าต้องถูกแทนที่')
    assert.equal(f.aliases.size, 5)
    assert.equal(f.menus.get(f.defaultId).name, 'sjhub:admin-staff')
    for (const id of f.aliases.values()) assert.ok(f.menus.has(id), 'alias ต้องชี้เมนูที่ยังอยู่')
  } finally { f.server.close() }
})

test('--no-default สร้างเมนูครบแต่ไม่แตะ default ของ OA', async () => {
  const f = fakeLine()
  await new Promise(r => f.server.listen(0, r))
  const base = `http://127.0.0.1:${f.server.address().port}`
  const env = { ...process.env, LINE_CHANNEL_ACCESS_TOKEN: 'test-token', LINE_API_BASE: base, LINE_API_DATA_BASE: base }
  try {
    await run(process.execPath, [path.join(ROOT, 'src', 'richmenu-sync.js'), '--no-default'], { env })
    assert.equal(f.menus.size, 6)
    assert.equal(f.defaultId, null)
    assert.ok(!f.log.some(l => l.includes('/user/all/richmenu')))
  } finally { f.server.close() }
})

test('token ผิด → สคริปต์ล้มเหลว (exit ≠ 0)', async () => {
  const f = fakeLine()
  await new Promise(r => f.server.listen(0, r))
  const base = `http://127.0.0.1:${f.server.address().port}`
  const env = { ...process.env, LINE_CHANNEL_ACCESS_TOKEN: 'wrong', LINE_API_BASE: base, LINE_API_DATA_BASE: base }
  try {
    await assert.rejects(run(process.execPath, [path.join(ROOT, 'src', 'richmenu-sync.js')], { env }))
  } finally { f.server.close() }
})
