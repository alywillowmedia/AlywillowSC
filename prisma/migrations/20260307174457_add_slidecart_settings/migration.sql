-- CreateTable
CREATE TABLE "SlidecartSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cartTitle" TEXT NOT NULL DEFAULT 'Your Cart',
    "customText" TEXT NOT NULL DEFAULT 'Choose ONE free gift! *Qualifying orders only.*',
    "progressIntro" TEXT NOT NULL DEFAULT 'You''re only [amount] away from getting [reward] for free!',
    "discountCtaNote" TEXT NOT NULL DEFAULT 'Add discount code at checkout',
    "maxFreeGifts" INTEGER NOT NULL DEFAULT 1,
    "buttonFillColor" TEXT NOT NULL DEFAULT '#000000',
    "buttonTextColor" TEXT NOT NULL DEFAULT '#FFFFFF',
    "panelBackground" TEXT NOT NULL DEFAULT '#f3f3f3',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SlidecartTier" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "settingsId" INTEGER NOT NULL,
    "tierIndex" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "requiredSubtotalCents" INTEGER NOT NULL,
    "rewardLabel" TEXT NOT NULL,
    "giftVariantId" TEXT NOT NULL,
    "giftTitle" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SlidecartTier_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "SlidecartSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SlidecartSettings_shop_key" ON "SlidecartSettings"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "SlidecartTier_settingsId_tierIndex_key" ON "SlidecartTier"("settingsId", "tierIndex");
