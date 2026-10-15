// ถ่ายภาพหน้าต่างเทมเพลต (ใช้ดูหน้าตา) — HUB_ADMIN_TOKEN=... node test/ui-shot.mjs out.png
import { createRequire } from 'node:module'
const puppeteer = createRequire(new URL('../../package.json', import.meta.url))('puppeteer-core')
const BASE = process.env.HUB_URL ?? 'http://127.0.0.1:4198', TOKEN = process.env.HUB_ADMIN_TOKEN
const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
const p = await b.newPage(); await p.setViewport({ width: 700, height: 1000 })
await p.setRequestInterception(true)
p.on('request', r => r.url().includes('static.line-scdn.net') ? r.respond({ status: 200, contentType: 'application/javascript', body: `window.liff={init:()=>Promise.resolve(),isLoggedIn:()=>true,login(){},getIDToken:()=>${JSON.stringify(TOKEN)}}` }) : r.continue())
await p.goto(BASE + '/verify/admin/menu', { waitUntil: 'networkidle2' }); await p.waitForSelector('#stage .area')
await p.click('#tplBtn'); await new Promise(r => setTimeout(r, 300))
await p.$$eval('#tplsL .tpl', e => e[3].click()); await new Promise(r => setTimeout(r, 200))
await p.screenshot({ path: process.argv[2] ?? 'ui-tpl.png' })
await b.close()
