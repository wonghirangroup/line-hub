# LINE Hub API (เฟส 2)

ตัวตนกลางของพนักงาน + ยืนยันตัวตน + บทบาท + ผูก Rich Menu รายคน · Node + Fastify + Prisma + MariaDB

## flow ทั้งหมด

```
superadmin นำเข้ารายชื่อ (รหัสพนักงาน, ชื่อ, เบอร์, บทบาท) แล้ว "ออกรหัสผ่าน" ให้พนักงานแต่ละคน
   └ รหัสสุ่ม 8 ตัว (เช่น K7M2-9QXP) แสดงครั้งเดียว ใช้ครั้งเดียว หมดอายุใน 72 ชั่วโมง · ในฐานข้อมูลเก็บเฉพาะแฮช
        └ superadmin ส่งรหัสให้พนักงานเป็นการส่วนตัว
พนักงานแอดเพื่อน OA → ได้เมนู guest → เปิดหน้ายืนยัน (LIFF /verify)
   └ กรอก รหัสพนักงาน + เบอร์โทร + รหัสผ่านจาก superadmin → Hub ตรวจ LIFF ID token กับ LINE
        └ ถูกครบ → ผูก LINE + ผูก Rich Menu ตามบทบาท (การออกรหัสคืออนุมัติ)
             staff/driver → ชุด member (แท็บพนักงาน + เว็บไซต์) · admin/superadmin → ชุด admin (ครบ 3 แท็บ)
```

ผู้อนุมัติ/ผู้จัดการระบบคือ **superadmin เท่านั้น** (admin ธรรมดาเข้าหน้าจัดการไม่ได้) ตั้ง `HUB_REQUIRE_APPROVAL=true` ถ้าอยากให้ superadmin กดอนุมัติอีกชั้นหลังพนักงานใส่รหัสถูก

ระบบเดิมเรียก `GET /api/me` ด้วย LIFF ID token เพื่อรู้ว่าใครกด บทบาทอะไร เข้าระบบไหนได้ (ใช้เป็น ALL APP ในเฟส 3)

## หน้าจัดการสำหรับ superadmin

เปิดใน LINE: `https://liff.line.me/<HUB_VERIFY_LIFF_ID>/admin` (LINE ต่อ `/admin` ท้าย endpoint `/verify` → หน้า `/verify/admin`) ล็อกอินด้วย LINE ระบบเช็คจากฐานข้อมูลว่าคุณเป็น superadmin ที่ผูกอยู่ — ทำได้: นำเข้ารายชื่อ, ออกรหัส (รายคน/ทุกคนแล้วดาวน์โหลด CSV), เปลี่ยนบทบาท, ยกเลิกการผูก (ลาออก), อนุมัติคำขอ (ถ้าเปิดโหมดอนุมัติ) ถอดสิทธิ์หรือยกเลิกการผูก superadmin คนสุดท้ายไม่ได้

## ตัวแก้เมนู LINE (ภาพ / พื้นที่กด / ขนาด)

เปิดใน LINE: `https://liff.line.me/<HUB_VERIFY_LIFF_ID>/admin/menu` (หรือกดลิงก์ "แก้ไขเมนู LINE" ในหน้าจัดการ) เฉพาะ superadmin

