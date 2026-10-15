// สร้างภาพ Rich Menu แบบมีเอกลักษณ์ของแต่ละระบบ (สีประจำระบบ + โลโก้ + มาสคอต/ไอคอน) ให้ตรงกับพื้นที่กดที่ตั้งไว้ใน Hub
//   1) ดึงรายการเมนูจาก Hub เป็นไฟล์ JSON (GET /api/admin/richmenus) แล้วบันทึกเป็น menus.json
//   2) node scripts/gen-brand-menus.js --in=menus.json --out=assets/richmenu-brand
//   3) อัปโหลดภาพเข้า Hub ด้วย scripts/upload-menu-images.js (หรือจากหน้า "แก้ไขเมนู LINE")
// ใช้ Chrome ในเครื่องผ่าน puppeteer-core · โลโก้อยู่ที่ assets/brand/ · มาสคอตอยู่ที่ hub/public/assets/
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { ROOT } from '../src/config.js'

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')))
const inFile = args.in ?? 'menus.json'
const outDir = path.resolve(ROOT, args.out ?? 'assets/richmenu-brand')
const BRAND_DIR = path.join(ROOT, 'assets', 'brand')
const MASCOT_DIR = path.join(ROOT, 'hub', 'public', 'assets')

const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(p => existsSync(p))
if (!CHROME) { console.error('ไม่พบ Chrome — ตั้ง CHROME_PATH'); process.exit(1) }

// ── แบรนด์ของแต่ละระบบ ──
const BRANDS = {
  yoonai:      { name: 'YooNai', c1: '#4FA3FF', c2: '#1D5FD0', logo: 'yoonai.png', icon: '🦉' },
  workpath:    { name: 'Workpath', c1: '#FF9A5C', c2: '#EE5A1E', logo: 'workpath.png', icon: '✅' },
  weajer:      { name: 'Weajer', c1: '#34D3A6', c2: '#0C8A68', logo: null, icon: '🚚' },
  wonghiran:   { name: 'วงษ์หิรัญ', c1: '#FF8352', c2: '#DE3F2A', logo: 'wonghiran.png', icon: '🛒' },
  growstore:   { name: 'Growstore', c1: '#55C8F6', c2: '#1C84C6', logo: 'growstore.png', icon: '🌱' },
  smartjigsaw: { name: 'SmartJigsaw', c1: '#34507F', c2: '#13213A', logo: 'smartjigsaw.png', icon: '🧩' },
  hub:         { name: 'ALL APP', c1: '#7A86FF', c2: '#3140C9', logo: 'yoonai.png', icon: '🧩' },
  other:       { name: '', c1: '#7B8AA8', c2: '#4A5877', logo: null, icon: '⏳' },
}
// มาสคอต YooNai ท่าต่างกันตามปุ่ม
const MASCOT_BY_LABEL = { 'เช็คอิน': 'owl.webp', 'วันลา': 'owl-beach.webp', 'Yoonai Admin': 'owl-calendar.webp', 'Yoonai': 'owl-wave.webp', 'ALL APP': 'owl-wave.webp' }

function brandOf(a) {
  const ac = a.action
  const t = ac.type === 'liff' ? 'liff:' + ac.liffId : ac.type === 'uri' ? ac.uri : ''
  if (ac.type === 'message') return 'other'
  if (/liff:2010195603/.test(t) && /\/apps$/.test(ac.path ?? '')) return 'hub'
  if (/liff:2010195603/.test(t)) return 'yoonai' // หน้ายืนยันตัวตนพนักงาน (Hub ของ YooNai)
  if (/liff:2010057364|timeline-(admin|employee|superadmin)|yoonai/.test(t)) return 'yoonai'
  if (/workpath/.test(t)) return 'workpath'
  if (/liff:2009853780|wae-jer|weajer/.test(t)) return 'weajer'
  if (/liff:2009395213|wonghiran\.com/.test(t)) return 'wonghiran'
  if (/growstore|pos\.smartjigsaw/.test(t)) return 'growstore'
  if (/smartjigsaw/.test(t)) return 'smartjigsaw'
  return 'other'
}

