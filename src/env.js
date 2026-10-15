// โหลด .env (Node 20.12+ มี process.loadEnvFile) — ไม่มีไฟล์ก็ผ่านไปได้ (ใช้ env ของระบบ)
import { existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './config.js'

const file = path.join(ROOT, '.env')
if (existsSync(file)) process.loadEnvFile(file)