- เลือกเมนูได้ 6 ชุด (พนักงาน 2 แท็บ · แอดมิน 3 แท็บ · guest) — แต่ละชุดแก้ภาพและพื้นที่กดแยกกัน
- **เปลี่ยนภาพ:** เลือกไฟล์ใดก็ได้ ระบบปรับให้ได้ขนาดตรงเป๊ะ (เติมเต็ม) และบีบเป็น JPEG ≤ 1 MB ให้อัตโนมัติ · ดาวน์โหลดภาพปัจจุบันไปแก้ในโปรแกรมออกแบบได้
- **จัดขนาด:** ลากกล่องเพื่อย้าย ลากมุมสีส้มเพื่อปรับขนาด หรือพิมพ์ตัวเลข X/Y/กว้าง/สูง · "แบ่งช่องเท่าๆ กัน" จัดตารางให้ · เลือกขนาดเมนูตามที่ LINE รับ (2500×1686, 2500×843, 1200×810, 1200×405, 800×540, 800×270 — เปลี่ยนแล้วต้องอัปโหลดภาพใหม่)
- **ปลายทางของแต่ละพื้นที่:** เปิดลิงก์ https · เปิดผ่าน LIFF (+path) · สลับแท็บ (ในชุดเดียวกัน) · ส่งข้อความ
- **บันทึกร่าง** เก็บในฐานข้อมูล (ยังไม่เปลี่ยนใน LINE) → **เผยแพร่ไป LINE** สร้างเมนูทั้งชุดใหม่ ย้าย alias ลบชุดเก่า (เฉพาะที่ชื่อขึ้นต้น `sjhub:`) แล้วผูกเมนูใหม่ให้ทุกคนที่ผูก LINE แล้วอัตโนมัติ · ไม่แตะเมนู default เดิมของ OA ยกเว้นติ๊ก "ตั้ง guest เป็นเมนูเริ่มต้น"
- ตั้งต้นครั้งแรก: `HUB_ADMIN_TOKEN=... node scripts/seed-hub-menus.js` (นำเข้าจาก `richmenu.config.json` + `assets/richmenu`) · ทดสอบหน้าจอด้วย Chrome: `HUB_ADMIN_TOKEN=... node test/ui-smoke.mjs`
- หลังเริ่มใช้ตัวแก้บนเว็บ ถือว่า **ฐานข้อมูลคือต้นฉบับ** — `richmenu:sync` (สคริปต์เดิม) จะเขียนทับด้วยไฟล์ตั้งค่า ใช้เฉพาะตอนตั้งต้น

## เริ่มรันในเครื่อง (ไม่ต้องมี DB)

```bash
cd hub
npm install
cp .env.example .env     # ใส่ค่า LINE_* และ HUB_ADMIN_TOKEN; ตั้ง HUB_STORE=memory
npm run dev              # http://localhost:4100
npm test                 # 53 เทสต์ (+ ทดสอบหน้าจอ 22 ข้อด้วย Chrome: node test/ui-smoke.mjs) (ใช้ LINE จำลอง + MemoryStore)
```

`HUB_STORE=memory` ข้อมูลหายเมื่อรีสตาร์ท ใช้ทดลองเท่านั้น

## ตั้งค่า LINE Developers Console ก่อนใช้จริง

1. **LIFF ใหม่ใน DemoWebsite** (Provider DemoWeb): ชื่อ "ยืนยันตัวตนพนักงาน", Endpoint URL = `https://hub.wonghiran.com/verify`, Scope: `openid` + `profile`, Size: Full → เอา LIFF ID ไปใส่ `HUB_VERIFY_LIFF_ID`
2. **Webhook ของ OA SJ-Webapp/Demo**: ตั้ง Webhook URL = `https://hub.wonghiran.com/webhook` แล้วกด Verify (Hub ตรวจลายเซ็นด้วย `LINE_CHANNEL_SECRET`)
3. ใส่ LIFF ID ของปุ่ม "ยืนยันตัวตนพนักงาน" ใน `../richmenu.config.json` (ปุ่ม `guest-verify`) แล้วรัน `npm run richmenu:sync` (ที่โฟลเดอร์หลัก) — หลังรันทุกครั้งต้องเรียก `POST /api/admin/relink-all` เพราะเมนูเก่าถูกลบพร้อมการผูกรายคน

## API แอดมิน

เข้าได้ 2 ทาง: **(1) superadmin ที่ล็อกอินด้วย LINE** (Bearer = LIFF ID token) — ทางหลัก หน้าจัดการใช้ทางนี้ · **(2) โทเค็นกลาง `HUB_ADMIN_TOKEN`** สำหรับสคริปต์/ฉุกเฉิน เก็บเป็นความลับ (ใส่ `X-Admin-Name` เพื่อบันทึกชื่อผู้ทำ)

