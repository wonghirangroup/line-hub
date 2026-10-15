# LINE Hub (SJ-Webapp)

ประตูทางเข้าเดียวของทุกระบบผ่าน LINE Official Account — สเปกเต็มอยู่ใน [SPEC.md](SPEC.md)

**สถานะ:** เฟส 1 (Rich Menu) ใช้งานได้ · เฟส 2 (Hub API: ยืนยันตัวตน/บทบาท/เมนูรายคน) เขียนและเทสต์แล้ว ดู [hub/README.md](hub/README.md) — ยังไม่ได้ดีพลอย

เมนูแยกเป็น 3 ชุด: **member** (แท็บพนักงาน+เว็บไซต์ สำหรับ staff/driver), **admin** (ครบ 3 แท็บ สำหรับ admin/superadmin) และ **guest** (default ของ OA) — แยกชุดเพราะ Rich Menu ซ่อนแท็บรายคนไม่ได้ ตอนทดสอบเฟส 1 ใช้ `--default=staff` เพื่อดูชุด admin ทั้งหมด

## เริ่มใช้งาน

ต้องใช้ Node 20.12 ขึ้นไป

```bash
npm install
cp .env.example .env        # ใส่ LINE_CHANNEL_ACCESS_TOKEN ของ OA SJ-Webapp
npm run richmenu:images     # สร้างรูปตัวอย่าง → assets/richmenu/*.jpg (ข้ามได้ถ้ามีรูปของคุณเอง)
npm run richmenu:dry        # ตรวจ config + ดูว่าแต่ละปุ่มจะทำอะไร (ไม่ยิง API ไม่ต้องมี token)
npm run richmenu:sync       # สร้างจริงใน OA
```

`richmenu:sync` รันซ้ำได้เสมอ: สร้างเมนูชุดใหม่ก่อน → ย้าย alias → ตั้ง default → ลบเมนูเก่าที่ชื่อขึ้นต้นด้วย `sjhub:` (เมนูอื่นใน OA ไม่แตะ)

| คำสั่ง | ทำอะไร |
| --- | --- |
| `npm run richmenu:sync -- --default=staff` | ตั้งแท็บพนักงานเป็น default (ทดสอบ) — ค่าปกติคือ `guest` |
| `npm run richmenu:sync -- --no-default` | สร้างเมนูครบทั้งชุดแต่ **ไม่แตะเมนู default ของ OA** (ใช้เมื่อ OA มีเมนูเดิมที่ตั้งใน OA Manager — เมนูใหม่ใช้ผ่านการผูกรายคนของ Hub) |
| `npm run richmenu:dry` | ตรวจ config เท่านั้น |
| `npm run todo` | แสดง/เขียน `TODO.md` รายการปุ่มที่ยังไม่มี URL หรือ LIFF ID |
| `npm test` | เทสต์ config + ลองรัน sync กับ LINE จำลอง |

## วิธีแก้ปุ่ม

ทุกอย่างอยู่ใน [richmenu.config.json](richmenu.config.json)

```json
{ "id": "staff-checkin", "label": "เช็คอิน", "sub": "Yoonai", "icon": "📍", "color": "#1D6FE0",
  "type": "liff", "liffId": "1234567890-AbCdEfGh" }
```

- `type: "liff"` → ใส่ `liffId` (ระบบสร้าง `https://liff.line.me/<id>` ให้)
- `type: "uri"` → ใส่ `url` (ต้องขึ้นต้น `https://`)
- ค่า `"TODO"` = ยังไม่พร้อม: ปุ่มจะไม่เปิดลิงก์เสีย แต่ตอบในแชทว่า "ยังไม่เปิดใช้งาน: <ชื่อปุ่ม>"
- แต่ละเมนูแท็บมี 6 ปุ่มพอดี (เรียงซ้าย→ขวา บน→ล่าง) · เมนู guest มี 1–6 ปุ่ม เรียงแนวนอน
- แก้เสร็จ: `npm run richmenu:images` (ถ้าเปลี่ยนชื่อ/ไอคอน/สี) แล้ว `npm run richmenu:sync`

อยากใช้รูปที่ดีไซเนอร์ทำเอง: วางไฟล์ชื่อ `member-staff.jpg`, `member-web.jpg`, `admin-staff.jpg`, `admin-admin.jpg`, `admin-web.jpg` (2500×1686) และ `guest.jpg` (2500×843) ใน `assets/richmenu/` (JPEG/PNG ≤ 1 MB) แล้วรัน sync โดยข้ามขั้นสร้างรูป — ตำแหน่งปุ่มอ้างอิงตามตารางนี้: แถบแท็บสูง 243px จากนั้นปุ่ม 3 คอลัมน์ × 2 แถว (ชุด member แถบแท็บมี 2 ช่อง ชุด admin มี 3 ช่อง)

## โครงโปรเจกต์

```
SPEC.md                    สเปกทั้งหมด (4 เฟส)
richmenu.config.json       แหล่งความจริงของปุ่ม/แท็บ/alias
src/config.js              โหลด + ตรวจ config → payload ของ LINE
src/line.js                ไคลเอนต์ LINE Messaging API (Rich Menu)
src/richmenu-sync.js       สคริปต์สร้าง/แทนที่เมนู (idempotent)
hub/                       Hub API (เฟส 2): Fastify + Prisma + MariaDB
scripts/gen-images.js      สร้างรูปตัวอย่างจาก config (ใช้ Chrome ในเครื่อง)
scripts/todo.js            สรุปรายการที่ยังต้องกรอก
test/                      เทสต์ (node:test)
```

## ความปลอดภัย

- token เก็บใน `.env` (อยู่ใน `.gitignore`) ห้ามใส่ในโค้ดหรือ config
- เมนู guest ต้องไม่มีลิงก์หลังบ้าน (มีเทสต์ตรวจ) — แต่การซ่อนปุ่มไม่ใช่การกันสิทธิ์ หลังบ้านทุกตัวต้องตรวจสิทธิ์ฝั่งเซิร์ฟเวอร์เอง
- ในเฟส 1 แท็บ "แอดมิน" ใครสลับไปก็เห็นปุ่มได้ถ้าได้เมนูนี้ — เฟส 2 จะผูกเมนูตามบทบาทรายคน อย่าตั้ง `--default=admin` ใน OA ที่มีผู้ใช้จริง
- เมื่อผูก Rich Menu รายคนแล้ว การรัน sync (ลบเมนูเก่า) จะทำให้การผูกรายคนหลุด ต้องเรียก `POST /api/admin/relink-all` ของ Hub หลังรัน sync ทุกครั้ง

## ยังต้องการจากคุณ

ดู [docs/PLAN.md](docs/PLAN.md) (ผลตรวจระบบเดิม + การตัดสินใจ + แผนเฟส 2–4) และ [TODO.md](TODO.md) สำหรับ URL/LIFF ID ที่ยังขาด และรายการเตรียมก่อนเฟส 2 ใน SPEC.md (Provider เดียวกัน, tech stack ของ Hub API, วิธียืนยันตัวตนพนักงาน, รายละเอียดระบบ "สารบัญ")
