-- รันด้วยผู้ดูแลฐานข้อมูล (เซิร์ฟเวอร์ MariaDB เดียวกับ Yoonai) — เปลี่ยนรหัสผ่านก่อนรัน
CREATE DATABASE IF NOT EXISTS line_hub CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'line_hub'@'%' IDENTIFIED BY 'CHANGE_ME_LONG_RANDOM';
GRANT ALL PRIVILEGES ON line_hub.* TO 'line_hub'@'%';
FLUSH PRIVILEGES;
-- DATABASE_URL=mysql://line_hub:<รหัสผ่าน>@<host DB>:3306/line_hub?connection_limit=5&pool_timeout=10