// คำอธิบายใต้ชื่อปุ่ม (ตามชื่อปุ่ม)
const SUB = {
  'เช็คอิน': 'เช็คชื่อเข้า-ออกงาน', 'วันลา': 'ขอลา · ปฏิทิน', 'งานของฉัน': 'ติดตามงานของฉัน', 'WEA-JER': 'รอบส่งของ · สำรวจร้าน', 'LINE-ECOM': 'สั่งสินค้าวงษ์หิรัญ',
  'ALL APP': 'รวมทุกระบบของคุณ', 'Yoonai Admin': 'เวลาเข้างาน · พนักงาน', 'Workpath Admin': 'มอบหมาย · ติดตามงาน', 'สต็อกและออเดอร์': 'คลังสินค้า · ออเดอร์',
  'สื่อเว็บไซต์': 'จัดการสื่อบนเว็บ', 'Weajer Admin': 'คนขับ · ผลสำรวจร้าน', 'Growstore POS': 'ระบบขายหน้าร้าน',
  'Yoonai': 'เว็บไซต์ YooNai', 'Workpath': 'เว็บไซต์ติดตามงาน', 'SmartJigsaw': 'เว็บไซต์บริษัท', 'Growstore': 'เว็บไซต์ขาย', 'วงษ์หิรัญ': 'ร้านค้าโกดัง',
  'ร้านค้า': 'วงษ์หิรัญ ร้านค้า', 'เว็บไซต์': 'SmartJigsaw', 'ยืนยันตัวตนพนักงาน': 'สำหรับพนักงานเท่านั้น',
}
const LINES = { 'ยืนยันตัวตนพนักงาน': ['ยืนยันตัวตน', 'พนักงาน'] }
const TAB_ICON = { staff: '👤', admin: '🛡️', web: '🌐' }
const ADMIN_LABELS = new Set(['Yoonai Admin', 'Workpath Admin', 'สต็อกและออเดอร์', 'สื่อเว็บไซต์', 'Weajer Admin', 'Growstore POS'])

