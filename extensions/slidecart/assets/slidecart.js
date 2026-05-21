(() => {
  if (window.__awcSlidecartInitialized) return;

  const ROOT_ID = 'awc-slidecart-root';
  const FREE_GIFT_PROP = '_awc_free_gift';
  const REWARD_CHOICE_ATTR = '_awc_reward_choice';
  const SHIPPING_REWARD_PREFIX = 'shipping:';
  const DEBUG_MODE = new URLSearchParams(window.location.search).has('awc_debug');
  let cartOpQueue = Promise.resolve();
  let internalCartMutationDepth = 0;
  let optimisticMutationId = 0;
  let latestRenderedCart = null;
  let pendingRewardChoice = '';
  const debugState = [];
  let lastGiftError = '';
  const soldOutGiftVariantIds = new Set();
  let giftRateLimitUntil = 0;
  let lastUnlockedTierId = null;
  let lastFocusedBeforeOpen = null;
  let linesCollapsed = true;
  let suppressThemeCartUntil = 0;
  let suppressThemeCartTimer = null;
  const THEME_CART_SELECTORS = [
    'cart-drawer',
    '.cart-drawer',
    '#CartDrawer',
    '[id*="CartDrawer"]',
    '.ajaxcart',
    '.mini-cart',
    '.cart-sidebar',
    '.drawer--right',
    '.js-drawer-open-cart',
  ];

  function money(cents, currency) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format((cents || 0) / 100);
  }

  function debugLog(message, data = undefined) {
    if (!DEBUG_MODE) return;
    const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
    const line = `[awc] ${message}${suffix}`;
    debugState.push(line);
    if (debugState.length > 14) debugState.shift();
    console.log(line);
    const el = document.getElementById('awc-op-debug');
    if (el) {
      el.textContent = debugState.join('\n');
    }
  }

  function getSettings(root) {
    const tiers = [1, 2, 3, 4].map((i) => ({
      id: `tier-${i}`,
      rewardType: 'gift',
      requiredSubtotalCents: Number(root.dataset[`tier${i}Threshold`] || root.getAttribute(`data-tier-${i}-threshold`) || 0),
      rewardLabel: root.dataset[`tier${i}Label`] || root.getAttribute(`data-tier-${i}-label`) || `Tier ${i}`,
      gift: {
        variantId: Number(root.dataset[`tier${i}VariantId`] || root.getAttribute(`data-tier-${i}-variant-id`) || 0),
        title: root.dataset[`tier${i}Label`] || root.getAttribute(`data-tier-${i}-label`) || `Tier ${i} gift`
      }
    })).filter((t) => t.requiredSubtotalCents > 0);

    tiers.sort((a, b) => a.requiredSubtotalCents - b.requiredSubtotalCents);

    return {
      proxyPath: root.dataset.proxyPath || '/apps/awc-slidecart',
      appOrigin: root.dataset.appOrigin || 'https://alywillowsc.vercel.app',
      cartTitle: root.dataset.cartTitle || 'Your Cart',
      customText: root.dataset.customText || '',
      progressIntro: root.dataset.progressIntro || "You're only {{amount}} away from getting a {{reward}} for free!",
      giftChooserText: root.dataset.giftChooserText || 'Choose reward:',
      discountCtaNote: 'Add discount code at checkout',
      enabled: true,
      buttonFillColor: '#000000',
      buttonTextColor: '#ffffff',
      panelBackground: '#f3f3f3',
      currency: root.dataset.currency || 'USD',
      tiers
    };
  }

  async function getProxyConfig(proxyPath, appOrigin) {
    const shopParam = encodeURIComponent(String(window.Shopify?.shop || ''));
    const basePaths = [proxyPath, '/apps/awc-slidecart', '/apps/slidecart'];
    const directUrl = shopParam
      ? `${String(appOrigin || 'https://alywillowsc.vercel.app').replace(/\/$/, '')}/public/slidecart-config?shop=${shopParam}`
      : '';
    const paths = [...new Set([...basePaths.flatMap((path) => {
      if (!path) return [];
      const withShop = shopParam
        ? `${path}${path.includes('?') ? '&' : '?'}shop=${shopParam}`
        : path;
      return [path, withShop];
    }), directUrl])];

    for (const path of paths) {
      try {
        const res = await fetch(path, { credentials: 'same-origin' });
        if (!res.ok) continue;
        const raw = await res.text();
        if (!raw) continue;
        const json = JSON.parse(raw);
        if (json && typeof json === 'object') return json;
      } catch {
        // Keep trying fallback proxy paths.
      }
    }
    return null;
  }

  async function cartGet() {
    const res = await fetch('/cart.js');
    if (!res.ok) throw new Error('Failed to load cart');
    return res.json();
  }

  async function cartChangeById(idOrKey, quantity) {
    return withInternalCartMutation(async () => {
      const res = await fetch('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: idOrKey, quantity })
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      return { ok: res.ok, status: res.status, data: json };
    });
  }

  async function cartChangeByLine(line, quantity) {
    return withInternalCartMutation(async () => {
      const res = await fetch('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line, quantity })
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      return { ok: res.ok, status: res.status, data: json };
    });
  }

  async function cartAddGift(variantId) {
    return withInternalCartMutation(async () => {
      const res = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            id: Number(variantId),
            quantity: 1,
            properties: { [FREE_GIFT_PROP]: '1' }
          }]
        })
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : 0;
      return { ok: res.ok, status: res.status, data: json, retryAfterSeconds };
    });
  }

  async function cartUpdateAttributes(attributes) {
    return withInternalCartMutation(async () => {
      const res = await fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attributes })
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      return { ok: res.ok, status: res.status, data: json };
    });
  }

  async function withInternalCartMutation(fn) {
    internalCartMutationDepth += 1;
    try {
      return await fn();
    } finally {
      internalCartMutationDepth = Math.max(0, internalCartMutationDepth - 1);
    }
  }

  function isCartPayload(value) {
    return Boolean(value && typeof value === 'object' && Array.isArray(value.items));
  }

  function cloneCart(cart) {
    if (!isCartPayload(cart)) return null;
    try {
      return JSON.parse(JSON.stringify(cart));
    } catch {
      return null;
    }
  }

  function numericCents(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
  }

  function unitCents(item, lineField, unitField) {
    const unitValue = numericCents(item?.[unitField]);
    if (unitValue > 0) return unitValue;
    const qty = Math.max(1, numericCents(item?.quantity));
    return Math.round(numericCents(item?.[lineField]) / qty);
  }

  function cartLevelDiscountCents(cart) {
    return (cart?.cart_level_discount_applications || []).reduce((acc, discount) => {
      return acc + numericCents(discount?.total_allocated_amount);
    }, 0);
  }

  function recalculateCartTotals(cart) {
    if (!isCartPayload(cart)) return cart;

    const totals = cart.items.reduce((acc, item) => {
      acc.itemCount += numericCents(item.quantity);
      acc.original += numericCents(item.original_line_price || item.line_price || item.final_line_price);
      acc.final += numericCents(item.final_line_price || item.line_price || item.original_line_price);
      return acc;
    }, { itemCount: 0, original: 0, final: 0 });

    const cartDiscount = cartLevelDiscountCents(cart);
    cart.item_count = totals.itemCount;
    cart.items_subtotal_price = totals.original;
    cart.original_total_price = totals.original;
    cart.total_price = Math.max(0, totals.final - cartDiscount);
    cart.total_discount = Math.max(0, totals.original - cart.total_price);
    return cart;
  }

  function projectCartLineQuantity(cart, line, quantity) {
    const nextCart = cloneCart(cart);
    const index = Number(line) - 1;
    const nextQty = Math.max(0, numericCents(quantity));
    if (!nextCart || index < 0 || index >= nextCart.items.length) return null;

    if (nextQty <= 0) {
      nextCart.items.splice(index, 1);
      return recalculateCartTotals(nextCart);
    }

    const item = nextCart.items[index];
    const originalUnit = unitCents(item, 'original_line_price', 'original_price');
    const finalUnit = unitCents(item, 'final_line_price', 'final_price');
    const lineUnit = unitCents(item, 'line_price', 'price');

    item.quantity = nextQty;
    item.original_line_price = originalUnit * nextQty;
    item.final_line_price = finalUnit * nextQty;
    item.line_price = lineUnit * nextQty;
    return recalculateCartTotals(nextCart);
  }

  function setProjectedCartAttribute(cart, key, value) {
    if (!isCartPayload(cart)) return cart;
    if (!cart.attributes || Array.isArray(cart.attributes)) {
      const attrs = Array.isArray(cart.attributes) ? [...cart.attributes] : [];
      const existing = attrs.find((attr) => attr?.key === key);
      if (existing) {
        existing.value = value;
      } else {
        attrs.push({ key, value });
      }
      cart.attributes = attrs;
      return cart;
    }
    cart.attributes = { ...cart.attributes, [key]: value };
    return cart;
  }

  function projectCartRewardChoice(cart, choice, removeGiftLines = false) {
    const nextCart = cloneCart(cart);
    if (!nextCart) return null;
    setProjectedCartAttribute(nextCart, REWARD_CHOICE_ATTR, choice);
    if (removeGiftLines) {
      nextCart.items = nextCart.items.filter((item) => !isGift(item));
    }
    return recalculateCartTotals(nextCart);
  }

  function projectCartGiftSelection(settings, cart, variantId) {
    const nextCart = projectCartRewardChoice(cart, `gift:${variantId}`, false);
    if (!nextCart) return null;

    nextCart.items = nextCart.items.filter((item) => !isGift(item));

    const tier = (settings.tiers || []).find((candidate) => {
      return Number(candidate?.gift?.variantId) === Number(variantId);
    });
    const title = tier?.gift?.title || tier?.rewardLabel || 'Free gift';
    const parts = splitGiftLabel(title);

    nextCart.items.unshift({
      key: `awc-gift-${variantId}`,
      id: Number(variantId),
      variant_id: Number(variantId),
      quantity: 1,
      product_title: parts.title || title,
      variant_title: parts.variant || '',
      image: tier?.gift?.image || '',
      properties: { [FREE_GIFT_PROP]: '1' },
      original_price: 0,
      final_price: 0,
      price: 0,
      original_line_price: 0,
      final_line_price: 0,
      line_price: 0,
    });

    return recalculateCartTotals(nextCart);
  }

  function renderOptimisticCart(settings, cart) {
    optimisticMutationId += 1;
    render(settings, cart, { optimistic: true });
    return optimisticMutationId;
  }

  function shouldRenderMutationResult(mutationId) {
    return mutationId === optimisticMutationId;
  }

  function getProgress(subtotal, tiers) {
    let unlocked = null;
    let next = null;

    for (const tier of tiers) {
      if (subtotal >= tier.requiredSubtotalCents) {
        unlocked = tier;
      } else {
        next = tier;
        break;
      }
    }

    const remaining = next ? Math.max(0, next.requiredSubtotalCents - subtotal) : 0;
    return { unlocked, next, remaining };
  }

  function progressText(settings, progress) {
    if (!settings.tiers?.length) return 'Add items to start building your cart.';
    if (!progress.next && progress.unlocked) return 'All free gift tiers unlocked. Choose your favorite free gift.';
    if (!progress.next) return 'All free gifts unlocked.';
    return formatTemplate(
      settings.progressIntro || 'Add [amount] to unlock [reward].',
      {
        amount: money(progress.remaining, settings.currency),
        reward: progress.next.rewardLabel,
      },
    );
  }

  function lineDiscount(item) {
    const compare = item.original_line_price || item.final_line_price;
    const final = item.final_line_price || compare;
    return Math.max(0, compare - final);
  }

  function isGift(item) {
    return item?.properties?.[FREE_GIFT_PROP] === '1';
  }

  function isFreeShippingTier(tier) {
    return tier?.rewardType === 'free_shipping';
  }

  function getCartAttribute(cart, key) {
    const attrs = cart?.attributes;
    if (!attrs) return '';
    if (Array.isArray(attrs)) {
      const pair = attrs.find((attr) => attr?.key === key);
      return pair?.value || '';
    }
    return attrs[key] || '';
  }

  function getSelectedShippingTierId(cart) {
    const choice = String(getCartAttribute(cart, REWARD_CHOICE_ATTR) || '');
    return choice.startsWith(SHIPPING_REWARD_PREFIX)
      ? choice.slice(SHIPPING_REWARD_PREFIX.length)
      : '';
  }

  function getGiftRewardVariantId(choice) {
    const prefix = 'gift:';
    return String(choice || '').startsWith(prefix)
      ? Number(String(choice).slice(prefix.length))
      : 0;
  }

  function shippingIconMarkup(className = 'awc-shipping-icon') {
    return `
      <svg class="${className}" aria-hidden="true" viewBox="0 0 24 24" focusable="false">
        <path d="M3 6.5h11v10H3z"></path>
        <path d="M14 10h3.4l2.6 3.2v3.3h-6z"></path>
        <circle cx="7" cy="18" r="1.8"></circle>
        <circle cx="17" cy="18" r="1.8"></circle>
      </svg>
    `;
  }

  function tierPercent(subtotal, tiers) {
    if (!tiers.length) return 0;
    const maxRaw = Number(tiers[tiers.length - 1]?.requiredSubtotalCents);
    const subtotalRaw = Number(subtotal || 0);

    if (!Number.isFinite(maxRaw) || maxRaw <= 0) return 0;
    if (!Number.isFinite(subtotalRaw) || subtotalRaw <= 0) return 0;

    const pct = (subtotalRaw / maxRaw) * 100;
    if (!Number.isFinite(pct)) return 0;
    return Math.max(0, Math.min(100, pct));
  }

  function buildTierMilestones(settings, subtotal, justUnlockedTierId) {
    const count = settings.tiers.length || 1;
    return settings.tiers.map((tier) => {
      const active = subtotal >= tier.requiredSubtotalCents;
      // Center marker under each segment for cleaner visual distribution.
      const segmentIndex = Number(tier.id?.split('-')?.[1] || 1) - 1;
      const leftPct = ((segmentIndex + 0.5) / count) * 100;
      const image = isFreeShippingTier(tier)
        ? shippingIconMarkup('awc-tier-shipping-icon')
        : tier?.gift?.image
        ? `<img src="${escapeHtml(tier.gift.image)}" alt="${escapeHtml(tier.rewardLabel)}" />`
        : `<span class="awc-tier-fallback">${escapeHtml((tier.rewardLabel || '?').charAt(0))}</span>`;
      return `
        <div class="awc-tier-stop ${isFreeShippingTier(tier) ? 'is-shipping' : ''} ${active ? 'active' : ''} ${tier.id === justUnlockedTierId ? 'just-unlocked' : ''}" style="left:${leftPct}%;">
          <div class="awc-tier-amount">${money(tier.requiredSubtotalCents, settings.currency)}</div>
          <div class="awc-tier-thumb">${image}</div>
          ${tier.id === justUnlockedTierId ? '<div class="awc-unlock-check" aria-hidden="true">✓</div>' : ''}
          <div class="awc-tier-name">${escapeHtml(tier.rewardLabel || '')}</div>
        </div>
      `;
    }).join('');
  }

  function renderSegmentedTrack(trackEl, subtotal, tiers, debug) {
    if (!(trackEl instanceof HTMLElement) || !tiers.length) {
      if (trackEl instanceof HTMLElement) {
        trackEl.innerHTML = '';
      }
      return;
    }

    // Build once, then only update widths so CSS transition can animate smoothly.
    const existingFills = trackEl.querySelectorAll('.awc-seg-fill');
    if (existingFills.length !== tiers.length) {
      trackEl.innerHTML = tiers
        .map(
          () => `
            <span class="awc-seg">
              <span class="awc-seg-fill"></span>
            </span>
          `,
        )
        .join('');
    }

    const fills = trackEl.querySelectorAll('.awc-seg-fill');
    const subtotalRaw = Number(subtotal || 0);
    const safeSubtotal = Number.isFinite(subtotalRaw) ? subtotalRaw : 0;

    tiers.forEach((tier, index) => {
      const segFill = fills[index];
      if (!(segFill instanceof HTMLElement)) return;

      const start = index === 0 ? 0 : Number(tiers[index - 1].requiredSubtotalCents || 0);
      const end = Number(tier.requiredSubtotalCents || 0);
      const span = Math.max(1, end - start);
      const filledPct = Math.max(0, Math.min(100, ((safeSubtotal - start) / span) * 100));

      segFill.style.background = debug ? '#00c853' : 'linear-gradient(90deg, #111 0%, #232323 100%)';
      requestAnimationFrame(() => {
        segFill.style.width = `${filledPct}%`;
      });
    });
  }

  function escapeHtml(input) {
    return String(input || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatTemplate(template, values) {
    return String(template || '')
      .replace(/\[amount\]|\{\{\s*amount\s*\}\}/g, values.amount || '')
      .replace(/\[reward\]|\{\{\s*reward\s*\}\}/g, values.reward || '');
  }

  function cleanVariantLabel(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return '';
    if (normalized.toLowerCase() === 'default title') return '';
    return normalized;
  }

  function splitGiftLabel(label) {
    const raw = String(label || '');
    const idx = raw.lastIndexOf(' - ');
    if (idx <= 0) return { title: raw, variant: '' };
    const variant = cleanVariantLabel(raw.slice(idx + 3).trim());
    return {
      title: raw.slice(0, idx).trim(),
      variant,
    };
  }

  function giftFallbackLabel(label) {
    const normalized = String(label || '').trim();
    return (normalized.charAt(0) || '?').toUpperCase();
  }

  function buildShell() {
    if (document.getElementById('awc-slidecart')) return;

    const overlay = document.createElement('div');
    overlay.id = 'awc-slidecart-overlay';
    overlay.addEventListener('click', closeDrawer);

    const drawer = document.createElement('aside');
    drawer.id = 'awc-slidecart';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-labelledby', 'awc-cart-title');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.innerHTML = `
      <div class="awc-head" id="awc-head">
        <h2 id="awc-cart-title">Your Cart</h2>
        <button class="awc-close" aria-label="Close">×</button>
      </div>
      <div class="awc-progress">
        <div id="awc-progress-text" role="status" aria-live="polite"></div>
        <div class="awc-progress-track"><div id="awc-progress-fill" class="awc-progress-fill"></div></div>
        <div id="awc-tier-row" class="awc-tier-row"></div>
        <div id="awc-progress-debug" style="display:none;font-size:12px;margin-top:6px;color:#444;"></div>
      </div>
      <div id="awc-lines" class="awc-lines"></div>
      <div class="awc-foot">
        <div id="awc-sticky-hint" class="awc-sticky-hint" role="status" aria-live="polite"></div>
        <div id="awc-subtotal"></div>
        <div class="awc-confidence" aria-label="Checkout confidence">
          <span>Secure checkout</span>
          <span>Easy returns</span>
          <span>Fast shipping</span>
        </div>
        <button id="awc-checkout" class="awc-checkout">Checkout</button>
        <div id="awc-discount-note" class="awc-discount-note"></div>
      </div>
      <pre id="awc-op-debug" style="display:none;white-space:pre-wrap;margin:8px 12px;padding:8px;background:#fff;border:1px solid #ddd;border-radius:8px;font-size:11px;max-height:140px;overflow:auto;"></pre>
    `;

    drawer.querySelector('.awc-close')?.addEventListener('click', closeDrawer);
    drawer.querySelector('#awc-checkout')?.addEventListener('click', () => {
      window.location.href = '/checkout';
    });

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);
  }

  function openDrawer() {
    const drawer = document.getElementById('awc-slidecart');
    const overlay = document.getElementById('awc-slidecart-overlay');
    if (!drawer || !overlay) return;
    lastFocusedBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeThemeCartUIs();
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    overlay.style.display = 'block';
    const closeBtn = drawer.querySelector('.awc-close');
    if (closeBtn instanceof HTMLElement) closeBtn.focus();
  }

  function closeDrawer() {
    const drawer = document.getElementById('awc-slidecart');
    const overlay = document.getElementById('awc-slidecart-overlay');
    if (!drawer || !overlay) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    overlay.style.display = 'none';
    if (lastFocusedBeforeOpen) {
      lastFocusedBeforeOpen.focus();
    }
  }

  function trapFocusInDrawer(event) {
    const drawer = document.getElementById('awc-slidecart');
    if (!(drawer instanceof HTMLElement) || !drawer.classList.contains('open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = drawer.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const focusables = [...nodes].filter((node) => node instanceof HTMLElement && !node.hasAttribute('disabled'));
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function closeThemeCartUIs() {
    THEME_CART_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        if (!(el instanceof HTMLElement)) return;
        el.classList.remove('open', 'is-open', 'active', 'drawer--active', 'cart-drawer--active');
        el.setAttribute('aria-hidden', 'true');
        if (el.hasAttribute('open')) el.removeAttribute('open');
        if (el instanceof HTMLDialogElement) el.close();
      });
    });
    document.documentElement.classList.remove('overflow-hidden');
    document.body.classList.remove('overflow-hidden', 'js-drawer-open', 'cart-open');
  }

  function suppressThemeCartFor(ms = 1800) {
    suppressThemeCartUntil = Math.max(suppressThemeCartUntil, Date.now() + ms);
    closeThemeCartUIs();
    if (suppressThemeCartTimer) return;
    suppressThemeCartTimer = window.setInterval(() => {
      if (Date.now() >= suppressThemeCartUntil) {
        window.clearInterval(suppressThemeCartTimer);
        suppressThemeCartTimer = null;
        return;
      }
      closeThemeCartUIs();
    }, 90);
  }

  function haltEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
  }

  function nodeListHasCartTrigger(nodes) {
    return nodes.some((node) => {
      if (!(node instanceof Element)) return false;
      if (node.matches?.('#cart-icon-bubble, .header__icon--cart, [data-cart-icon], .site-header__cart, [data-cart-toggle], [data-drawer-toggle=\"cart\"], [aria-controls*=\"cart\" i]')) {
        return true;
      }
      if (node instanceof HTMLAnchorElement && typeof node.href === 'string' && /\/cart(\?|#|$)/.test(node.href)) {
        return true;
      }
      return false;
    });
  }

  function isCartIntentEvent(event) {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    if (target.closest('#awc-slidecart, #awc-slidecart-overlay')) return false;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];

    const cartAnchor = target.closest('a[href*="/cart"]');
    const cartButton = target.closest(
      '#cart-icon-bubble, .header__icon--cart, [data-cart-icon], .site-header__cart, [data-cart-toggle], [data-drawer-toggle="cart"]',
    );
    const ariaCart = target.closest('[aria-label*="cart" i], [title*="cart" i]');

    return Boolean(cartAnchor || cartButton || ariaCart || nodeListHasCartTrigger(path));
  }

  function bindCartTriggers(reload) {
    document.addEventListener('click', async (event) => {
      if (isCartIntentEvent(event)) {
        haltEvent(event);
        suppressThemeCartFor();
        await reload();
        openDrawer();
      }
    }, true);

    document.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (!isCartIntentEvent(event)) return;
      haltEvent(event);
      suppressThemeCartFor();
      await reload();
      openDrawer();
    }, true);

    document.addEventListener('submit', async (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (!form.action.includes('/cart/add')) return;
      suppressThemeCartFor();

      // Do not manually add-to-cart here; themes/apps may already do AJAX add.
      // We only sync UI after the theme finishes cart mutation.
      setTimeout(async () => {
        await reload();
        openDrawer();
      }, 450);
    }, true);
  }

  function bindHeaderCartIconTrigger(reload) {
    const cartIcon = document.querySelector('#cart-icon-bubble');
    if (!(cartIcon instanceof HTMLElement)) return;
    if (cartIcon.dataset.awcBound === '1') return;
    cartIcon.dataset.awcBound = '1';

    cartIcon.addEventListener('click', async (event) => {
      haltEvent(event);
      suppressThemeCartFor();
      await reload();
      openDrawer();
    }, true);

    cartIcon.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      haltEvent(event);
      suppressThemeCartFor();
      await reload();
      openDrawer();
    }, true);
  }

  function patchNetworkCartListeners(reload) {
    if (!window.fetch || window.__awcFetchPatched) return;
    window.__awcFetchPatched = true;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const input = args[0];
      const url = typeof input === 'string'
        ? input
        : (input && typeof input.url === 'string' ? input.url : '');
      const isCartMutation = typeof url === 'string' && /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/.test(url);
      const shouldSync = isCartMutation && internalCartMutationDepth === 0;
      if (shouldSync && /\/cart\/add(\.js)?(\?|$)/.test(url)) suppressThemeCartFor();
      const response = await nativeFetch(...args);
      if (shouldSync) {
        setTimeout(async () => {
          await reload();
          if (/\/cart\/add(\.js)?(\?|$)/.test(url)) openDrawer();
        }, 120);
      }
      return response;
    };

    if (!window.XMLHttpRequest || window.__awcXhrPatched) return;
    window.__awcXhrPatched = true;
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__awcCartMutationUrl = typeof url === 'string' && /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/.test(url)
        ? url
        : '';
      return nativeOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...sendArgs) {
      if (this.__awcCartMutationUrl) {
        if (/\/cart\/add(\.js)?(\?|$)/.test(this.__awcCartMutationUrl)) suppressThemeCartFor();
        this.addEventListener('loadend', () => {
          setTimeout(async () => {
            await reload();
            if (/\/cart\/add(\.js)?(\?|$)/.test(this.__awcCartMutationUrl)) openDrawer();
          }, 120);
        }, { once: true });
      }
      return nativeSend.apply(this, sendArgs);
    };
  }

  async function runCartOp(fn) {
    cartOpQueue = cartOpQueue
      .then(() => fn())
      .catch((error) => {
        console.error('Slidecart cart op failed', error);
      });
    return cartOpQueue;
  }

  async function enforceOneGift(cart) {
    const gifts = cart.items.filter(isGift);
    if (gifts.length <= 1) return false;
    let didChange = false;
    for (let i = 1; i < gifts.length; i += 1) {
      await cartChangeById(gifts[i].key, 0);
      didChange = true;
    }
    return didChange;
  }

  function buildGiftButtons(settings, subtotal, selectedGift, selectedShippingTierId) {
    const eligibleGifts = settings.tiers.filter((tier) => {
      return !isFreeShippingTier(tier)
        && subtotal >= tier.requiredSubtotalCents
        && Number(tier?.gift?.variantId) > 0;
    });
    const eligibleShipping = settings.tiers.filter((tier) => {
      return isFreeShippingTier(tier) && subtotal >= tier.requiredSubtotalCents;
    });
    if (!eligibleGifts.length && !eligibleShipping.length) return '';
    const orderedGifts = eligibleGifts.sort((a, b) => {
      if (Number(a.gift.variantId) === selectedGift) return -1;
      if (Number(b.gift.variantId) === selectedGift) return 1;
      return 0;
    });
    const orderedShipping = eligibleShipping.sort((a, b) => {
      if (a.id === selectedShippingTierId) return -1;
      if (b.id === selectedShippingTierId) return 1;
      return Number(b.requiredSubtotalCents || 0) - Number(a.requiredSubtotalCents || 0);
    });

    return `
      <div class="awc-gifts">
        <strong>${escapeHtml(settings.giftChooserText || 'Choose reward:')}</strong>
        ${lastGiftError ? `<div class="awc-gift-error">${escapeHtml(lastGiftError)}</div>` : ''}
        <div class="awc-gift-row-wrapper">
          <button type="button" class="awc-gift-scroll-btn awc-gift-scroll-left" aria-label="Scroll left">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
          </button>
          <div class="awc-gift-row">
          ${orderedShipping.map((tier) => `
            <button
              class="awc-gift-btn awc-shipping-btn ${selectedShippingTierId === tier.id ? 'is-selected' : ''}"
              data-shipping-tier-id="${escapeHtml(tier.id)}"
            >
              ${shippingIconMarkup('awc-gift-shipping-icon')}
              <span class="awc-gift-text">
                <span class="awc-gift-title">${escapeHtml(tier.rewardLabel || 'Free shipping')}</span>
                <span class="awc-gift-variant">${selectedShippingTierId === tier.id ? 'Selected' : 'Free shipping'}</span>
              </span>
            </button>
          `).join('')}
          ${orderedGifts.map((tier) => `
            ${(() => {
              const parts = splitGiftLabel(tier.gift.title);
              return `
            <button
              class="awc-gift-btn ${selectedGift === tier.gift.variantId ? 'is-selected' : ''} ${soldOutGiftVariantIds.has(Number(tier.gift.variantId)) ? 'is-soldout' : ''}"
              data-gift-variant-id="${tier.gift.variantId}"
              ${soldOutGiftVariantIds.has(Number(tier.gift.variantId)) || Date.now() < giftRateLimitUntil ? 'disabled aria-disabled="true"' : ''}
            >
              ${tier?.gift?.image
                ? `<img src="${escapeHtml(tier.gift.image)}" alt="${escapeHtml(tier.gift.title)}" />`
                : `<span class="awc-gift-img-fallback" aria-hidden="true">${escapeHtml(giftFallbackLabel(parts.title || tier.gift.title))}</span>`}
              <span class="awc-gift-text">
                <span class="awc-gift-title">${escapeHtml(parts.title || tier.gift.title)}</span>
                ${parts.variant ? `<span class="awc-gift-variant">${escapeHtml(parts.variant)}</span>` : ''}
              </span>
              ${soldOutGiftVariantIds.has(Number(tier.gift.variantId)) ? '<em class="awc-chip-flag">Sold out</em>' : ''}
            </button>
            `;
            })()}
          `).join('')}
          </div>
          <button type="button" class="awc-gift-scroll-btn awc-gift-scroll-right" aria-label="Scroll right">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </button>
        </div>
      </div>
    `;
  }

  function buildFreeShippingStatus(settings, subtotal) {
    const shippingTiers = settings.tiers.filter(isFreeShippingTier);
    if (!shippingTiers.length) return '';

    const unlocked = shippingTiers
      .filter((tier) => subtotal >= tier.requiredSubtotalCents)
      .sort((a, b) => b.requiredSubtotalCents - a.requiredSubtotalCents)[0];
    const next = shippingTiers
      .filter((tier) => subtotal < tier.requiredSubtotalCents)
      .sort((a, b) => a.requiredSubtotalCents - b.requiredSubtotalCents)[0];

    if (unlocked) return '';

    if (!next) return '';

    return `
      <div class="awc-shipping-reward">
        ${shippingIconMarkup()}
        <span>${money(next.requiredSubtotalCents - subtotal, settings.currency)} away from ${escapeHtml(next.rewardLabel || 'free shipping')}</span>
      </div>
    `;
  }

  function hasEligibleGiftOptions(settings, subtotal) {
    return settings.tiers.some((tier) => {
      return !isFreeShippingTier(tier)
        && subtotal >= tier.requiredSubtotalCents
        && Number(tier?.gift?.variantId) > 0;
    });
  }

  async function render(settings, cartOverride = null, options = {}) {
    let currentCart = isCartPayload(cartOverride) ? cartOverride : await cartGet();
    if (!options.optimistic) {
      const changedGiftLines = await enforceOneGift(currentCart);
      if (changedGiftLines) {
        currentCart = await cartGet();
      }
    }
    latestRenderedCart = currentCart;

    const title = document.getElementById('awc-cart-title');
    if (title) title.textContent = `${settings.cartTitle} ${currentCart.item_count || 0}`;

    const subtotal = Number(currentCart.items_subtotal_price || 0);
    const progress = getProgress(subtotal, settings.tiers);
    const justUnlockedTierId =
      progress.unlocked?.id && progress.unlocked.id !== lastUnlockedTierId
        ? progress.unlocked.id
        : null;
    lastUnlockedTierId = progress.unlocked?.id || null;

    const progressTextEl = document.getElementById('awc-progress-text');
    if (progressTextEl) progressTextEl.textContent = progressText(settings, progress);

    const fill = document.getElementById('awc-progress-fill');
    const track = document.querySelector('.awc-progress-track');
    const pct = tierPercent(subtotal, settings.tiers);
    if (fill) {
      fill.style.width = `${pct}%`;
      fill.style.background = DEBUG_MODE ? '#00c853' : 'linear-gradient(90deg, #111 0%, #232323 100%)';
      if (pct > 0) {
        fill.style.minWidth = '3px';
      } else {
        fill.style.minWidth = '0';
      }
      fill.style.boxShadow = DEBUG_MODE ? '0 0 0 1px #007a35 inset' : 'none';
    }
    renderSegmentedTrack(track, subtotal, settings.tiers, DEBUG_MODE);

      if (DEBUG_MODE) {
        const max = Number(settings.tiers?.[settings.tiers.length - 1]?.requiredSubtotalCents || 0);
        const debugEl = document.getElementById('awc-progress-debug');
        if (debugEl) {
          debugEl.style.display = 'block';
          debugEl.textContent = `debug subtotal=${subtotal} max=${max} pct=${pct.toFixed(2)} width=${pct.toFixed(1)}% tiers=${settings.tiers.length}`;
        }
        const opDebug = document.getElementById('awc-op-debug');
        if (opDebug) {
          opDebug.style.display = 'block';
        }
      }

    const tierRow = document.getElementById('awc-tier-row');
    if (tierRow) {
      tierRow.innerHTML = buildTierMilestones(settings, subtotal, justUnlockedTierId);
    }

    const giftLine = currentCart.items.find(isGift);
    const pendingGiftVariantId = getGiftRewardVariantId(pendingRewardChoice);
    const selectedGiftVariantId = pendingGiftVariantId || (giftLine ? Number(giftLine.variant_id) : 0);
    const selectedShippingTierId = pendingRewardChoice.startsWith(SHIPPING_REWARD_PREFIX)
      ? pendingRewardChoice.slice(SHIPPING_REWARD_PREFIX.length)
      : giftLine
      ? ''
      : getSelectedShippingTierId(currentCart);

    const lines = document.getElementById('awc-lines');
    if (lines) {
      if (Date.now() < giftRateLimitUntil) {
        const secondsLeft = Math.max(1, Math.ceil((giftRateLimitUntil - Date.now()) / 1000));
        lastGiftError = `Too many attempts. Try again in ${secondsLeft}s.`;
      }
      const shippingStatus = buildFreeShippingStatus(settings, subtotal);
      const giftButtons = buildGiftButtons(settings, subtotal, selectedGiftVariantId, selectedShippingTierId);
      const customText = hasEligibleGiftOptions(settings, subtotal) && settings.customText
        ? `<div class="awc-custom">${escapeHtml(settings.customText)}</div>`
        : '';
      lines.innerHTML = `
        ${shippingStatus}
        ${giftButtons}
        ${currentCart.items.length === 0 ? `
          <div class="awc-empty">
            <p>Your cart is empty.</p>
            <a href="/collections/all" class="awc-empty-link">Continue shopping</a>
          </div>
        ` : ''}
        ${(() => {
          const maxVisible = 3;
          const shouldCollapse = currentCart.items.length > maxVisible;
          const visibleItems = shouldCollapse && linesCollapsed
            ? currentCart.items.slice(0, maxVisible)
            : currentCart.items;
          return visibleItems.map((item) => {
          const discount = lineDiscount(item);
          const lineNumber = (currentCart.items || []).findIndex((it) => it.key === item.key) + 1;
          const linePrice = isGift(item) ? '' : money(item.final_line_price, settings.currency);
          const variantLabel = cleanVariantLabel(item.variant_title || '');
          const giftBadge = isGift(item)
            ? `
              <span class="awc-gift-badge" aria-label="Free gift">
                <span class="awc-gift-badge-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="12" height="12" focusable="false" aria-hidden="true">
                    <path fill="currentColor" d="M20 7h-2.2a2.8 2.8 0 0 0 .2-1c0-1.66-1.34-3-3-3-1.23 0-2.3.75-2.76 1.82A2.99 2.99 0 0 0 9.5 3C7.84 3 6.5 4.34 6.5 6c0 .35.06.69.17 1H4a1 1 0 0 0-1 1v3c0 .55.45 1 1 1h1v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7h1a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1Zm-5-2a1 1 0 1 1 0 2h-2V6a1 1 0 0 1 2-1Zm-6.5 1a1 1 0 0 1 2 0v1h-2a1 1 0 0 1 0-2ZM5 9h6v2H5V9Zm2 4h4v6H7v-6Zm10 6h-4v-6h4v6Zm2-8h-6V9h6v2Z"/>
                  </svg>
                </span>
                Free gift
              </span>
            `
            : '';
          return `
            <div class="awc-line">
              <img src="${escapeHtml(item.image || '')}" alt="${escapeHtml(item.product_title)}" />
              <div class="awc-line-main">
                <div class="awc-line-title-row">
                  <div class="awc-line-title">${escapeHtml(item.product_title)}</div>
                  ${giftBadge}
                </div>
                ${variantLabel ? `<div class="awc-line-meta">${escapeHtml(variantLabel)}</div>` : ''}
                <div class="awc-qty" data-line="${lineNumber}" data-line-key="${escapeHtml(item.key || '')}" data-qty="${item.quantity}">
                  <button type="button" data-qty-delta="-1" aria-label="Decrease quantity">-</button>
                  <span>${item.quantity}</span>
                  <button type="button" data-qty-delta="1" aria-label="Increase quantity">+</button>
                </div>
                ${discount > 0 ? `<div class="awc-line-discount">Discount: -${money(discount, settings.currency)}</div>` : ''}
              </div>
              <div class="awc-line-side">
                <button type="button" class="awc-line-remove" data-remove-line="${lineNumber}" data-line-key="${escapeHtml(item.key || '')}" aria-label="Remove ${escapeHtml(item.product_title)} from cart">
                  <svg viewBox="0 0 24 24" width="18" height="18" focusable="false" aria-hidden="true">
                    <path fill="currentColor" d="M9 3h6a1 1 0 0 1 1 1v1h4v2h-1v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7H4V5h4V4a1 1 0 0 1 1-1Zm2 2v0h2v0h-2ZM7 7v13h10V7H7Zm3 3h2v7h-2v-7Zm4 0h2v7h-2v-7Z"/>
                  </svg>
                </button>
                <div class="awc-line-price">${linePrice}</div>
              </div>
            </div>
          `;
        }).join('') + (shouldCollapse ? `
            <button class="awc-show-more" data-toggle-lines="1">
              ${linesCollapsed ? `Show more (${currentCart.items.length - maxVisible})` : 'Show less'}
            </button>
          ` : '');
        })()}
        ${customText}
      `;

      lines.querySelectorAll('.awc-gift-scroll-left').forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = btn.closest('.awc-gift-row-wrapper').querySelector('.awc-gift-row');
          if (row) row.scrollBy({ left: -180, behavior: 'smooth' });
        });
      });

      lines.querySelectorAll('.awc-gift-scroll-right').forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = btn.closest('.awc-gift-row-wrapper').querySelector('.awc-gift-row');
          if (row) row.scrollBy({ left: 180, behavior: 'smooth' });
        });
      });

      lines.querySelectorAll('.awc-gift-row-wrapper').forEach((wrapper) => {
        const row = wrapper.querySelector('.awc-gift-row');
        const leftBtn = wrapper.querySelector('.awc-gift-scroll-left');
        const rightBtn = wrapper.querySelector('.awc-gift-scroll-right');
        if (!row || !leftBtn || !rightBtn) return;
        
        const updateButtons = () => {
          if (row.scrollLeft <= 5) leftBtn.classList.add('is-hidden');
          else leftBtn.classList.remove('is-hidden');
          
          if (row.scrollWidth - row.clientWidth - row.scrollLeft <= 5) {
            rightBtn.classList.add('is-hidden');
          } else {
            rightBtn.classList.remove('is-hidden');
          }
        };
        
        row.addEventListener('scroll', updateButtons, { passive: true });
        // Initial check needs a slight delay so DOM has widths
        requestAnimationFrame(() => {
          setTimeout(updateButtons, 50);
        });
      });

      lines.querySelectorAll('[data-toggle-lines]').forEach((toggle) => {
        toggle.addEventListener('click', async () => {
          linesCollapsed = !linesCollapsed;
          await render(settings);
        });
      });

      lines.querySelectorAll('[data-qty-delta]').forEach((el) => {
        el.addEventListener('click', async () => {
          const button = el;
          const row = button.closest('.awc-qty');
          if (!row) return;
          const line = Number(row.getAttribute('data-line'));
          const lineKey = row.getAttribute('data-line-key') || '';
          const currentQty = Number(row.getAttribute('data-qty') || 0);
          const delta = Number(button.getAttribute('data-qty-delta'));
          if (!line || !Number.isFinite(line)) return;
          const nextQty = Math.max(0, currentQty + delta);
          if (!Number.isFinite(nextQty) || nextQty === currentQty) return;

          const projectedCart = projectCartLineQuantity(latestRenderedCart || currentCart, line, nextQty);
          const mutationId = projectedCart
            ? renderOptimisticCart(settings, projectedCart)
            : optimisticMutationId;

          await runCartOp(async () => {
            debugLog('qty_click', { line, currentQty, delta, nextQty });
            try {
              const result = lineKey
                ? await cartChangeById(lineKey, nextQty)
                : await cartChangeByLine(line, nextQty);
              debugLog('qty_change_result', { ok: result.ok, status: result.status });
              if (shouldRenderMutationResult(mutationId)) {
                await render(settings, result.ok && isCartPayload(result.data) ? result.data : null);
              }
            } finally {
              if (row.isConnected) {
                row.classList.remove('is-updating');
                row.querySelectorAll('button').forEach((qtyButton) => {
                  qtyButton.removeAttribute('disabled');
                });
              }
            }
          });
        });
      });

      lines.querySelectorAll('[data-remove-line]').forEach((el) => {
        el.addEventListener('click', async () => {
          const button = el;
          const line = Number(button.getAttribute('data-remove-line'));
          const lineKey = button.getAttribute('data-line-key') || '';
          const itemRow = button.closest('.awc-line');
          if (!line || !Number.isFinite(line)) return;
          const projectedCart = projectCartLineQuantity(latestRenderedCart || currentCart, line, 0);
          const mutationId = projectedCart
            ? renderOptimisticCart(settings, projectedCart)
            : optimisticMutationId;

          await runCartOp(async () => {
            debugLog('remove_click', { line });
            try {
              const result = lineKey
                ? await cartChangeById(lineKey, 0)
                : await cartChangeByLine(line, 0);
              debugLog('remove_result', { ok: result.ok, status: result.status });
              if (shouldRenderMutationResult(mutationId)) {
                await render(settings, result.ok && isCartPayload(result.data) ? result.data : null);
              }
            } finally {
              if (itemRow?.isConnected) itemRow.classList.remove('is-removing');
              if (button.isConnected) button.removeAttribute('disabled');
            }
          });
        });
      });

      lines.querySelectorAll('[data-shipping-tier-id]').forEach((el) => {
        el.addEventListener('click', async () => {
          const button = el;
          const tierId = button.getAttribute('data-shipping-tier-id') || '';
          if (!tierId) return;
          const existingGift = currentCart.items.find(isGift);
          const choice = `${SHIPPING_REWARD_PREFIX}${tierId}`;
          pendingRewardChoice = choice;
          const projectedCart = projectCartRewardChoice(latestRenderedCart || currentCart, choice, true);
          const mutationId = projectedCart
            ? renderOptimisticCart(settings, projectedCart)
            : optimisticMutationId;

          await runCartOp(async () => {
            lastGiftError = '';
            debugLog('shipping_reward_click', { tierId, existingGiftKey: existingGift?.key || null });
            try {
              const updateResult = await cartUpdateAttributes({
                [REWARD_CHOICE_ATTR]: choice
              });
              debugLog('shipping_reward_update_result', {
                ok: updateResult.ok,
                status: updateResult.status
              });

              let cartAfterSelection = updateResult.ok && isCartPayload(updateResult.data)
                ? updateResult.data
                : null;

              if (existingGift?.key) {
                const removeResult = await cartChangeById(existingGift.key, 0);
                debugLog('shipping_reward_remove_gift_result', {
                  ok: removeResult.ok,
                  status: removeResult.status
                });
                if (removeResult.ok && isCartPayload(removeResult.data)) {
                  cartAfterSelection = removeResult.data;
                }
              }

              if (shouldRenderMutationResult(mutationId)) {
                pendingRewardChoice = '';
                await render(settings, cartAfterSelection || await cartGet());
              }
            } catch (error) {
              if (shouldRenderMutationResult(mutationId)) {
                pendingRewardChoice = '';
                await render(settings);
              }
              throw error;
            }
          });
        });
      });

      lines.querySelectorAll('.awc-gift-btn').forEach((el) => {
        el.addEventListener('click', async () => {
          if (el.hasAttribute('data-shipping-tier-id')) return;
          const variantId = Number(el.getAttribute('data-gift-variant-id'));
          const existingGift = currentCart.items.find(isGift);
          const choice = `gift:${variantId}`;
          pendingRewardChoice = choice;
          const projectedCart = projectCartGiftSelection(settings, latestRenderedCart || currentCart, variantId);
          const mutationId = projectedCart
            ? renderOptimisticCart(settings, projectedCart)
            : optimisticMutationId;

          await runCartOp(async () => {
            lastGiftError = '';
            if (Date.now() < giftRateLimitUntil) {
              const secondsLeft = Math.max(1, Math.ceil((giftRateLimitUntil - Date.now()) / 1000));
              lastGiftError = `Too many attempts. Try again in ${secondsLeft}s.`;
              if (shouldRenderMutationResult(mutationId)) pendingRewardChoice = '';
              await render(settings);
              return;
            }
            if (soldOutGiftVariantIds.has(variantId)) {
              debugLog('gift_click_blocked_sold_out_chip', { variantId });
              if (shouldRenderMutationResult(mutationId)) pendingRewardChoice = '';
              await render(settings);
              return;
            }
            debugLog('gift_click', {
              clickedVariantId: variantId,
              existingGiftVariant: existingGift?.variant_id || null,
              existingGiftKey: existingGift?.key || null
            });
            if (existingGift && Number(existingGift.variant_id) === variantId) {
              debugLog('gift_click_same_variant_noop', { variantId });
              const updateResult = await cartUpdateAttributes({
                [REWARD_CHOICE_ATTR]: choice
              });
              if (shouldRenderMutationResult(mutationId)) {
                pendingRewardChoice = '';
                await render(settings, updateResult.ok && isCartPayload(updateResult.data) ? updateResult.data : null);
              }
              return;
            }
            const addResult = await cartAddGift(variantId);
            debugLog('gift_add_result', {
              ok: addResult.ok,
              status: addResult.status,
              id: addResult.data?.id || null,
              variant_id: addResult.data?.variant_id || null,
              quantity: addResult.data?.quantity || null,
              description: addResult.data?.description || null,
              message: addResult.data?.message || null
            });
            if (!addResult.ok) {
              debugLog('gift_add_failed_payload', addResult.data || null);
              lastGiftError = addResult.data?.description || addResult.data?.message || 'Unable to add that free gift.';
              if (addResult.status === 429) {
                const retrySeconds = addResult.retryAfterSeconds && Number.isFinite(addResult.retryAfterSeconds)
                  ? Math.max(5, Math.round(addResult.retryAfterSeconds))
                  : 60;
                giftRateLimitUntil = Date.now() + (retrySeconds * 1000);
                lastGiftError = `Too many attempts. Try again in ${retrySeconds}s.`;
              }
              const failureText = `${addResult.data?.description || ''} ${addResult.data?.message || ''}`.toLowerCase();
              if (failureText.includes('sold out') || failureText.includes('out of stock') || addResult.status === 422) {
                soldOutGiftVariantIds.add(variantId);
              }
              if (shouldRenderMutationResult(mutationId)) pendingRewardChoice = '';
              await render(settings);
              return;
            }
            soldOutGiftVariantIds.delete(variantId);

            // Only remove prior gift after new gift is confirmed added.
            let cartAfterGiftChange = null;
            if (existingGift) {
              const removeResult = await cartChangeById(existingGift.key, 0);
              debugLog('gift_remove_result', {
                ok: removeResult.ok,
                status: removeResult.status,
                description: removeResult.data?.description || null,
                message: removeResult.data?.message || null
              });
              if (removeResult.ok && isCartPayload(removeResult.data)) {
                cartAfterGiftChange = removeResult.data;
              }
            }
            const rewardChoiceResult = await cartUpdateAttributes({
              [REWARD_CHOICE_ATTR]: choice
            });
            const postCart = rewardChoiceResult.ok && isCartPayload(rewardChoiceResult.data)
              ? rewardChoiceResult.data
              : cartAfterGiftChange || await cartGet();
            debugLog('post_cart_gifts', {
              giftVariantIds: (postCart.items || []).filter(isGift).map((i) => i.variant_id),
              itemCount: postCart.item_count,
              subtotal: postCart.items_subtotal_price
            });
            if (shouldRenderMutationResult(mutationId)) {
              pendingRewardChoice = '';
              await render(settings, postCart);
            }
          });
        });
      });
    }

    const subtotalEl = document.getElementById('awc-subtotal');
    const stickyHint = document.getElementById('awc-sticky-hint');
    if (stickyHint) {
      stickyHint.textContent = progress.next
        ? `${money(progress.remaining || 0, settings.currency)} away from ${progress.next.rewardLabel}`
        : 'All free gift tiers unlocked';
    }
    if (subtotalEl) {
      const cartLevelDiscount = cartLevelDiscountCents(currentCart);

      subtotalEl.innerHTML = `
        <div><strong>Subtotal:</strong> ${money(currentCart.total_price, settings.currency)}</div>
        ${cartLevelDiscount > 0 ? `<div class="awc-line-discount">Cart discounts: -${money(cartLevelDiscount, settings.currency)}</div>` : ''}
      `;
    }
  }

  async function boot() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    if (window.__awcSlidecartInitialized) return;
    window.__awcSlidecartInitialized = true;

    const baseSettings = getSettings(root);
    let settings = baseSettings;
    if (!settings.enabled) {
      return;
    }
    buildShell();
    const drawer = document.getElementById('awc-slidecart');
    if (drawer) {
      drawer.style.background = settings.panelBackground || '#f3f3f3';
    }
    const checkout = document.getElementById('awc-checkout');
    if (checkout) {
      checkout.style.background = settings.buttonFillColor || '#000000';
      checkout.style.color = settings.buttonTextColor || '#ffffff';
    }
    const note = document.getElementById('awc-discount-note');
    if (note) {
      note.textContent = settings.discountCtaNote || 'Add discount code at checkout';
    }

    let reloadInFlight = null;
    let reloadAgain = false;
    const reload = (cartOverride = null) => {
      if (cartOverride) return render(settings, cartOverride);
      if (reloadInFlight) {
        reloadAgain = true;
        return reloadInFlight;
      }
      reloadInFlight = render(settings)
        .finally(() => {
          reloadInFlight = null;
        })
        .then(() => {
          if (!reloadAgain) return undefined;
          reloadAgain = false;
          return reload();
        });
      return reloadInFlight;
    };
    bindCartTriggers(reload);
    bindHeaderCartIconTrigger(reload);
    patchNetworkCartListeners(reload);
    document.addEventListener('keydown', trapFocusInDrawer);

    await reload();

    // Fetch proxy config after triggers are already active so first cart click is intercepted.
    const proxyConfig = await getProxyConfig(baseSettings.proxyPath, baseSettings.appOrigin);
    if (proxyConfig) {
      settings = {
        ...baseSettings,
        ...proxyConfig,
        tiers: Array.isArray(proxyConfig.tiers) && proxyConfig.tiers.length
          ? proxyConfig.tiers
          : baseSettings.tiers
      };
      if (!settings.enabled) {
        closeDrawer();
        return;
      }
      if (drawer) {
        drawer.style.background = settings.panelBackground || '#f3f3f3';
      }
      if (checkout) {
        checkout.style.background = settings.buttonFillColor || '#000000';
        checkout.style.color = settings.buttonTextColor || '#ffffff';
      }
      if (note) {
        note.textContent = settings.discountCtaNote || 'Add discount code at checkout';
      }
      await reload();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
