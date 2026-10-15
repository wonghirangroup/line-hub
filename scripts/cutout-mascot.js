// ตัดพื้นหลังขาว/ลายตารางหมากรุกออกจากภาพมาสคอต → PNG พื้นหลังโปร่งใส (ใช้ Chrome canvas, ไม่ต้องมีไลบรารีรูปภาพ)
//   node scripts/cutout-mascot.js
// อ่านจาก assets/brand/src/*.jpg แล้วเขียนไป assets/brand/<ชื่อ>.png
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { ROOT } from '../src/config.js'

const SRC = path.join(ROOT, 'assets', 'brand', 'src'), OUT = path.join(ROOT, 'assets', 'brand')
// min = ค่า RGB ต่ำสุดที่ถือว่า "สว่างพอเป็นพื้นหลัง" · sat = ความต่าง RGB สูงสุดที่ยังนับว่าเป็นสีเทา/ขาว
const JOBS = [
  { src: 'weajer-driver.jpg', out: 'weajer-driver.png', min: 226, sat: 16, max: 760, seal: 2 },
  { src: 'weajer-survey.jpg', out: 'weajer-survey.png', min: 226, sat: 16, max: 760, seal: 2 },
  { src: 'workpath-cat.jpg', out: 'workpath-cat.png', min: 208, sat: 16, max: 700, seal: 6 },
]
// โลโก้: ย่อให้พอดี (พื้นขาวของ JPG คงไว้ เพราะวางบนป้ายสีขาว)
const RESIZE = [
  { src: 'growstore-logo.png', out: 'growstore.png', max: 420, mime: 'image/png' },
  { src: 'wonghiran-logo.png', out: 'wonghiran.png', max: 420, mime: 'image/png' },
  { src: 'smartjigsaw-logo.jpg', out: 'smartjigsaw.png', max: 420, mime: 'image/jpeg' },
]
const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(p => existsSync(p))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')
for (const j of JOBS) {
  const b64 = readFileSync(path.join(SRC, j.src)).toString('base64')
  const png = await page.evaluate(async (b64, j) => {
    const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode()
    const k = Math.min(1, j.max / Math.max(img.width, img.height))
    const W = Math.round(img.width * k), H = Math.round(img.height * k)
    const c = document.getElementById('c'); c.width = W; c.height = H
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H)
    const d = g.getImageData(0, 0, W, H), px = d.data
    const isBg = i => { const r = px[i], gg = px[i + 1], b = px[i + 2]; return Math.min(r, gg, b) >= j.min && Math.max(r, gg, b) - Math.min(r, gg, b) <= j.sat }
    // flood fill จากขอบภาพ: เฉพาะพื้นที่สว่างที่ต่อกับขอบ (ตาขาว/ท้องขาวที่อยู่ในตัวมาสคอตจะไม่ถูกลบ)
    const T = new Uint8Array(W * H)
    for (let p = 0; p < W * H; p++) T[p] = isBg(p * 4) ? 1 : 0
    const r = j.seal || 1
    // ตารางผลรวม (summed-area) เพื่อหด/ขยายแบบกล่องเร็วๆ
    const sat = a => { const S = new Int32Array((W + 1) * (H + 1)); for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += a[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row } } return S }
    const box = (S, x, y) => { const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W - 1, x + r), y1 = Math.min(H - 1, y + r); return S[(y1 + 1) * (W + 1) + x1 + 1] - S[y0 * (W + 1) + x1 + 1] - S[(y1 + 1) * (W + 1) + x0] + S[y0 * (W + 1) + x0] }
    const ST = sat(T), E = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W - 1, x + r), y1 = Math.min(H - 1, y + r)
      E[y * W + x] = box(ST, x, y) === (x1 - x0 + 1) * (y1 - y0 + 1) ? 1 : 0 // เหลือเฉพาะจุดที่รอบๆ เป็นพื้นหลังหมด
    }
    const seed = new Uint8Array(W * H), q = []
    const push = (x, y) => { const p = y * W + x; if (!seed[p] && E[p]) { seed[p] = 1; q.push(p) } }
    for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1) } for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y) }
    while (q.length) { const p = q.pop(), x = p % W, y = (p / W) | 0; if (x > 0) push(x - 1, y); if (x < W - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < H - 1) push(x, y + 1) }
    const SS = sat(seed), bg = new Uint8Array(W * H)
    for (let p = 0; p < W * H; p++) { const x = p % W, y = (p / W) | 0; bg[p] = T[p] && box(SS, x, y) > 0 ? 1 : 0 } // ขยายกลับภายในพื้นที่ที่เป็นสีพื้นหลังเดิม
    // ขอบ: พิกเซลสว่างที่ติดพื้นหลัง (เงา/halo) โปร่งใส · พิกเซลขอบอื่นโปร่งแสงบางส่วนให้ขอบนุ่ม
    const near = (p) => { const x = p % W, y = (p / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && bg[yy * W + xx]) return true } return false }
    const edge = []
    for (let p = 0; p < W * H; p++) if (!bg[p] && near(p)) edge.push(p)
    for (const p of edge) { const i = p * 4; if (Math.min(px[i], px[i + 1], px[i + 2]) >= j.min - 24) bg[p] = 1 }
    let minX = W, minY = H, maxX = 0, maxY = 0
    for (let p = 0; p < W * H; p++) {
      const i = p * 4
      if (bg[p]) { px[i + 3] = 0; continue }
      if (near(p)) px[i + 3] = 170
      const x = p % W, y = (p / W) | 0
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
    }
    g.putImageData(d, 0, 0)
    const pad = 4, cw = maxX - minX + 1 + pad * 2, ch = maxY - minY + 1 + pad * 2
    const o = document.createElement('canvas'); o.width = cw; o.height = ch
    o.getContext('2d').drawImage(c, minX, minY, cw - pad * 2, ch - pad * 2, pad, pad, cw - pad * 2, ch - pad * 2)
    return o.toDataURL('image/png').split(',')[1]
  }, b64, j)
  writeFileSync(path.join(OUT, j.out), Buffer.from(png, 'base64'))
  console.log(j.out, (Buffer.from(png, 'base64').length / 1024).toFixed(0) + ' KB')
}
for (const j of RESIZE) {
  const b64 = readFileSync(path.join(SRC, j.src)).toString('base64')
  const png = await page.evaluate(async (b64, j) => {
    const img = new Image(); img.src = 'data:' + j.mime + ';base64,' + b64; await img.decode()
    const k = Math.min(1, j.max / Math.max(img.width, img.height)), W = Math.round(img.width * k), H = Math.round(img.height * k)
    const c = document.createElement('canvas'); c.width = W; c.height = H
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, W, H)
    return c.toDataURL('image/png').split(',')[1]
  }, b64, j)
  writeFileSync(path.join(OUT, j.out), Buffer.from(png, 'base64'))
  console.log(j.out, (Buffer.from(png, 'base64').length / 1024).toFixed(0) + ' KB')
}
await browser.close()
