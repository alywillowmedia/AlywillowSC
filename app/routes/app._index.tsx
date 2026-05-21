import { useEffect, useState } from 'react';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { useFetcher, useLoaderData } from 'react-router';
import { useAppBridge } from '@shopify/app-bridge-react';
import { authenticate } from '../shopify.server';
import {
  getOrCreateSlidecartSettings,
  saveSlidecartSettings,
} from '../models.slidecart.server';
import styles from '../styles/slidecart-admin.module.css';

type VariantOption = {
  value: string;
  gid: string;
  label: string;
  image: string;
  price: string;
  available: boolean;
};

type TierForm = {
  tierIndex: number;
  enabled: boolean;
  requiredSubtotalCents: number;
  rewardLabel: string;
  rewardType: string;
  giftVariantId: string;
  giftVariantGid: string;
  giftTitle: string;
  giftImageUrl: string;
  giftPrice: string;
};

type SettingsForm = {
  enabled: boolean;
  cartTitle: string;
  customText: string;
  progressIntro: string;
  giftChooserText: string;
  discountCtaNote: string;
  maxFreeGifts: number;
  buttonFillColor: string;
  buttonTextColor: string;
  panelBackground: string;
  tiers: TierForm[];
};

type LoaderData = {
  settings: SettingsForm;
  variantOptions: VariantOption[];
};

type ActionData = {
  ok: boolean;
  error?: string;
  warning?: string;
};

const REWARD_TYPE_GIFT = 'gift';
const REWARD_TYPE_FREE_SHIPPING = 'free_shipping';
const SHIPPING_DISCOUNT_TITLE = 'Alywillow Slidecart Free Shipping';
const SHIPPING_DISCOUNT_FUNCTION_HANDLE = 'free-gift-discount';
const SHIPPING_DISCOUNT_METAFIELD_NAMESPACE = '$app:free-gift-discount';
const SHIPPING_DISCOUNT_METAFIELD_KEY = 'function-configuration';

function toFormSettings(settings: Awaited<ReturnType<typeof getOrCreateSlidecartSettings>>): SettingsForm {
  return {
    enabled: settings.enabled,
    cartTitle: settings.cartTitle,
    customText: settings.customText,
    progressIntro: settings.progressIntro,
    giftChooserText: settings.giftChooserText,
    discountCtaNote: settings.discountCtaNote,
    maxFreeGifts: settings.maxFreeGifts,
    buttonFillColor: settings.buttonFillColor,
    buttonTextColor: settings.buttonTextColor,
    panelBackground: settings.panelBackground,
    tiers: settings.tiers.map((tier) => ({
      tierIndex: tier.tierIndex,
      enabled: tier.enabled,
      requiredSubtotalCents: tier.requiredSubtotalCents,
      rewardLabel: tier.rewardLabel,
      rewardType: tier.rewardType || REWARD_TYPE_GIFT,
      giftVariantId: tier.giftVariantId,
      giftVariantGid: tier.giftVariantGid || '',
      giftTitle: tier.giftTitle,
      giftImageUrl: tier.giftImageUrl || '',
      giftPrice: tier.giftPrice || '',
    })),
  };
}

function gidToLegacyId(gid: string) {
  const id = String(gid || '').split('/').pop() || '0';
  return /^\d+$/.test(id) ? id : '0';
}

function extractImageUrl(value: any): string {
  const firstImage = Array.isArray(value?.images)
    ? value.images[0]
    : value?.images?.edges?.[0]?.node;

  return String(
    value?.image?.url ||
      value?.image?.src ||
      value?.image?.originalSrc ||
      value?.image?.transformedSrc ||
      value?.featuredImage?.url ||
      value?.featuredImage?.src ||
      value?.featuredImage?.originalSrc ||
      value?.featuredImage?.transformedSrc ||
      value?.featured_image?.url ||
      value?.featured_image?.src ||
      value?.featured_image?.originalSrc ||
      value?.featured_image?.transformedSrc ||
      value?.images?.[0]?.url ||
      value?.images?.[0]?.src ||
      value?.images?.[0]?.originalSrc ||
      value?.images?.[0]?.transformedSrc ||
      value?.images?.edges?.[0]?.node?.url ||
      value?.images?.edges?.[0]?.node?.src ||
      value?.images?.edges?.[0]?.node?.originalSrc ||
      value?.images?.edges?.[0]?.node?.transformedSrc ||
      firstImage?.url ||
      firstImage?.src ||
      firstImage?.originalSrc ||
      firstImage?.transformedSrc ||
      '',
  );
}

