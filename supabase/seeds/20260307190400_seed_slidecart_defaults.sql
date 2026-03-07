-- Optional seed for one store. Replace the shop domain before running.
-- Example shop: alywillow.com

with upsert_settings as (
  insert into "SlidecartSettings" (
    shop,
    enabled,
    "cartTitle",
    "customText",
    "progressIntro",
    "discountCtaNote",
    "maxFreeGifts",
    "buttonFillColor",
    "buttonTextColor",
    "panelBackground"
  ) values (
    'REPLACE_SHOP_DOMAIN',
    true,
    'Your Cart',
    'Choose ONE free gift! *Qualifying orders only.*',
    'You''re only [amount] away from getting [reward] for free!',
    'Add discount code at checkout',
    1,
    '#000000',
    '#FFFFFF',
    '#f3f3f3'
  )
  on conflict (shop) do update set
    enabled = excluded.enabled,
    "cartTitle" = excluded."cartTitle",
    "customText" = excluded."customText",
    "progressIntro" = excluded."progressIntro",
    "discountCtaNote" = excluded."discountCtaNote",
    "maxFreeGifts" = excluded."maxFreeGifts",
    "buttonFillColor" = excluded."buttonFillColor",
    "buttonTextColor" = excluded."buttonTextColor",
    "panelBackground" = excluded."panelBackground",
    "updatedAt" = now()
  returning id
)
insert into "SlidecartTier" (
  "settingsId", "tierIndex", enabled, "requiredSubtotalCents", "rewardLabel",
  "giftVariantId", "giftVariantGid", "giftTitle", "giftImageUrl", "giftPrice"
)
select
  id,
  t.tier_index,
  true,
  t.required_subtotal_cents,
  t.reward_label,
  '0',
  null,
  t.reward_label,
  null,
  null
from upsert_settings
cross join (
  values
    (1, 7500, 'Tier 1 Gift'),
    (2, 10000, 'Tier 2 Gift'),
    (3, 15000, 'Tier 3 Gift'),
    (4, 20000, 'Tier 4 Gift')
) as t(tier_index, required_subtotal_cents, reward_label)
on conflict ("settingsId", "tierIndex") do update set
  "requiredSubtotalCents" = excluded."requiredSubtotalCents",
  "rewardLabel" = excluded."rewardLabel",
  "updatedAt" = now();
