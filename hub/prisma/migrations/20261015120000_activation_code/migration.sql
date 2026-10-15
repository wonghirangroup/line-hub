-- รหัสผ่านเปิดใช้งานที่ superadmin สุ่มออกให้พนักงาน (ใช้ครั้งเดียว มีวันหมดอายุ เก็บเฉพาะแฮช)
ALTER TABLE `users`
    ADD COLUMN `activation_hash` VARCHAR(191) NULL,
    ADD COLUMN `activation_expires_at` DATETIME(3) NULL,
    ADD COLUMN `activation_issued_by` VARCHAR(191) NULL,
    ADD COLUMN `activation_failed` INTEGER NOT NULL DEFAULT 0;
