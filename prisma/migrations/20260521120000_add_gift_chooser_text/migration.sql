ALTER TABLE "SlidecartSettings"
ADD COLUMN IF NOT EXISTS "giftChooserText" TEXT NOT NULL DEFAULT 'Choose reward:';
