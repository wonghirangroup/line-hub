# แผนงาน LINE Hub — ผลตรวจระบบเดิมและการตัดสินใจ

อัปเดต 2026-10-15 · เสริมจาก [SPEC.md](../SPEC.md) (SPEC.md คือสเปกต้นฉบับ ไฟล์นี้บันทึกสิ่งที่ตรวจเจอและที่ตัดสินใจเพิ่ม)

## 1. Provider ใน LINE Developers Console

userId ของ LINE ออกแยกตาม Provider และย้าย channel ข้าม Provider ไม่ได้ ([Provider design basics](https://developers.line.biz/en/tips/2026/06/25/provider-design-basics/))

| Provider | channel | Channel ID | ใช้กับ |
| --- | --- | --- | --- |
| **DemoWeb (Provider ของ Hub)** | SJ-Webapp/Demo (Messaging API) | 2010195617 | OA ของ Hub |
| | DemoWebsite (LINE Login, Published) | 2010195603 | ALL APP / LIFF ใหม่ของ Hub |
| Weajer | LINE Login | 2009853780 | Weajer (คนขับ) |
| | Messaging API | 2009853873 | Weajer |
| Yoonai | LINE Login | 2010057364 | Yoonai (LIFF `2010057364-BtB7eW1f`) |
| | Messaging API | 2010057421 | Yoonai |
| ยังไม่ทราบ | LIFF `2009395213-…` | 2009395213 | วงษ์หิรัญ ร้านค้า (LINE-ECOM) |
| ยังไม่ทราบ | LINE Login | 2009395221 | วงษ์หิรัญ (แอดมินผูก LINE) |

> `.env` ของ Yoonai ในเครื่อง (`timeline/employee`, `timeline/server`) ชี้ channel `…7174` / LIFF `…6873` ซึ่งไม่ตรงกับ production ควรอัปเดตให้ตรงเพื่อไม่ทดสอบผิด channel

## 2. ระบบเดิมแต่ละตัว (ผลตรวจจากโค้ด)

| ระบบ | โฟลเดอร์ | เก็บ userId ที่ไหน | ตรวจ ID token? | ผลต่อการเชื่อม Hub |
| --- | --- | --- | --- | --- |
| Yoonai | `Downloads\timeline\timeline` | `employees.line_user_id` | ใช่ (`/oauth2/v2.1/verify`) | ย้ายได้ พนักงานยืนยันใหม่ด้วยรหัสพนักงาน · LINE ตั้งค่าต่อ tenant (บริษัทลูกค้ามี OA ของตัวเอง) กระทบเฉพาะ tenant SmartJigsaw |
| Weajer | `Desktop\Cashvan` | `drivers.line_user_id` | **ไม่** (รับ `line_user_id` จาก request body ตรงๆ) | ย้ายง่าย (คนขับไม่กี่คน) แต่ต้องแก้ให้ตรวจ ID token |
| วงษ์หิรัญ | `Desktop\linecommerce-pro` | `orders.customerLineUserId`, `admins.lineUserId` | ไม่ (LIFF ฝั่งลูกค้า) | **ไม่ย้าย** ลูกค้าจะเสียประวัติออเดอร์ ให้เป็นปุ่มลิงก์ใน Hub |
| Workpath | (เว็บแอปเดียวทั้งพนักงานและแอดมิน) | - | - | ยังไม่มี LIFF สร้างใหม่ใน DemoWebsite ได้เลย |
| ALL APP | `Desktop\demovault` | ผู้ใช้ `DvUser` (เลือกชื่อยืนยันตัวตน) | ไม่ | ดัดแปลงเป็น ALL APP (ทางเลือก B) |

## 3. การตัดสินใจ

| เรื่อง | ตัดสินใจ | สถานะ |
| --- | --- | --- |
| Provider ของ Hub | DemoWeb (ที่ OA SJ-Webapp/Demo อยู่) | ยืนยันแล้ว |
| ALL APP | ดัดแปลง `demovault` (ทางเลือก B) ต้องแยกส่วนบัญชีโปรเจกต์ให้เห็นเฉพาะแอดมิน | ยืนยันแล้ว |
| วงษ์หิรัญ | ไม่ย้ายตัวตนลูกค้า เปิดเป็นลิงก์/LIFF เดิม | ยืนยันแล้ว |
| Workpath | เว็บแอปเดียว (พนักงานและแอดมินใช้ที่เดียวกัน) → ปุ่ม "งานของฉัน" และ "Workpath Admin" ชี้ https://workpath.wonghiran.com/ ชั่วคราว | ยืนยันแล้ว |
| ปุ่ม "สารบัญ" | เหมือน Workpath จึงเอาออก ใช้ช่องนั้นเป็น "วันลา" (Yoonai `/leave` ผ่าน LIFF) | ตัดสินใจแทน — แก้กลับได้ |
| วิธียืนยันตัวตนพนักงาน | รหัสพนักงาน + เบอร์โทร แล้วแอดมินกดอนุมัติ (ไม่มีค่า SMS) | ยืนยันแล้ว 2026-10-15 |
| ผู้อนุมัติ/จัดการระบบ | **superadmin เท่านั้น** และพนักงานต้องมีรหัสผ่านสุ่มที่ superadmin ออกให้ (นอกจากรหัสพนักงาน + เบอร์โทร) — ตัดสินใจ 2026-10-15 | ยืนยันแล้ว |
| Tech stack ของ Hub API | Node.js + Fastify + Prisma + MariaDB (เหมือน Yoonai) deploy เครื่องเดียวกับ Yoonai (ssh Smart-Jigsaw) | ยืนยันแล้ว 2026-10-15 |

## 4. ขั้นตอนต่อไป

### เฟส 1 (ตอนนี้): Rich Menu — ทดสอบกับ OA
1. วาง `LINE_CHANNEL_ACCESS_TOKEN` ของ SJ-Webapp/Demo ใน `.env`
2. `npm run richmenu:sync -- --default=staff` แล้วเปิด OA ในมือถือ ลองสลับแท็บและกดปุ่ม
3. ปุ่ม `TODO` ที่เหลือ: ALL APP (2 ปุ่ม), ยืนยันตัวตนพนักงาน — รอเฟส 2–3

### เฟส 2: ตัวตนกลางและบทบาท — เขียนและเทสต์แล้ว (ยังไม่ดีพลอย) ดู [hub/README.md](../hub/README.md)
1. สร้าง LIFF ใน DemoWebsite: "ยืนยันตัวตนพนักงาน" (หน้าของ Hub เอง)
2. Hub API: webhook `follow` → ผูกเมนู guest · endpoint ยืนยันตัวตน (verify ID token กับ LINE ทุกครั้ง) · อนุมัติโดยแอดมิน · ผูก Rich Menu รายคนตามบทบาท · `/me`
3. ตาราง `users`, `roles`, `user_roles`, `apps`, `notification_log` ตาม SPEC.md
4. ใช้ `user_identities` เสริมช่วงเปลี่ยนผ่าน: เก็บคู่ (provider, userId) ของ Yoonai/Weajer เดิม จับคู่ด้วยรหัสพนักงาน เพื่อไม่ต้องให้ทุกคนยืนยันซ้ำทันที

### ย้าย Yoonai และ Weajer (หลังเฟส 2)
1. สร้าง LIFF ใหม่ใน DemoWebsite ชี้ Endpoint URL เดิมของแต่ละระบบ
2. สลับ `LIFF ID` ในระบบ แล้วให้พนักงาน/คนขับยืนยันตัวตนใหม่ 1 ครั้ง (จับคู่ด้วยรหัสพนักงาน)
3. Weajer: เพิ่มการตรวจ ID token ที่ฝั่ง server แทนการรับ `line_user_id` จาก client
4. อัปเดต `.env` ของ Yoonai ในเครื่องให้ตรง production

### เฟส 3: ALL APP (ดัดแปลง demovault) และหน้าจัดการผู้ใช้
1. แยกส่วน "บัญชีของโปรเจกต์" ให้เห็นเฉพาะแอดมิน
2. อ่านรายการระบบและสิทธิ์จาก Hub (`/me`) แสดงการ์ดตามบทบาท + การ์ด Superadmin
3. หน้าแอดมิน: ดูพนักงานที่ผูก LINE, กำหนดบทบาท, ยกเลิกการผูก (ลาออก → unlink Rich Menu)

### เฟส 4: แจ้งเตือน
`/notify` ให้ Yoonai, Workpath, Weajer, วงษ์หิรัญ ส่งผ่าน OA (วงษ์หิรัญส่ง push หาแอดมิน/กลุ่มอยู่แล้ว ต้องเช็คว่าใช้ OA ตัวไหน)

## 5. ที่ยังต้องรู้

- วงษ์หิรัญ (channel `2009395213` และ `…5221`) อยู่ Provider ไหน และ Messaging API ที่ส่ง push คือ OA ตัวไหน
- ยืนยันวิธียืนยันตัวตนพนักงานและ tech stack ข้างบน
- Workpath ถ้าจะทำ LIFF ต้องระบุว่าให้เปิดหน้าไหนของแอป
