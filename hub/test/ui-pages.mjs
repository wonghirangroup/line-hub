// ถ่ายภาพทุกหน้า (เดสก์ท็อป + มือถือ) ไว้ดูหน้าตา — HUB_ADMIN_TOKEN=... node test/ui-pages.mjs outdir
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
const puppeteer = createRequire(new URL('../../package.json', import.meta.url))('puppeteer-core')
const BASE = process.env.HUB_URL ?? 'http://127.0.0.1:4198', TOKEN = process.env.HUB_ADMIN_TOKEN, OUT = process.argv[2] ?? 'shots'
mkdirSync(OUT, { recursive: true })
const apps = [['SmartJigsaw','🧩','uri','guest'],['Growstore','🌱','uri','guest'],['เช็คอิน (Yoonai)','📍','liff',null],['Workpath งานของฉัน','✅','uri',null],['WEA-JER (คนขับ)','🚚','liff','driver'],['Yoonai Admin','🕒','uri','admin']].map(([name,icon,type,role],i)=>({code:'a'+i,name,icon,type,url:type==='uri'?'https://example.com/'+i:null,liffId:type==='liff'?'2010057364-BtB7eW1f':null,requiredRole:role}))
const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
async function shot(path, name, vp, wait) {
  const p = await b.newPage(); await p.setViewport(vp)
  p.on('pageerror', e => console.log('PAGEERROR', name, e.message))
  await p.setRequestInterception(true)
  p.on('request', r => {
    const u = r.url()
    if (u.includes('static.line-scdn.net')) return r.respond({ status: 200, contentType: 'application/javascript', body: `window.liff={init:()=>Promise.resolve(),isLoggedIn:()=>true,login(){},getIDToken:()=>${JSON.stringify(TOKEN)}}` })
    if (u.endsWith('/api/me')) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { user: { displayName: 'จิรพงศ์ ศรีอำไพ' }, apps } }) })
    if (u.endsWith('/api/verify/status')) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { status: 'NONE' } }) })
    r.continue()
  })
  await p.goto(BASE + path, { waitUntil: 'networkidle2' }); await p.waitForSelector(wait, { timeout: 8000 }).catch(() => console.log('wait-timeout', name))
  await new Promise(r => setTimeout(r, 600))
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
  await p.close()
}
const D = { width: 1280, height: 860 }, M = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true }
await shot('/verify/admin/dashboard', 'dash-desktop', D, '#app:not([hidden]) #log tr')
await shot('/verify/admin', 'admin-desktop', D, '#app:not([hidden]) .user')
await shot('/verify/admin/menu', 'menu-desktop', D, '#stage .area')
await shot('/verify/apps', 'apps-mobile', M, 'a.card')
await shot('/verify', 'verify-mobile', M, '#form:not([hidden])')
await shot('/verify/admin/dashboard', 'dash-mobile', M, '#app:not([hidden]) #log tr')
await b.close()
console.log('done')
