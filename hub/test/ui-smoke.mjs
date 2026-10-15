// ทดสอบหน้าแก้เมนูด้วยเบราว์เซอร์จริง (Chrome) กับเซิร์ฟเวอร์ที่รันอยู่ — ไม่อยู่ในชุด npm test (ต้องมี Chrome)
//   HUB_URL=http://127.0.0.1:4198 HUB_ADMIN_TOKEN=... node test/ui-smoke.mjs [out.png]
import { createRequire } from 'node:module'
const puppeteer = createRequire(new URL('../../package.json', import.meta.url))('puppeteer-core')

const BASE = process.env.HUB_URL ?? 'http://127.0.0.1:4198'
const TOKEN = process.env.HUB_ADMIN_TOKEN
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
const OUT = process.argv[2] ?? 'ui-smoke.png'
if (!TOKEN) { console.error('ต้องตั้ง HUB_ADMIN_TOKEN'); process.exit(1) }

const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 820, height: 1400, deviceScaleFactor: 1 })
page.on('pageerror', e => console.log('PAGEERROR', e.message))

// แทน LIFF SDK ด้วยตัวปลอม: คืน ID token = โทเค็นแอดมิน (เซิร์ฟเวอร์รับโทเค็นกลางได้)
await page.setRequestInterception(true)
page.on('request', req => {
  if (req.url().includes('static.line-scdn.net')) {
    return req.respond({ status: 200, contentType: 'application/javascript', body: `window.liff = { init: () => Promise.resolve(), isLoggedIn: () => true, login() {}, getIDToken: () => ${JSON.stringify(TOKEN)} }` })
  }
  req.continue()
})
page.on('dialog', d => d.accept())

await page.goto(BASE + '/verify/admin/menu', { waitUntil: 'networkidle2' })
await page.waitForSelector('#stage .area', { timeout: 8000 })

check('โหลดรายการเมนู 6 แท็บ', (await page.$$eval('#tabs button', b => b.length)) === 6)
const n0 = await page.$$eval('#stage .area', a => a.length)
check('แสดงพื้นที่กดบนภาพ (9 พื้นที่ของ member-staff? = แถบแท็บ 2 + ปุ่ม 6 = 8)', n0 === 8, `พบ ${n0}`)
check('มีภาพเป็นพื้นหลัง', await page.$eval('#stage', s => s.style.backgroundImage.includes('blob:')))

await page.screenshot({ path: OUT.replace('.png', '-initial.png') })
// ลากกล่องแรก (ปุ่มซ้ายบนของตาราง = พื้นที่ลำดับ 3) ไปทางขวา/ล่าง
const idx = 2
const before = await page.evaluate(i => { const a = document.querySelectorAll('#stage .area')[i]; const r = a.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, left: a.style.left } }, idx)
await page.mouse.move(before.x + before.w / 2, before.y + before.h / 2)
await page.mouse.down(); await page.mouse.move(before.x + before.w / 2 + 60, before.y + before.h / 2 + 40, { steps: 6 }); await page.mouse.up()
await sleep(200)
const after = await page.evaluate(i => { const a = document.querySelectorAll('#stage .area')[i]; return { left: a.style.left } }, idx)
check('ลากย้ายพื้นที่ได้ (ตำแหน่งเปลี่ยน)', before.left !== after.left, `${before.left} → ${after.left}`)

// ปรับขนาดด้วยมุมสีส้ม
const handle = await page.evaluate(i => { const h = document.querySelectorAll('#stage .area')[i].querySelector('.h').getBoundingClientRect(); return { x: h.x + h.width / 2, y: h.y + h.height / 2 } }, idx)
const w0 = await page.evaluate(i => document.querySelectorAll('#stage .area')[i].style.width, idx)
await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.mouse.move(handle.x - 40, handle.y - 30, { steps: 6 }); await page.mouse.up()
await sleep(200)
const w1 = await page.evaluate(i => document.querySelectorAll('#stage .area')[i].style.width, idx)
check('ปรับขนาดด้วยมุมได้ (กว้างเปลี่ยน)', w0 !== w1, `${w0} → ${w1}`)

