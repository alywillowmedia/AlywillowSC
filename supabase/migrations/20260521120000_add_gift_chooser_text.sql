alter table "SlidecartSettings"
  add column if not exists "giftChooserText" text not null default 'Choose reward:';