const dataUri = (dir, file) => {
  const p = path.join(dir, file)
  if (!existsSync(p)) return null
  const ext = file.split('.').pop().toLowerCase()
  const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function tabBar(menu, tabs, barH) {
  // แถบแท็บ: พื้นหลังฟ้าเข้มทั้งแถบ แท็บที่เปิดอยู่เป็นแคปซูลสีขาว
  const bg = `<div class="bar" style="top:0;left:0;width:${menu.width}px;height:${barH}px"></div>`
  const pills = tabs.map(a => {
    const tabId = String(a.action.target ?? '').split('-').slice(1).join('-')
    const on = a.action.target === menu.key
    const u = barH / 243
    return `<div class="tab${on ? ' on' : ''}" style="left:${a.x + 12}px;top:${on ? a.y + 22 : a.y}px;width:${a.width - 24}px;height:${on ? a.height - 22 : a.height}px">
      <span style="font-size:${Math.round(78 * u)}px">${TAB_ICON[tabId] ?? ''}</span><b style="font-size:${Math.round(74 * u)}px">${esc(a.label)}</b></div>`
  }).join('')
  return bg + pills
}

function card(a, menu) {
  const key = brandOf(a), b = BRANDS[key]
  const label = a.label || (key === 'other' ? 'เร็วๆ นี้' : b.name)
  const sub = SUB[label] ?? (key === 'other' ? 'ยังไม่เปิดใช้งาน' : b.name)
  const admin = ADMIN_LABELS.has(label)
  const u = Math.min(a.width, a.height) / 721 // หน่วยสเกลตามขนาดช่อง
  const logo = b.logo ? dataUri(BRAND_DIR, b.logo) : null
  // มาสคอต: YooNai/ALL APP ใช้นกฮูกตามปุ่ม · Workpath = แมวส้ม · Weajer = นกฮูกคนขับ (หลังบ้าน = นกฮูกนักสืบ/สำรวจ)
  let mascot = null, mascotH = 0.66, sticker = false
  if (key === 'yoonai' || key === 'hub') mascot = dataUri(MASCOT_DIR, MASCOT_BY_LABEL[label] ?? 'owl-wave.webp')
  else if (key === 'workpath') { mascot = dataUri(BRAND_DIR, 'workpath-cat.png'); mascotH = 0.7; sticker = true }
  else if (key === 'weajer') mascot = dataUri(BRAND_DIR, label === 'Weajer Admin' ? 'weajer-survey.png' : 'weajer-driver.png')
  const len = [...label].length
  const lines = LINES[label] ?? null
  const wrap = !lines && (len >= 12 || /\s/.test(label))
  const longLabel = len > 9
  const small = a.width < 700 || a.height < 520
  const labelPx = Math.round((lines ? 78 : wrap ? 80 : longLabel ? 74 : 94) * u * (small ? 0.9 : 1))
  const subPx = Math.round(46 * u * (small ? 0.9 : 1))
  const textMax = mascot ? '46%' : key !== 'other' ? '50%' : '92%'
  const logoBox = logo
    ? `<div class="logo" style="width:${Math.round(150 * u)}px;height:${Math.round(150 * u)}px;border-radius:${Math.round(38 * u)}px"><img src="${logo}"></div>`
    : `<div class="logo emoji" style="width:${Math.round(150 * u)}px;height:${Math.round(150 * u)}px;border-radius:${Math.round(38 * u)}px;font-size:${Math.round(96 * u)}px">${b.icon}</div>`
  const art = mascot
    ? `<img class="mascot${sticker ? ' sticker' : ''}" src="${mascot}" style="height:${Math.round(a.height * mascotH)}px">`
    : key === 'other' ? '' : `<div class="bigicon" style="width:${Math.round(270 * u)}px;height:${Math.round(270 * u)}px;font-size:${Math.round(170 * u)}px">${b.icon}</div>`
  const pill = key === 'other' ? '' : `<div class="pill" style="font-size:${Math.round(42 * u)}px;padding:${Math.round(8 * u)}px ${Math.round(24 * u)}px">${esc(b.name)}</div>`
  const back = admin ? `<div class="back" style="font-size:${Math.round(40 * u)}px;padding:${Math.round(8 * u)}px ${Math.round(22 * u)}px">🔒 หลังบ้าน</div>` : ''
  return `<div class="cell" style="left:${a.x}px;top:${a.y}px;width:${a.width}px;height:${a.height}px;padding:${Math.round(18 * u)}px">
    <div class="c" style="background:linear-gradient(155deg,${b.c1},${b.c2});border-radius:${Math.round(70 * u)}px">
      <i class="e1"></i><i class="e2"></i>
      <div class="top">${logoBox}<div class="tags">${pill}${back}</div></div>
      ${art}
      <div class="txt" style="max-width:${textMax};left:${Math.round(40 * u)}px;bottom:${Math.round(34 * u)}px">
        <div class="lb${wrap ? ' wrap' : ''}" style="font-size:${labelPx}px">${lines ? lines.map(esc).join('<br>') : esc(label)}</div><div class="sb" style="font-size:${subPx}px">${esc(sub)}</div>
      </div>
    </div></div>`
}

function page(menu) {
  const tabs = menu.areas.filter(a => a.action.type === 'tab')
  const barH = tabs.length ? Math.max(...tabs.map(t => t.y + t.height)) : 0
  const cards = menu.areas.filter(a => a.action.type !== 'tab').map(a => card(a, menu)).join('')
  return `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@500;700;800&display=swap"><style>
    *{box-sizing:border-box;margin:0}
    body{width:${menu.width}px;height:${menu.height}px;position:relative;overflow:hidden;font-family:'Noto Sans Thai','Leelawadee UI',Tahoma,sans-serif;background:linear-gradient(160deg,#EAF2FF,#F7FAFF 60%,#E3EEFF)}
    .bar{position:absolute;background:linear-gradient(180deg,#2F86F2,#1648B8)}
    .tab{position:absolute;display:flex;align-items:center;justify-content:center;gap:22px;color:rgba(255,255,255,.88)}
    .tab.on{background:#fff;color:#1D5FD0;border-radius:44px 44px 0 0;box-shadow:0 -6px 18px rgba(11,42,138,.18)}
    .tab.on b,.tab.on span{color:#1D5FD0}
    .tab b{font-weight:800;white-space:nowrap}
    .cell{position:absolute}
    .c{position:relative;width:100%;height:100%;overflow:hidden;color:#fff;box-shadow:0 18px 36px rgba(20,40,100,.22), inset 0 3px 0 rgba(255,255,255,.35)}
    .c .e1{position:absolute;left:-12%;bottom:-18%;width:70%;height:55%;border-radius:50%;background:rgba(255,255,255,.14)}
    .c .e2{position:absolute;right:-14%;top:-22%;width:60%;height:50%;border-radius:50%;background:rgba(255,255,255,.12)}
    .top{position:absolute;left:4%;top:5%;right:4%;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
    .logo{background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 18px rgba(0,0,0,.18);overflow:hidden;padding:10px}
    .logo img{width:100%;height:100%;object-fit:contain;display:block}
    .logo.emoji{padding:0;background:rgba(255,255,255,.95)}
    .tags{display:flex;flex-direction:column;align-items:flex-end;gap:10px}
    .pill{font-weight:800;background:rgba(255,255,255,.24);border:2px solid rgba(255,255,255,.5);border-radius:99px;white-space:nowrap;text-shadow:0 2px 6px rgba(0,0,0,.2)}
    .back{font-weight:800;background:rgba(11,27,77,.55);border-radius:99px;white-space:nowrap}
    .mascot{position:absolute;right:-2%;bottom:-3%;object-fit:contain;filter:drop-shadow(0 14px 20px rgba(0,30,90,.35))}
    .mascot.sticker{filter:drop-shadow(5px 0 0 #fff) drop-shadow(-5px 0 0 #fff) drop-shadow(0 5px 0 #fff) drop-shadow(0 -5px 0 #fff) drop-shadow(0 14px 20px rgba(60,20,0,.35))}
    .bigicon{position:absolute;right:7%;bottom:12%;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(255,255,255,.2);border:3px solid rgba(255,255,255,.35);font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif}
    .txt{position:absolute}
    .lb{font-weight:800;line-height:1.12;text-shadow:0 4px 12px rgba(0,0,0,.28);white-space:nowrap}
    .lb.wrap{white-space:normal;word-break:keep-all;overflow-wrap:normal}
    .sb{font-weight:600;line-height:1.25;margin-top:6px;opacity:.95;text-shadow:0 2px 8px rgba(0,0,0,.25)}
    .emoji{font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif}
  </style>${tabs.length ? tabBar(menu, tabs, barH) : ''}${cards}`
}

const data = JSON.parse(readFileSync(path.resolve(ROOT, inFile), 'utf8'))
const menus = (data.data?.menus ?? data.menus ?? data)
mkdirSync(outDir, { recursive: true })
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
try {
  for (const m of menus) {
    const pg = await browser.newPage()
    await pg.setViewport({ width: m.width, height: m.height, deviceScaleFactor: 1 })
    await pg.setContent(page(m), { waitUntil: 'networkidle0' })
    await pg.evaluate(() => document.fonts.ready)
    // ย่อชื่อปุ่มให้พอดีความกว้างที่กำหนด (ไม่ล้นไปทับมาสคอต/ไอคอน)
    await pg.evaluate(() => {
      for (const t of document.querySelectorAll('.txt')) {
        const lb = t.querySelector('.lb'), sb = t.querySelector('.sb')
        const max = t.parentElement.clientWidth * parseFloat(t.style.maxWidth) / 100
        let size = parseFloat(getComputedStyle(lb).fontSize)
        if (lb.classList.contains('wrap')) lb.style.maxWidth = max + 'px'
        // ย่อจนคำที่ยาวที่สุดพอดีความกว้าง (ตัดบรรทัดได้เฉพาะที่ช่องว่าง ไม่หักกลางคำ)
        while (lb.scrollWidth > max + 1 && size > 36) { size -= 3; lb.style.fontSize = size + 'px' }
        let ss = parseFloat(getComputedStyle(sb).fontSize)
        sb.style.whiteSpace = 'nowrap'
        while (sb.scrollWidth > max && ss > 26) { ss -= 2; sb.style.fontSize = ss + 'px' }
      }
    })
    let q = 90, buf
    do { buf = await pg.screenshot({ type: 'jpeg', quality: q }); q -= 6 } while (buf.length > 1000 * 1000 && q > 40)
    writeFileSync(path.join(outDir, `${m.key}.jpg`), buf)
    console.log(`${m.key}.jpg  ${m.width}×${m.height}  ${(buf.length / 1024).toFixed(0)} KB`)
    await pg.close()
  }
} finally { await browser.close() }