// พิมพ์ตัวเลขให้พอดีเป๊ะ
await page.$eval('#alist .item:nth-child(3) [data-f="width"]', i => { i.value = '900'; i.dispatchEvent(new Event('change')) })
const fixed = await page.$eval('#alist .item:nth-child(3) [data-f="width"]', i => i.value)
check('แก้ตัวเลขความกว้างได้', fixed === '900')

// แก้ชื่อปุ่มและปลายทาง
await page.$eval('#alist .item:nth-child(3) input[placeholder^="ชื่อปุ่ม"]', i => { i.value = 'ทดสอบ'; i.dispatchEvent(new Event('input')) })
check('สถานะขึ้นว่ามีการแก้ไขที่ยังไม่บันทึก', (await page.$eval('#status', s => s.textContent)).includes('ยังไม่บันทึก'))

// เพิ่ม/ลบพื้นที่
await page.click('#addArea'); await sleep(100)
check('เพิ่มพื้นที่กดได้', (await page.$$eval('#stage .area', a => a.length)) === n0 + 1)
await page.click('#alist .item:last-child button.danger'); await sleep(100)
check('ลบพื้นที่กดได้', (await page.$$eval('#stage .area', a => a.length)) === n0)

// บันทึกแล้วโหลดใหม่ค่าต้องอยู่
await page.click('#save'); await sleep(900)
const msg = await page.$eval('#msg', m => m.textContent)
check('บันทึกร่างสำเร็จ', msg.includes('บันทึกร่างแล้ว'), msg)
await page.reload({ waitUntil: 'networkidle2' }); await page.waitForSelector('#stage .area')
const label3 = await page.$eval('#alist .item:nth-child(3) input[placeholder^="ชื่อปุ่ม"]', i => i.value)
const w3 = await page.$eval('#alist .item:nth-child(3) [data-f="width"]', i => i.value)
check('โหลดใหม่แล้วค่าที่บันทึกยังอยู่ (ชื่อ + ความกว้าง)', label3 === 'ทดสอบ' && w3 === '900', `${label3}/${w3}`)

// ใส่ค่าผิด (URL http) → เซิร์ฟเวอร์ต้องปฏิเสธและแสดงข้อความ
await page.$eval('#alist .item:nth-child(3) select', s => { s.value = 'uri'; s.dispatchEvent(new Event('change')) })
await page.$eval('#alist .item:nth-child(3) input[placeholder^="https"]', i => { i.value = 'http://insecure.example'; i.dispatchEvent(new Event('input')) })
await page.click('#save'); await sleep(700)
check('ค่าผิด (http) ถูกปฏิเสธพร้อมข้อความ', (await page.$eval('#msg', m => m.className)).includes('err'))
await page.click('#reload'); await sleep(900)

// อัปโหลดภาพใหม่ (ภาพสี่เหลี่ยมคนละสัดส่วน — ต้องถูกปรับเป็นขนาดเมนูพอดี)
const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 600; c.height = 300; const g = c.getContext('2d'); g.fillStyle = '#7C3AED'; g.fillRect(0, 0, 600, 300); g.fillStyle = '#fff'; g.font = '60px sans-serif'; g.fillText('NEW IMAGE', 120, 170); return c.toDataURL('image/png').split(',')[1] })
import('node:fs').then(fs => fs.writeFileSync('ui-new.png', Buffer.from(png, 'base64')))
await sleep(200)
const input = await page.$('#file')
await input.uploadFile('ui-new.png'); await sleep(1800)
const m2 = await page.$eval('#msg', m => m.textContent)
check('เปลี่ยนภาพสำเร็จ (ปรับขนาดอัตโนมัติ)', m2.includes('เปลี่ยนภาพแล้ว'), m2)
const imgOk = await page.evaluate(async () => { const r = await fetch('/api/admin/richmenus/member-staff/image', { headers: { Authorization: 'Bearer ' + (await window.liff.getIDToken()) } }); const b = await r.blob(); const bm = await createImageBitmap(b); return bm.width + 'x' + bm.height })
check('ภาพที่เก็บมีขนาดตรงเมนู 2500×1686', imgOk === '2500x1686', imgOk)