| คำสั่ง | ทำอะไร |
| --- | --- |
| `POST /api/admin/users/import` | นำเข้า/อัปเดตรายชื่อ `{ "users": [{ "employee_code", "display_name", "phone", "roles"?: ["staff"] }] }` |
| `POST /api/admin/users/:id/activation-code` | ออก/ออกใหม่รหัสผ่านเปิดใช้งาน `{ "hours"?: 72 }` → คืนรหัสครั้งเดียว |
| `POST /api/admin/activation-codes/issue-all` | ออกรหัสให้ทุกคนที่ยังไม่ผูก LINE |
| `GET /api/admin/users?status=ACTIVE` | ดูรายชื่อ + บทบาท (ไม่มีแฮช/รหัสผ่าน) |
| `GET /api/admin/verification-requests?status=PENDING` · `POST …/:id/approve` · `POST …/:id/reject` | ใช้เมื่อเปิด `HUB_REQUIRE_APPROVAL=true` |
| `PUT /api/admin/users/:id/roles` | เปลี่ยนบทบาท `{ "roles": ["staff","admin"] }` → เมนูเปลี่ยนตาม |
| `POST /api/admin/users/:id/unlink` | ลาออก/ยกเลิก: ถอดเมนู ล้าง LINE userId สถานะ INACTIVE |
| `PUT /api/admin/apps/:code` | เพิ่ม/แก้ระบบในตาราง `apps` (ใช้แสดง ALL APP) |
| `POST /api/admin/relink-all` | ผูกเมนูให้ทุกคนที่ ACTIVE ใหม่ (หลัง `richmenu:sync`) |
| `GET /api/admin/whoami` | ดูว่าตัวเองเข้าในนามใคร |

ตัวอย่างนำเข้ารายชื่อ:

```bash
curl -X POST https://hub.wonghiran.com/api/admin/users/import \
  -H "Authorization: Bearer $HUB_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"users":[{"employee_code":"E001","display_name":"สมหญิง ใจดี","phone":"0812345678"}]}'
```

## ความปลอดภัยที่ทำไว้

- ตรวจ LIFF ID token กับ LINE ทุกครั้ง ไม่เชื่อ `userId` ที่ client ส่งมา (มีเทสต์ปลอม token / ปลอม `line_user_id`)
- ต้องมีครบ 3 อย่าง: รหัสพนักงาน + เบอร์โทร + รหัสผ่านที่ superadmin สุ่มให้ (รู้รหัสพนักงานกับเบอร์อย่างเดียวเข้าไม่ได้)
- รหัสผ่านสุ่ม ใช้ครั้งเดียว มีวันหมดอายุ เก็บเฉพาะแฮช scrypt ไม่หลุดออกทาง API ผิด 5 ครั้งรหัสถูกล็อกต้องออกใหม่
- ข้อมูลไม่ตรง ตอบข้อความเดียวกันทุกกรณี (ไม่บอกว่าผิดช่องไหน)
- ลองผิด 5 ครั้ง/ชั่วโมง ต่อ LINE userId → 429
- หน้าจัดการเฉพาะ superadmin ที่ผูก LINE แล้ว (เช็คจากฐานข้อมูลทุกครั้ง) · superadmin คนสุดท้ายถอดสิทธิ์ไม่ได้
- ผูก LINE 1 บัญชีต่อพนักงาน 1 คน (ชนกัน = 409)
- webhook ตรวจลายเซ็น HMAC จาก raw body · token แอดมินเทียบแบบ constant-time
- การซ่อนปุ่มใน Rich Menu ไม่ใช่การกันสิทธิ์ — หลังบ้านทุกระบบต้องตรวจสิทธิ์เอง

## ดีพลอย (ยังไม่ได้ทำ — ต้องตกลงก่อน)

มี `Dockerfile` พร้อม (migrate + start) ที่ต้องทำบนเซิร์ฟเวอร์ Smart-Jigsaw: สร้างฐานข้อมูล `line_hub` + ผู้ใช้ใน MariaDB, ตั้ง `.env`, เพิ่มบริการใน docker compose (พอร์ตที่ว่าง เช่น 4100), ชี้โดเมน + HTTPS (LIFF และ webhook ต้องเป็น https) ฝั่ง Prisma ที่ต่อ MariaDB จริงยังไม่ได้ทดสอบ (เครื่องนี้ไม่มี DB) ตรวจแล้วเฉพาะ typecheck และ migration ที่สร้างจาก schema

## ขั้นถัดไป (เฟส 3)

หน้าแอดมิน (อนุมัติ/จัดการบทบาทด้วยล็อกอิน LINE แทนโทเค็น) และ ALL APP ที่ดัดแปลงจาก demovault อ่านการ์ดจาก `/api/me`
