// สร้างรูป Rich Menu ตัวอย่างจาก richmenu.config.json (ใช้ Chrome ที่ติดตั้งในเครื่อง ผ่าน puppeteer-core)
//   npm run richmenu:images
// รูปออกที่ assets/richmenu/{staff,admin,web,guest}.jpg — อยากใช้รูปออกแบบเองก็วางไฟล์ชื่อเดียวกันทับได้เลย
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { loadConfig, buildMenus, IMAGE_DIR } from '../src/config.js'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)
const chrome = CHROME_CANDIDATES.find(p => existsSync(p))
if (!chrome) { console.error('ไม่พบ Chrome — ตั้งตัวแปร CHROME_PATH ชี้ไปที่ chrome.exe'); process.exit(1) }

const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const FONT = "'Noto Sans Thai','Leelawadee UI','Tahoma','Segoe UI',sans-serif"

function card(b, w, h, cols) {
  const compact = cols > 3 || h < 500
  return `<div class="card" style="--c:${b.color}">
    <div class="ico">${esc(b.icon)}</div>
    <div class="lb" style="font-size:${compact ? 96 : 104}px">${esc(b.label)}</div>
    <div class="sb">${esc(b.sub ?? '')}</div></div>`
}

function page(config, menu) {
  const isGuest = menu.key === 'guest'
  const key = menu.tabId
  const m = isGuest ? config.guest : config.menus[key]
  const { width, height } = isGuest ? config.guest.size : config.size
  const bar = config.tabBarHeight
  const tabs = isGuest ? '' : `<div class="tabs">${menu.tabs.map(id => config.tabs.find(t => t.id === id)).map(t =>
    `<div class="tab${t.id === key ? ' on' : ''}"><span>${esc(t.icon)}</span>${esc(t.label)}</div>`).join('')}</div>`
  const cols = isGuest ? m.buttons.length : 3
  return `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    body{width:${width}px;height:${height}px;font-family:${FONT};background:linear-gradient(160deg,#EAF2FF,#F7FAFF 60%,#E6F0FF);overflow:hidden}
    .tabs{height:${bar}px;display:flex;background:#0B1B4D}
    .tab{flex:1;display:flex;align-items:center;justify-content:center;gap:28px;font-size:84px;font-weight:800;color:#9FB4E8}
    .tab span{font-size:80px}
    .tab.on{background:#fff;color:${m.accent};border-radius:36px 36px 0 0;margin-top:30px}
    .grid{height:${height - (isGuest ? 0 : bar)}px;display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${isGuest ? 1 : 2},1fr);gap:32px;padding:${isGuest ? 48 : 36}px}
    .card{background:#fff;border-radius:64px;border:6px solid color-mix(in srgb,var(--c) 22%,#fff);box-shadow:0 18px 40px rgba(36,75,131,.14);
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:0 24px;position:relative;overflow:hidden}
    .card::before{content:"";position:absolute;inset:0 0 auto 0;height:26px;background:var(--c)}
    .ico{font-size:${isGuest ? 190 : 170}px;line-height:1.1;font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif}
    .lb{font-weight:800;color:#0B1B4D;line-height:1.15}
    .sb{font-size:58px;font-weight:500;color:var(--c)}
  </style>${tabs}<div class="grid">${m.buttons.map(b => card(b, width, height, cols)).join('')}</div>`
}

mkdirSync(IMAGE_DIR, { recursive: true })
const config = loadConfig()
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] })
try {
  for (const menu of buildMenus(config)) {
    const key = menu.key
    const { width, height } = menu.body.size
    const p = await browser.newPage()
    await p.setViewport({ width, height, deviceScaleFactor: 1 })
    await p.setContent(page(config, menu), { waitUntil: 'load' })
    await p.evaluate(() => document.fonts.ready)
    let quality = 88, buf
    do { buf = await p.screenshot({ type: 'jpeg', quality }); quality -= 8 } while (buf.length > 1000 * 1000 && quality > 40)   // LINE รับ ≤ 1 MB
    writeFileSync(path.join(IMAGE_DIR, `${key}.jpg`), buf)
    console.log(`${key}.jpg  ${width}×${height}  ${(buf.length / 1024).toFixed(0)} KB`)
    await p.close()
  }
} finally { await browser.close() }
