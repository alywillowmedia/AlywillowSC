import prisma from './db.server';

export type SlidecartTierInput = {
  tierIndex: number;
  enabled: boolean;
  requiredSubtotalCents: number;
  rewardLabel: string;
  giftVariantId: string;
  giftVariantGid?: string;
  giftTitle: string;
  giftImageUrl?: string;
  giftPrice?: string;
};

export type SlidecartSettingsInput = {
  enabled: boolean;
  cartTitle: string;
  customText: string;
  progressIntro: string;
  discountCtaNote: string;
  maxFreeGifts: number;
  buttonFillColor: string;
  buttonTextColor: string;
  panelBackground: string;
  tiers: SlidecartTierInput[];
};

const DEFAULT_TIERS: SlidecartTierInput[] = [
  {
    tierIndex: 1,
    enabled: true,
    requiredSubtotalCents: 7500,
    rewardLabel: 'Stress Relief Inhaler',
    giftVariantId: '0',
    giftVariantGid: '',
    giftTitle: 'Stress Relief Inhaler',
    giftImageUrl: '',
    giftPrice: '',
  },
  {
    tierIndex: 2,
    enabled: true,
    requiredSubtotalCents: 10000,
    rewardLabel: 'LL Bar',
    giftVariantId: '0',
    giftVariantGid: '',
    giftTitle: 'Lemon Laughs Nutrient Bar Cleanser',
    giftImageUrl: '',
    giftPrice: '',
  },
  {
    tierIndex: 3,
    enabled: true,
    requiredSubtotalCents: 15000,
    rewardLabel: 'Sweet Magic Spritzer',
    giftVariantId: '0',
    giftVariantGid: '',
    giftTitle: 'Sweet Magic Spritzer',
    giftImageUrl: '',
    giftPrice: '',
  },
  {
    tierIndex: 4,
    enabled: true,
    requiredSubtotalCents: 20000,
    rewardLabel: 'Wildwood Level 5 Moisturizer',
    giftVariantId: '0',
    giftVariantGid: '',
    giftTitle: 'Wildwood Level 5 Moisturizer',
    giftImageUrl: '',
    giftPrice: '',
  },
];

const DEFAULT_SETTINGS: Omit<SlidecartSettingsInput, 'tiers'> = {
  enabled: true,
  cartTitle: 'Your Cart',
  customText: 'Choose ONE free gift! *Qualifying orders only.*',
  progressIntro: "You're only [amount] away from getting [reward] for free!",
  discountCtaNote: 'Add discount code at checkout',
  maxFreeGifts: 1,
  buttonFillColor: '#000000',
  buttonTextColor: '#FFFFFF',
  panelBackground: '#f3f3f3',
};

export async function getOrCreateSlidecartSettings(shop: string) {
  const existing = await prisma.slidecartSettings.findUnique({
    where: { shop },
    include: { tiers: { orderBy: { tierIndex: 'asc' } } },
  });

  if (existing) {
    return existing;
  }

  return prisma.slidecartSettings.create({
    data: {
      shop,
      ...DEFAULT_SETTINGS,
      tiers: {
        create: DEFAULT_TIERS,
      },
    },
    include: { tiers: { orderBy: { tierIndex: 'asc' } } },
  });
}

export async function saveSlidecartSettings(shop: string, input: SlidecartSettingsInput) {
  const existing = await getOrCreateSlidecartSettings(shop);

  return prisma.$transaction(async (tx) => {
    await tx.slidecartTier.deleteMany({ where: { settingsId: existing.id } });

    await tx.slidecartSettings.update({
      where: { id: existing.id },
      data: {
        enabled: input.enabled,
        cartTitle: input.cartTitle,
        customText: input.customText,
        progressIntro: input.progressIntro,
        discountCtaNote: input.discountCtaNote,
        maxFreeGifts: input.maxFreeGifts,
        buttonFillColor: input.buttonFillColor,
        buttonTextColor: input.buttonTextColor,
        panelBackground: input.panelBackground,
      },
    });

    await tx.slidecartTier.createMany({
      data: input.tiers.map((tier) => ({
        settingsId: existing.id,
        tierIndex: tier.tierIndex,
        enabled: tier.enabled,
        requiredSubtotalCents: tier.requiredSubtotalCents,
        rewardLabel: tier.rewardLabel,
        giftVariantId: tier.giftVariantId,
        giftVariantGid: tier.giftVariantGid || '',
        giftTitle: tier.giftTitle,
        giftImageUrl: tier.giftImageUrl || '',
        giftPrice: tier.giftPrice || '',
      })),
    });

    return tx.slidecartSettings.findUniqueOrThrow({
      where: { id: existing.id },
      include: { tiers: { orderBy: { tierIndex: 'asc' } } },
    });
  });
}

export function settingsToProxyConfig(settings: Awaited<ReturnType<typeof getOrCreateSlidecartSettings>>) {
  return {
    enabled: settings.enabled,
    cartTitle: settings.cartTitle,
    customText: settings.customText,
    progressIntro: settings.progressIntro,
    discountCtaNote: settings.discountCtaNote,
    maxFreeGifts: settings.maxFreeGifts,
    buttonFillColor: settings.buttonFillColor,
    buttonTextColor: settings.buttonTextColor,
    panelBackground: settings.panelBackground,
    tiers: settings.tiers
      .filter((tier) => tier.enabled)
      .map((tier) => ({
        id: `tier-${tier.tierIndex}`,
        requiredSubtotalCents: tier.requiredSubtotalCents,
        rewardLabel: tier.rewardLabel,
        gift: {
          variantId: Number(tier.giftVariantId || '0'),
          title: tier.giftTitle || tier.rewardLabel,
          image: tier.giftImageUrl || '',
          price: tier.giftPrice || '',
        },
      })),
  };
}
