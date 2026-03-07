create table if not exists "SlidecartTier" (
  id bigserial primary key,
  "settingsId" bigint not null references "SlidecartSettings"(id) on delete cascade,
  "tierIndex" integer not null,
  enabled boolean not null default true,
  "requiredSubtotalCents" integer not null,
  "rewardLabel" text not null,
  "giftVariantId" text not null,
  "giftVariantGid" text,
  "giftTitle" text not null,
  "giftImageUrl" text,
  "giftPrice" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("settingsId", "tierIndex")
);

create index if not exists "SlidecartTier_settingsId_idx" on "SlidecartTier" ("settingsId");
