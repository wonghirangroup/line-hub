# ดีพลอย LINE Hub ที่ hub.wonghiran.com

เซิร์ฟเวอร์: Smart-Jigsaw (`178.128.119.174`) · รูปแบบเดียวกับ workpath-api: nginx บนเครื่อง → Docker ที่ผูก `127.0.0.1:4100` · TLS ด้วย certbot · ฐานข้อมูล MariaDB ตัวเดียวกับ Yoonai (`152.42.227.103`)

> สถานะ (2026-10-15): **ดีพลอยแล้ว** — โค้ดที่ `/opt/line-hub`, ฐานข้อมูล `line_hub` (migration ผ่าน), nginx + HTTPS (certbot) พร้อม, คอนเทนเนอร์ `hub-hub-1` ที่ `127.0.0.1:4100` · **ค้าง:** ใส่ค่า LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / HUB_VERIFY_LIFF_ID ใน `/opt/line-hub/hub/.env` (ตอนนี้เป็น REPLACE_ME) แล้วทำข้อ 5

## อัปเดตโค้ดบนเซิร์ฟเวอร์ (ยังไม่มี git remote)

```bash
cd line-hub && tar --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env --exclude=./assets -cf - . | ssh Smart-Jigsaw "tar -xf - -C /opt/line-hub"
ssh Smart-Jigsaw "cd /opt/line-hub/hub && docker compose up -d --build"
```

แก้ `.env` แล้วต้อง `docker compose up -d --force-recreate` ถึงจะอ่านค่าใหม่ · อ่านโทเค็นแอดมิน: `ssh Smart-Jigsaw "grep HUB_ADMIN_TOKEN /opt/line-hub/hub/.env"` · SSH ไปเซิร์ฟเวอร์นี้ครั้งแรกมักหลุด (timeout) ลองซ้ำก็ติด

## 1. DNS (ต้องทำก่อน — certbot ต้องใช้)

ตอนนี้ `hub.wonghiran.com` ชี้ไป `64.29.17.1` (ไม่ใช่เซิร์ฟเวอร์นี้ น่าจะเป็น wildcard ของโฮสต์เว็บ) ต้องสร้าง **A record: `hub` → `178.128.119.174`** (เหมือนที่ตั้งให้ `workpath-api`, `timeline-api`) รอ DNS อัปเดตแล้วเช็คด้วย `nslookup hub.wonghiran.com`

## 2. ฐานข้อมูล

รัน [deploy/create-database.sql](deploy/create-database.sql) บน MariaDB (เปลี่ยนรหัสผ่านก่อน) ได้ `DATABASE_URL` สำหรับข้อ 4

## 3. LINE Developers Console

- Messaging API ของ SJ-Webapp/Demo: เอา **Channel secret** และออก **Channel access token (long-lived)**
- สร้าง LIFF ใน DemoWebsite: Endpoint URL `https://hub.wonghiran.com/verify`, Scope `openid` + `profile`, Size Full → เก็บ LIFF ID

## 4. บนเซิร์ฟเวอร์

```bash
# โค้ด (ทางเลือก: git clone จาก repo ส่วนตัว หรือ rsync จากเครื่อง)
cd /opt && git clone <repo> line-hub        # หรือ rsync -a --exclude node_modules ./ root@178.128.119.174:/opt/line-hub/
cd /opt/line-hub/hub
cp .env.example .env && nano .env            # กรอกค่าจริง (ห้ามส่งในแชท / ห้าม commit)
#   HUB_STORE=prisma  DATABASE_URL=...  LINE_CHANNEL_SECRET=...  LINE_CHANNEL_ACCESS_TOKEN=...
#   HUB_LINE_LOGIN_CHANNEL_ID=2010195603  HUB_VERIFY_LIFF_ID=...  HUB_ADMIN_TOKEN=<สุ่มยาว>
docker compose up -d --build                 # รัน prisma migrate deploy อัตโนมัติตอนเริ่ม
curl -s localhost:4100/health                # {"ok":true}

cp deploy/nginx-hub.wonghiran.com.conf /etc/nginx/sites-enabled/hub.wonghiran.com.conf
nginx -t && systemctl reload nginx
certbot --nginx -d hub.wonghiran.com
curl -s https://hub.wonghiran.com/health
```

สร้างโทเค็นแอดมิน: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 5. ตั้งค่า LINE ให้ชี้เข้า Hub

1. Console → SJ-Webapp/Demo → Messaging API → **Webhook URL** = `https://hub.wonghiran.com/webhook` → Verify → เปิด Use webhook
2. ใส่ LIFF ID ปุ่ม "ยืนยันตัวตนพนักงาน" ใน `richmenu.config.json` (ปุ่ม `guest-verify`) แล้ว `npm run richmenu:images && npm run richmenu:sync`
3. `curl -X POST https://hub.wonghiran.com/api/admin/relink-all -H "Authorization: Bearer $HUB_ADMIN_TOKEN"`
4. นำเข้ารายชื่อพนักงาน (ดูตัวอย่างใน [README.md](README.md))

## ถอยกลับ

`docker compose down` ที่ `/opt/line-hub/hub` และลบไฟล์ nginx ของ hub — ไม่กระทบระบบอื่น (ใช้พอร์ต 4100 และฐานข้อมูล `line_hub` แยก) OA จะกลับไปใช้เมนู guest ที่เป็น default
