import {
  DeliveryDiscountSelectionStrategy,
  DiscountClass,
  DeliveryInput,
  CartDeliveryOptionsDiscountsGenerateRunResult,
} from "../generated/api";

type ShippingTierConfig = {
  id?: string;
  requiredSubtotalCents?: number;
  rewardLabel?: string;
};

const SHIPPING_REWARD_PREFIX = 'shipping:';

function toCents(amount: unknown) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

function getShippingTiers(input: DeliveryInput): ShippingTierConfig[] {
  const rawConfig = (input as any)?.discount?.metafield?.jsonValue;
  const tiers = Array.isArray(rawConfig?.tiers) ? rawConfig.tiers : [];

  return tiers
    .map((tier: any) => ({
      id: String(tier?.id || ''),
      requiredSubtotalCents: Number(tier?.requiredSubtotalCents || 0),
      rewardLabel: String(tier?.rewardLabel || 'Free shipping'),
    }))
    .filter((tier: ShippingTierConfig) => {
      return Number.isFinite(tier.requiredSubtotalCents) && Number(tier.requiredSubtotalCents) > 0;
    })
    .sort((a: ShippingTierConfig, b: ShippingTierConfig) => {
      return Number(a.requiredSubtotalCents || 0) - Number(b.requiredSubtotalCents || 0);
    });
}

function getUnlockedShippingTier(input: DeliveryInput) {
  const subtotalCents = toCents((input as any)?.cart?.cost?.subtotalAmount?.amount);
  const selectedReward = String((input as any)?.cart?.selectedReward?.value || '');
  if (!selectedReward.startsWith(SHIPPING_REWARD_PREFIX)) return null;

  const selectedTierId = selectedReward.slice(SHIPPING_REWARD_PREFIX.length);
  const hasFreeGift = Array.isArray((input as any)?.cart?.lines)
    && (input as any).cart.lines.some((line: any) => String(line?.freeGift?.value || '') === '1');
  if (hasFreeGift) return null;

  return getShippingTiers(input).reduce<ShippingTierConfig | null>((unlocked, tier) => {
    if (tier.id && tier.id !== selectedTierId) return unlocked;
    return subtotalCents >= Number(tier.requiredSubtotalCents || 0) ? tier : unlocked;
  }, null);
}

export function cartDeliveryOptionsDiscountsGenerateRun(
  input: DeliveryInput,
): CartDeliveryOptionsDiscountsGenerateRunResult {
  const firstDeliveryGroup = input.cart.deliveryGroups[0];
  if (!firstDeliveryGroup) {
    return {operations: []};
  }

  const hasShippingDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Shipping,
  );

  if (!hasShippingDiscountClass) {
    return {operations: []};
  }

  const unlockedShippingTier = getUnlockedShippingTier(input);
  if (!unlockedShippingTier) {
    return {operations: []};
  }

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          candidates: [
            {
              message: unlockedShippingTier.rewardLabel || "Free shipping",
              targets: [
                {
                  deliveryGroup: {
                    id: firstDeliveryGroup.id,
                  },
                },
              ],
              value: {
                percentage: {
                  value: 100,
                },
              },
            },
          ],
          selectionStrategy: DeliveryDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
