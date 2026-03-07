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
};

function toFormSettings(settings: Awaited<ReturnType<typeof getOrCreateSlidecartSettings>>): SettingsForm {
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
    tiers: settings.tiers.map((tier) => ({
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
  };
}

function gidToLegacyId(gid: string) {
  const id = String(gid || '').split('/').pop() || '0';
  return /^\d+$/.test(id) ? id : '0';
}

function extractImageUrl(value: any): string {
  return String(
    value?.image?.url ||
      value?.image?.src ||
      value?.image?.originalSrc ||
      value?.featuredImage?.url ||
      value?.featuredImage?.src ||
      value?.images?.[0]?.url ||
      value?.images?.[0]?.src ||
      value?.images?.edges?.[0]?.node?.url ||
      '',
  );
}

function extractPrice(value: any): string {
  return String(value?.price?.amount || value?.price || '');
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

  const variantOptions: VariantOption[] =
    productsJson?.data?.products?.edges?.flatMap((edge: any) => {
      const productTitle = edge?.node?.title ?? 'Product';
      return (edge?.node?.variants?.edges ?? []).map((variantEdge: any) => {
        const variant = variantEdge?.node;
        return {
          value: String(variant?.legacyResourceId ?? gidToLegacyId(String(variant?.id || ''))),
          gid: String(variant?.id || ''),
          label: `${productTitle} - ${variant?.title || 'Default'}`,
          image: extractImageUrl({
            image: variant?.image,
            featuredImage: edge?.node?.featuredImage,
            images: edge?.node?.images,
          }),
          price: extractPrice(variant),
          available: Boolean(variant?.availableForSale ?? true),
        };
      });
    }) ?? [];

  return {
    settings: toFormSettings(settings),
    variantOptions,
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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
      giftVariantId: String(tier.giftVariantId || '0'),
      giftVariantGid: String(tier.giftVariantGid || ''),
      giftTitle: String(tier.giftTitle || tier.rewardLabel || `Tier ${index + 1} Gift`),
      giftImageUrl: String(tier.giftImageUrl || ''),
      giftPrice: String(tier.giftPrice || ''),
    }));

  if (tiers.length !== 4) {
    return { ok: false, error: 'Exactly 4 tiers are required' } satisfies ActionData;
  }

  await saveSlidecartSettings(session.shop, {
    enabled: Boolean(payload.enabled),
    cartTitle: String(payload.cartTitle || 'Your Cart'),
    customText: String(payload.customText || ''),
    progressIntro: String(payload.progressIntro || "You're only [amount] away from getting [reward] for free!"),
    discountCtaNote: String(payload.discountCtaNote || 'Add discount code at checkout'),
    maxFreeGifts: 1,
    buttonFillColor: String(payload.buttonFillColor || '#000000'),
    buttonTextColor: String(payload.buttonTextColor || '#FFFFFF'),
    panelBackground: String(payload.panelBackground || '#f3f3f3'),
    tiers,
  });

  return { ok: true } satisfies ActionData;
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
    }
    if (fetcher.data && !fetcher.data.ok && fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  useEffect(() => {
    setForm((current) => {
      let changed = false;
      const tiers = current.tiers.map((tier) => {
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

              <div className={styles.pickerRow}>
                <s-button onClick={() => pickTierGift(index)}>Search & select gift in Shopify</s-button>
                <span className={styles.quickLabel}>or quick select:</span>
                <s-select
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
