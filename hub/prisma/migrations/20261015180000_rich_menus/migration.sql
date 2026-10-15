-- CreateTable
CREATE TABLE `rich_menus` (
    `id` VARCHAR(191) NOT NULL,
    `menu_key` VARCHAR(191) NOT NULL,
    `width` INTEGER NOT NULL,
    `height` INTEGER NOT NULL,
    `chat_bar_text` VARCHAR(191) NOT NULL,
    `areas` JSON NOT NULL,
    `image` MEDIUMBLOB NULL,
    `image_type` VARCHAR(191) NULL,
    `dirty` BOOLEAN NOT NULL DEFAULT true,
    `published_at` DATETIME(3) NULL,
    `updated_by` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `rich_menus_menu_key_key`(`menu_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

