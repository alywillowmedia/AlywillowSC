alter table "SlidecartTier"
  add column if not exists "rewardType" text not null default 'gift';