// เปลี่ยนขนาดเมนู → ภาพถูกล้าง
await page.select('#size', '2500x843'); await sleep(300)
check('เปลี่ยนขนาดแล้วขึ้นเตือนว่าต้องอัปโหลดภาพใหม่', (await page.$eval('#imgHint', h => h.textContent)).includes('ยังไม่มีภาพ'))

// เทมเพลต: เปิดหน้าต่าง → เลือกชุดใหญ่ แบบที่ 4 (ซ้ายใหญ่ + ขวา 2 ช่อง) ขนาด 2500×1686
await page.select('#size', '2500x1686'); await sleep(300)
await page.click('#tplBtn'); await sleep(200)
check('หน้าต่างเทมเพลตมี 7 แบบใหญ่ + 5 แบบเล็ก', (await page.$$eval('#tplsL .tpl', e => e.length)) === 7 && (await page.$$eval('#tplsS .tpl', e => e.length)) === 5)
check('มีตัวเลือกขนาดใหญ่/เล็กอย่างละ 3', (await page.$$eval('#sizesL input', e => e.length)) === 3 && (await page.$$eval('#sizesS input', e => e.length)) === 3)
await page.$$eval('#tplsL .tpl', e => e[3].click()); await sleep(100)
check('เลือกแล้วปุ่ม "เลือก" ใช้ได้ และกรอบเป็นสีเขียว', (await page.$eval('#tplOk', b => !b.disabled)) && (await page.$$eval('#tplsL .tpl.on', e => e.length)) === 1)
await page.click('#tplOk'); await sleep(300)
const nT = await page.$$eval('#stage .area', a => a.length)
check('ใช้เทมเพลต 4: แถบแท็บเดิม 2 + ช่องใหม่ 3 = 5 พื้นที่', nT === 5, 'พบ ' + nT)
const g0 = await page.$eval('#alist .item:nth-child(3) [data-f="width"]', i => i.value)
check('ช่องซ้ายใหญ่กว้าง 2/3 ของภาพ (1667 px)', g0 === '1667', g0)
// เปลี่ยนขนาดเล็กผ่านเทมเพลต: 2500×843 แบบ 3 คอลัมน์
await page.click('#tplBtn'); await sleep(150)
await page.$$eval('#sizesS input', e => { e[0].checked = true; e[0].dispatchEvent(new Event('change')) }); await sleep(80)
await page.$$eval('#tplsS .tpl', e => e[0].click()); await sleep(80)
await page.click('#tplOk'); await sleep(300)
check('เทมเพลตเล็กเปลี่ยนขนาดเป็น 2500×843 และมี 2 แท็บ + 3 ช่อง', (await page.$eval('#size', s => s.value)) === '2500x843' && (await page.$$eval('#stage .area', a => a.length)) === 5)

// แบ่งช่องเท่าๆ กัน
await page.click('#gridBtn'); await sleep(100)
await page.$eval('#gCols', i => i.value = '2'); await page.$eval('#gRows', i => i.value = '2'); await page.$eval('#gTop', i => i.value = '0')
await page.click('#gOk'); await sleep(200)
check('แบ่งช่อง 2×2 ได้ 4 พื้นที่ (ไม่มีแถบแท็บเหลือ เพราะตั้งเว้นบน 0 → ปุ่มสลับแท็บเดิมเป็นส่วนหนึ่งของตาราง)', (await page.$$eval('#stage .area', a => a.length)) === 4)

await page.screenshot({ path: OUT, fullPage: true })
await browser.close()
const failed = results.filter(r => !r).length
console.log(failed ? `\n❌ ล้มเหลว ${failed} ข้อ` : `\n✅ ผ่านทั้ง ${results.length} ข้อ`)
process.exit(failed ? 1 : 0)