function extractPrice(value: any): string {
  return String(value?.price?.amount || value?.price || '');
}

function variantOptionFromNode(variant: any, product: any): VariantOption | null {
  if (!variant?.id) return null;
  const productTitle = product?.title ?? variant?.product?.title ?? 'Product';
  const variantTitle = variant?.title || 'Default';

  return {
    value: String(variant?.legacyResourceId ?? gidToLegacyId(String(variant.id || ''))),
    gid: String(variant.id || ''),
    label: `${productTitle} - ${variantTitle}`,
    image: extractImageUrl({
      image: variant?.image,
      featuredImage: product?.featuredImage || variant?.product?.featuredImage,
      images: product?.images || variant?.product?.images,
    }),
    price: extractPrice(variant),
    available: Boolean(variant?.availableForSale ?? true),
  };
}

function normalizeRewardType(value: unknown) {
  return String(value || '') === REWARD_TYPE_FREE_SHIPPING
    ? REWARD_TYPE_FREE_SHIPPING
    : REWARD_TYPE_GIFT;
}

function buildFreeShippingFunctionConfig(settings: SettingsForm) {
  return {
    tiers: settings.tiers
      .filter((tier) => tier.enabled && normalizeRewardType(tier.rewardType) === REWARD_TYPE_FREE_SHIPPING)
      .map((tier) => ({
        id: `tier-${tier.tierIndex}`,
        requiredSubtotalCents: Math.max(0, Number(tier.requiredSubtotalCents) || 0),
        rewardLabel: tier.rewardLabel || 'Free shipping',
      })),
  };
}

