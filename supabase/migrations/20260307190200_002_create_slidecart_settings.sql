create table if not exists "SlidecartSettings" (
  id bigserial primary key,
  shop text not null unique,
  enabled boolean not null default true,
  "cartTitle" text not null default 'Your Cart',
  "customText" text not null default 'Choose ONE free gift! *Qualifying orders only.*',
  "progressIntro" text not null default 'You''re only [amount] away from getting [reward] for free!',
  "discountCtaNote" text not null default 'Add discount code at checkout',
  "maxFreeGifts" integer not null default 1,
  "buttonFillColor" text not null default '#000000',
  "buttonTextColor" text not null default '#FFFFFF',
  "panelBackground" text not null default '#f3f3f3',
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
