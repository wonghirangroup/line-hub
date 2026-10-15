// ถ่ายภาพหน้าแดชบอร์ด (ใช้ดูหน้าตา) — HUB_ADMIN_TOKEN=... node test/ui-dash.mjs out.png [dark]
import { createRequire } from 'node:module'
const puppeteer = createRequire(new URL('../../package.json', import.meta.url))('puppeteer-core')
const BASE = process.env.HUB_URL ?? 'http://127.0.0.1:4198', TOKEN = process.env.HUB_ADMIN_TOKEN
const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
const p = await b.newPage(); await p.setViewport({ width: 1180, height: 900 })
if (process.argv[3] === 'dark') await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
p.on('pageerror', e => console.log('PAGEERROR', e.message))
await p.setRequestInterception(true)
p.on('request', r => r.url().includes('static.line-scdn.net') ? r.respond({ status: 200, contentType: 'application/javascript', body: `window.liff={init:()=>Promise.resolve(),isLoggedIn:()=>true,login(){},getIDToken:()=>${JSON.stringify(TOKEN)}}` }) : r.continue())
await p.goto(BASE + '/admin', { waitUntil: 'networkidle2' }); await p.waitForSelector('#app:not([hidden]) #log tr', { timeout: 8000 })
console.log('url:', p.url())
console.log('alerts:', await p.$$eval('#alerts .alert', a => a.map(x => x.textContent)))
console.log('users:', await p.$eval('#kUsers', e => e.textContent), 'codes:', await p.$eval('#kCodes', e => e.textContent), 'log rows:', await p.$$eval('#log tr', r => r.length))
await p.screenshot({ path: process.argv[2] ?? 'ui-dash.png', fullPage: true })
await b.close()