async function syncFreeShippingDiscount(admin: any, settings: SettingsForm) {
  const config = buildFreeShippingFunctionConfig(settings);
  const hasFreeShippingTier = config.tiers.length > 0;

  if (!hasFreeShippingTier) return;

  const existingResponse = await admin.graphql(`#graphql
    query SlidecartShippingDiscount {
      discountNodes(first: 25, query: "type:app method:automatic") {
        nodes {
          id
          discount {
            ... on DiscountAutomaticApp {
              title
            }
          }
        }
      }
    }
  `);
  const existingJson = await existingResponse.json();
  if (existingJson?.errors?.length) {
    throw new Error(existingJson.errors.map((error: any) => error.message).join(', '));
  }
  const existingDiscount = (existingJson?.data?.discountNodes?.nodes ?? []).find((node: any) => {
    return node?.discount?.title === SHIPPING_DISCOUNT_TITLE;
  });

  const automaticAppDiscount = {
    title: SHIPPING_DISCOUNT_TITLE,
    functionHandle: SHIPPING_DISCOUNT_FUNCTION_HANDLE,
    discountClasses: ['SHIPPING'],
    startsAt: new Date().toISOString(),
    combinesWith: {
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: false,
    },
    metafields: [
      {
        namespace: SHIPPING_DISCOUNT_METAFIELD_NAMESPACE,
        key: SHIPPING_DISCOUNT_METAFIELD_KEY,
        type: 'json',
        value: JSON.stringify(config),
      },
    ],
  };

  const mutation = existingDiscount?.id
    ? `#graphql
      mutation SlidecartUpdateShippingDiscount($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount {
            discountId
            title
          }
          userErrors {
            field
            message
          }
        }
      }
    `
    : `#graphql
      mutation SlidecartCreateShippingDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount {
            discountId
            title
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

  const response = await admin.graphql(
    mutation,
    existingDiscount?.id
      ? { variables: { id: existingDiscount.id, automaticAppDiscount } }
      : { variables: { automaticAppDiscount } },
  );
  const json = await response.json();
  if (json?.errors?.length) {
    throw new Error(json.errors.map((error: any) => error.message).join(', '));
  }
  const payload = existingDiscount?.id
    ? json?.data?.discountAutomaticAppUpdate
    : json?.data?.discountAutomaticAppCreate;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((error: any) => error.message).join(', '));
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getOrCreateSlidecartSettings(session.shop);

  const productsResponse = await admin.graphql(`#graphql
    query SlidecartVariants {
      products(first: 50, sortKey: TITLE) {
        edges {
          node {
            title
            featuredImage {
              url
            }
            images(first: 1) {
              edges {
                node {
                  url
                }
              }
            }
            variants(first: 50) {
              edges {
                node {
                  id
                  legacyResourceId
                  title
                  displayName
                  availableForSale
                  image {
                    url
                  }
                  price
                }
              }
            }
          }
        }
      }
    }
  `);

  const productsJson = await productsResponse.json();

  const quickVariantOptions: VariantOption[] =
    productsJson?.data?.products?.edges?.flatMap((edge: any) => {
      return (edge?.node?.variants?.edges ?? [])
        .map((variantEdge: any) => variantOptionFromNode(variantEdge?.node, edge?.node))
        .filter(Boolean);
    }) ?? [];

  const selectedVariantGids = [
    ...new Set(
      settings.tiers
        .map((tier) => String(tier.giftVariantGid || '').trim())
        .filter(Boolean),
    ),
  ];

  let selectedVariantOptions: VariantOption[] = [];
  if (selectedVariantGids.length) {
    const selectedResponse = await admin.graphql(
      `#graphql
        query SlidecartSelectedVariants($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              legacyResourceId
              title
              availableForSale
              image {
                url
              }
              price
              product {
                title
                featuredImage {
                  url
                }
                images(first: 1) {
                  edges {
                    node {
                      url
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { variables: { ids: selectedVariantGids } },
    );
    const selectedJson = await selectedResponse.json();
    selectedVariantOptions = (selectedJson?.data?.nodes ?? [])
      .map((node: any) => variantOptionFromNode(node, node?.product))
      .filter(Boolean);
  }

  const variantOptions = [...selectedVariantOptions, ...quickVariantOptions].filter((option, index, all) => {
    return option && all.findIndex((candidate) => candidate.gid === option.gid) === index;
  });

  return {
    settings: toFormSettings(settings),
    variantOptions,
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const payloadText = String(formData.get('config_json') || '{}');

    let payload: SettingsForm;
    try {
      payload = JSON.parse(payloadText) as SettingsForm;
    } catch {
      return { ok: false, error: 'Invalid settings payload' } satisfies ActionData;
    }

    const tiers = (payload.tiers || [])
      .slice(0, 4)
      .map((tier, index) => ({
        tierIndex: index + 1,
        enabled: Boolean(tier.enabled),
        requiredSubtotalCents: Math.max(0, Number(tier.requiredSubtotalCents) || 0),
        rewardLabel: String(tier.rewardLabel || `Tier ${index + 1}`),
        rewardType: normalizeRewardType(tier.rewardType),
        giftVariantId: String(tier.giftVariantId || '0'),
        giftVariantGid: String(tier.giftVariantGid || ''),
        giftTitle: String(tier.giftTitle || tier.rewardLabel || `Tier ${index + 1} Gift`),
        giftImageUrl: String(tier.giftImageUrl || ''),
        giftPrice: String(tier.giftPrice || ''),
      }));

    if (tiers.length !== 4) {
      return { ok: false, error: 'Exactly 4 tiers are required' } satisfies ActionData;
    }

    const normalizedSettings = {
      enabled: Boolean(payload.enabled),
      cartTitle: String(payload.cartTitle || 'Your Cart'),
      customText: String(payload.customText || ''),
      progressIntro: String(payload.progressIntro || "You're only [amount] away from getting [reward] for free!"),
      giftChooserText: String(payload.giftChooserText || 'Choose reward:'),
      discountCtaNote: String(payload.discountCtaNote || 'Add discount code at checkout'),
      maxFreeGifts: 1,
      buttonFillColor: String(payload.buttonFillColor || '#000000'),
      buttonTextColor: String(payload.buttonTextColor || '#FFFFFF'),
      panelBackground: String(payload.panelBackground || '#f3f3f3'),
      tiers,
    };

    await saveSlidecartSettings(session.shop, normalizedSettings);

    try {
      await syncFreeShippingDiscount(admin, normalizedSettings);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Shopify discount sync error';
      return {
        ok: true,
        warning: `Settings saved, but free shipping discount sync failed: ${message}`,
      } satisfies ActionData;
    }

    return { ok: true } satisfies ActionData;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown server error';
    return { ok: false, error: `Unable to save slidecart settings: ${message}` } satisfies ActionData;
  }
};

export default function AppIndex() {
  const { settings, variantOptions } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<ActionData>();
  const shopify = useAppBridge() as any;
  const [form, setForm] = useState<SettingsForm>(settings);
  const isSaving = fetcher.state !== 'idle';
  const variantById = new Map(variantOptions.map((option) => [option.value, option]));
  const variantByGid = new Map(variantOptions.map((option) => [option.gid, option]));

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show('Slidecart settings saved');
      if (fetcher.data.warning) {
        shopify.toast.show(fetcher.data.warning, { isError: true });
      }
    }
    if (fetcher.data && !fetcher.data.ok && fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  useEffect(() => {
    setForm((current) => {
      let changed = false;
      const tiers = current.tiers.map((tier) => {
        if (normalizeRewardType(tier.rewardType) === REWARD_TYPE_FREE_SHIPPING) return tier;
        const match = variantById.get(tier.giftVariantId) || variantByGid.get(tier.giftVariantGid);
        if (!match) return tier;

        const next = { ...tier };
        if (!next.giftImageUrl && match.image) {
          next.giftImageUrl = match.image;
          changed = true;
        }
        if (!next.giftPrice && match.price) {
          next.giftPrice = match.price;
          changed = true;
        }
        if ((!next.giftTitle || next.giftTitle.startsWith('Tier ')) && match.label) {
          next.giftTitle = match.label;
          changed = true;
        }
        return next;
      });

      return changed ? { ...current, tiers } : current;
    });
  }, [variantByGid, variantById]);

  function updateTier(index: number, next: Partial<TierForm>) {
    setForm((current) => {
      const tiers = [...current.tiers];
      tiers[index] = { ...tiers[index], ...next };
      return { ...current, tiers };
    });
  }

  async function pickTierGift(index: number) {
    if (!shopify?.resourcePicker) {
      shopify.toast.show('Resource picker unavailable', { isError: true });
      return;
    }

    const selection = await shopify.resourcePicker({
      type: 'product',
      action: 'select',
      multiple: false,
      filter: { hidden: false, draft: true, archived: false, variants: true },
    });

    const product = Array.isArray(selection) ? selection[0] : selection?.selection?.[0];
    if (!product) return;

    const variant = Array.isArray(product.variants) && product.variants.length ? product.variants[0] : null;
    if (!variant?.id) {
      shopify.toast.show('Please select a product variant', { isError: true });
      return;
    }
    const variantGid = String(variant.id);
    const variantId = gidToLegacyId(variantGid);
    const knownVariant = variantByGid.get(variantGid) || variantById.get(variantId);
    const productTitle = String(product.title || 'Product');
    const variantTitle = String(variant.title || 'Default');
    const displayTitle = `${productTitle} - ${variantTitle}`;
    const image = knownVariant?.image || extractImageUrl({
      image: variant.image,
      featuredImage: product.featuredImage,
      images: product.images,
    });
    const price = knownVariant?.price || extractPrice(variant);

    updateTier(index, {
      giftVariantId: variantId,
      giftVariantGid: variantGid,
      giftTitle: displayTitle,
      giftImageUrl: image,
      giftPrice: price,
      rewardLabel: form.tiers[index].rewardLabel || productTitle,
    });
  }

  return (
    <s-page heading="Slidecart Settings">
      <s-section heading="General">
        <div className={styles.stack}>
          <s-checkbox
            label="Enable slidecart"
            checked={form.enabled}
            onChange={(e) => setForm((c) => ({ ...c, enabled: e.currentTarget.checked }))}
          />

          <s-text-field
            label="Cart title"
            value={form.cartTitle}
            onChange={(e) => setForm((c) => ({ ...c, cartTitle: e.currentTarget.value }))}
          />

          <s-text-area
            label="Progress text (use [amount] and [reward])"
            value={form.progressIntro}
            onChange={(e) => setForm((c) => ({ ...c, progressIntro: e.currentTarget.value }))}
          />

          <s-text-field
            label="Reward chooser heading"
            value={form.giftChooserText}
            onChange={(e) => setForm((c) => ({ ...c, giftChooserText: e.currentTarget.value }))}
          />

          <s-text-area
            label="Custom text block"
            value={form.customText}
            onChange={(e) => setForm((c) => ({ ...c, customText: e.currentTarget.value }))}
          />

          <s-text-field
            label="Checkout note"
            value={form.discountCtaNote}
            onChange={(e) => setForm((c) => ({ ...c, discountCtaNote: e.currentTarget.value }))}
          />
        </div>
      </s-section>

      <s-section heading="Style">
        <div className={styles.colorGrid}>
          <s-text-field
            label="Button fill color"
            value={form.buttonFillColor}
            onChange={(e) => setForm((c) => ({ ...c, buttonFillColor: e.currentTarget.value }))}
          />
          <s-text-field
            label="Button text color"
            value={form.buttonTextColor}
            onChange={(e) => setForm((c) => ({ ...c, buttonTextColor: e.currentTarget.value }))}
          />
          <s-text-field
            label="Drawer background color"
            value={form.panelBackground}
            onChange={(e) => setForm((c) => ({ ...c, panelBackground: e.currentTarget.value }))}
          />
        </div>
      </s-section>

      <s-section heading="Tier rewards">
        <div className={styles.tierGrid}>
          {form.tiers.map((tier, index) => (
            <div key={tier.tierIndex} className={styles.tierCard}>
              <div className={styles.tierHead}>
                <h3 style={{ margin: 0 }}>Tier {tier.tierIndex}</h3>
                <s-checkbox
                  label="Enabled"
                  checked={tier.enabled}
                  onChange={(e) => updateTier(index, { enabled: e.currentTarget.checked })}
                />
              </div>

              <div className={styles.twoCol}>
                <s-text-field
                  label="Reward label"
                  value={tier.rewardLabel}
                  onChange={(e) => updateTier(index, { rewardLabel: e.currentTarget.value })}
                />
                <s-text-field
                  label="Threshold ($)"
                  value={String(Math.round(tier.requiredSubtotalCents / 100))}
                  onChange={(e) =>
                    updateTier(index, {
                      requiredSubtotalCents: Math.max(0, Number(e.currentTarget.value || 0) * 100),
                    })
                  }
                />
              </div>

              <div className={styles.rewardTypeRow}>
                <div className={styles.fieldLabel}>Reward type</div>
                <div className={styles.rewardTypeToggle}>
                  <button
                    type="button"
                    className={`${styles.rewardTypeButton} ${
                      normalizeRewardType(tier.rewardType) === REWARD_TYPE_GIFT ? styles.rewardTypeButtonActive : ''
                    }`}
                    onClick={() => updateTier(index, { rewardType: REWARD_TYPE_GIFT })}
                  >
                    Free gift
                  </button>
                  <button
                    type="button"
                    className={`${styles.rewardTypeButton} ${
                      normalizeRewardType(tier.rewardType) === REWARD_TYPE_FREE_SHIPPING ? styles.rewardTypeButtonActive : ''
                    }`}
                    onClick={() => updateTier(index, { rewardType: REWARD_TYPE_FREE_SHIPPING })}
                  >
                    Free shipping
                  </button>
                </div>
              </div>

              {normalizeRewardType(tier.rewardType) === REWARD_TYPE_GIFT ? (
                <>
                  <div className={styles.pickerRow}>
                    <s-button onClick={() => pickTierGift(index)}>Search & select gift in Shopify</s-button>
                    <span className={styles.quickLabel}>or quick select:</span>
                    <s-select
                      label="Quick select gift"
                      labelAccessibilityVisibility="exclusive"
                      value={tier.giftVariantId}
                      onChange={(e) => {
                        const selected = variantOptions.find((v) => v.value === e.currentTarget.value);
                        if (!selected) {
                          updateTier(index, { giftVariantId: '0', giftVariantGid: '', giftTitle: '', giftImageUrl: '', giftPrice: '' });
                          return;
                        }
                        updateTier(index, {
                          giftVariantId: selected.value,
                          giftVariantGid: selected.gid,
                          giftTitle: selected.label,
                          giftImageUrl: selected.image,
                          giftPrice: selected.price,
                        });
                      }}
                    >
                      <option value="0">Select variant</option>
                      {variantOptions.map((option) => (
                        <option key={`${tier.tierIndex}-${option.gid}`} value={option.value}>
                          {option.label}{option.available ? '' : ' (Sold out)'}
                        </option>
                      ))}
                    </s-select>
                  </div>

                  <div className={styles.preview}>
                    <img
                      src={tier.giftImageUrl || 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png'}
                      alt="Gift preview"
                    />
                    <div>
                      <div className={styles.previewTitle}>{tier.giftTitle || 'No gift selected'}</div>
                      <div className={styles.previewMeta}>{tier.giftPrice ? `$${tier.giftPrice}` : 'No price'}</div>
                    </div>
                  </div>
                </>
              ) : (
                <div className={styles.preview}>
                  <div className={styles.shippingPreviewIcon}>%</div>
                  <div>
                    <div className={styles.previewTitle}>Free shipping</div>
                    <div className={styles.previewMeta}>Unlocks at ${Math.round(tier.requiredSubtotalCents / 100)}</div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </s-section>

      <fetcher.Form method="post">
        <input type="hidden" name="config_json" value={JSON.stringify(form)} />
        <s-button type="submit" variant="primary" {...(isSaving ? { loading: true } : {})}>Save settings</s-button>
      </fetcher.Form>
    </s-page>
  );
}
