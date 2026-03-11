(() => {
  if (window.__awcSlidecartInitialized) return;

  const ROOT_ID = 'awc-slidecart-root';
  const FREE_GIFT_PROP = '_awc_free_gift';
  const DEBUG_MODE = new URLSearchParams(window.location.search).has('awc_debug');
  let cartOpQueue = Promise.resolve();
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
      requiredSubtotalCents: Number(root.dataset[`tier${i}Threshold`] || root.getAttribute(`data-tier-${i}-threshold`) || 0),
      rewardLabel: root.dataset[`tier${i}Label`] || root.getAttribute(`data-tier-${i}-label`) || `Tier ${i}`,
      gift: {
        variantId: Number(root.dataset[`tier${i}VariantId`] || root.getAttribute(`data-tier-${i}-variant-id`) || 0),
        title: root.dataset[`tier${i}Label`] || root.getAttribute(`data-tier-${i}-label`) || `Tier ${i} gift`
      }
    })).filter((t) => t.requiredSubtotalCents > 0 && t.gift.variantId > 0);

    tiers.sort((a, b) => a.requiredSubtotalCents - b.requiredSubtotalCents);

    return {
      proxyPath: root.dataset.proxyPath || '/apps/slidecart',
      cartTitle: root.dataset.cartTitle || 'Your Cart',
      customText: root.dataset.customText || '',
      progressIntro: root.dataset.progressIntro || "You're only {{amount}} away from getting a {{reward}} for free!",
      discountCtaNote: 'Add discount code at checkout',
      enabled: true,
      buttonFillColor: '#000000',
      buttonTextColor: '#ffffff',
      panelBackground: '#f3f3f3',
      currency: root.dataset.currency || 'USD',
      tiers
    };
  }

  async function getProxyConfig(proxyPath) {
    try {
      const res = await fetch(proxyPath, { credentials: 'same-origin' });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async function cartGet() {
    const res = await fetch('/cart.js');
    if (!res.ok) throw new Error('Failed to load cart');
    return res.json();
  }

  async function cartChangeById(idOrKey, quantity) {
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
  }

  async function cartChangeByLine(line, quantity) {
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
  }

  async function cartAddGift(variantId) {
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
    if (!progress.next && progress.unlockedTier) return 'Free gift unlocked. Choose your gift.';
    if (!progress.next) return 'All free gifts unlocked.';
    if (progress.remaining <= 500) {
      return `Almost there - only ${money(progress.remaining, settings.currency)} to unlock ${progress.next.rewardLabel}.`;
    }
    return settings.progressIntro
      .replace('{{amount}}', money(progress.remaining, settings.currency))
      .replace('{{reward}}', progress.next.rewardLabel)
      .replace('[amount]', money(progress.remaining, settings.currency))
      .replace('[reward]', progress.next.rewardLabel);
  }

  function lineDiscount(item) {
    const compare = item.original_line_price || item.final_line_price;
    const final = item.final_line_price || compare;
    return Math.max(0, compare - final);
  }

  function isGift(item) {
    return item?.properties?.[FREE_GIFT_PROP] === '1';
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
      const image = tier?.gift?.image
        ? `<img src="${escapeHtml(tier.gift.image)}" alt="${escapeHtml(tier.rewardLabel)}" />`
        : `<span class="awc-tier-fallback">${escapeHtml((tier.rewardLabel || '?').charAt(0))}</span>`;
      return `
        <div class="awc-tier-stop ${active ? 'active' : ''} ${tier.id === justUnlockedTierId ? 'just-unlocked' : ''}" style="left:${leftPct}%;">
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

  function splitGiftLabel(label) {
    const raw = String(label || '');
    const idx = raw.lastIndexOf(' - ');
    if (idx <= 0) return { title: raw, variant: '' };
    return {
      title: raw.slice(0, idx).trim(),
      variant: raw.slice(idx + 3).trim(),
    };
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
      const isCartAdd = typeof url === 'string' && /\/cart\/add(\.js)?(\?|$)/.test(url);
      if (isCartAdd) suppressThemeCartFor();
      const response = await nativeFetch(...args);
      if (isCartAdd) {
        setTimeout(async () => {
          await reload();
          openDrawer();
        }, 120);
      }
      return response;
    };

    if (!window.XMLHttpRequest || window.__awcXhrPatched) return;
    window.__awcXhrPatched = true;
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__awcIsCartAdd = typeof url === 'string' && /\/cart\/add(\.js)?(\?|$)/.test(url);
      return nativeOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...sendArgs) {
      if (this.__awcIsCartAdd) {
        suppressThemeCartFor();
        this.addEventListener('loadend', () => {
          setTimeout(async () => {
            await reload();
            openDrawer();
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
    if (gifts.length <= 1) return;
    for (let i = 1; i < gifts.length; i += 1) {
      await cartChangeById(gifts[i].key, 0);
    }
  }

  function buildGiftButtons(settings, subtotal, selectedGift) {
    const eligible = settings.tiers.filter((tier) => subtotal >= tier.requiredSubtotalCents && Number(tier?.gift?.variantId) > 0);
    if (!eligible.length) return '';
    const ordered = eligible.sort((a, b) => {
      if (Number(a.gift.variantId) === selectedGift) return -1;
      if (Number(b.gift.variantId) === selectedGift) return 1;
      return 0;
    });

    return `
      <div class="awc-gifts">
        <strong>Choose one free gift:</strong>
        ${lastGiftError ? `<div class="awc-gift-error">${escapeHtml(lastGiftError)}</div>` : ''}
        <div class="awc-gift-row">
          ${ordered.map((tier) => `
            ${(() => {
              const parts = splitGiftLabel(tier.gift.title);
              return `
            <button
              class="awc-gift-btn ${selectedGift === tier.gift.variantId ? 'is-selected' : ''} ${soldOutGiftVariantIds.has(Number(tier.gift.variantId)) ? 'is-soldout' : ''}"
              data-gift-variant-id="${tier.gift.variantId}"
              ${soldOutGiftVariantIds.has(Number(tier.gift.variantId)) || Date.now() < giftRateLimitUntil ? 'disabled aria-disabled="true"' : ''}
            >
              ${tier?.gift?.image ? `<img src="${escapeHtml(tier.gift.image)}" alt="${escapeHtml(tier.gift.title)}" />` : ''}
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
      </div>
    `;
  }

  async function render(settings) {
    const cart = await cartGet();
    await enforceOneGift(cart);
    const currentCart = await cartGet();

    const title = document.getElementById('awc-cart-title');
    if (title) title.textContent = `${settings.cartTitle} ${currentCart.item_count || 0}`;

    const subtotal = Number(currentCart.items_subtotal_price || 0);
    const progress = getProgress(subtotal, settings.tiers);
    const justUnlockedTierId =
      progress.unlockedTier?.id && progress.unlockedTier.id !== lastUnlockedTierId
        ? progress.unlockedTier.id
        : null;
    lastUnlockedTierId = progress.unlockedTier?.id || null;

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
    const selectedGiftVariantId = giftLine ? Number(giftLine.variant_id) : 0;

    const lines = document.getElementById('awc-lines');
    if (lines) {
      if (Date.now() < giftRateLimitUntil) {
        const secondsLeft = Math.max(1, Math.ceil((giftRateLimitUntil - Date.now()) / 1000));
        lastGiftError = `Too many attempts. Try again in ${secondsLeft}s.`;
      }
      lines.innerHTML = `
        ${buildGiftButtons(settings, subtotal, selectedGiftVariantId)}
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
          const giftBadge = isGift(item)
            ? `
              <span class="awc-gift-badge awc-gift-badge-abs" aria-label="Free gift">
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
              ${giftBadge}
              <img src="${item.image || ''}" alt="${escapeHtml(item.product_title)}" />
              <div>
                <div class="awc-line-title">${escapeHtml(item.product_title)}</div>
                <div class="awc-line-meta">${escapeHtml(item.variant_title || '')}</div>
                <div class="awc-qty" data-line="${lineNumber}" data-qty="${item.quantity}">
                  <button data-qty-delta="-1">-</button>
                  <span>${item.quantity}</span>
                  <button data-qty-delta="1">+</button>
                </div>
                ${discount > 0 ? `<div class="awc-line-discount">Discount: -${money(discount, settings.currency)}</div>` : ''}
              </div>
              <div>${linePrice}</div>
            </div>
          `;
        }).join('') + (shouldCollapse ? `
            <button class="awc-show-more" data-toggle-lines="1">
              ${linesCollapsed ? `Show more (${currentCart.items.length - maxVisible})` : 'Show less'}
            </button>
          ` : '');
        })()}
        <div class="awc-custom">${escapeHtml(settings.customText)}</div>
      `;

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
          const currentQty = Number(row.getAttribute('data-qty') || 0);
          const delta = Number(button.getAttribute('data-qty-delta'));
          if (!line || !Number.isFinite(line)) return;
          const nextQty = Math.max(0, currentQty + delta);
          await runCartOp(async () => {
            debugLog('qty_click', { line, currentQty, delta, nextQty });
            const result = await cartChangeByLine(line, nextQty);
            debugLog('qty_change_result', { ok: result.ok, status: result.status });
            await render(settings);
          });
        });
      });

      lines.querySelectorAll('.awc-gift-btn').forEach((el) => {
        el.addEventListener('click', async () => {
          const variantId = Number(el.getAttribute('data-gift-variant-id'));
          const existingGift = currentCart.items.find(isGift);
          await runCartOp(async () => {
            lastGiftError = '';
            if (Date.now() < giftRateLimitUntil) {
              const secondsLeft = Math.max(1, Math.ceil((giftRateLimitUntil - Date.now()) / 1000));
              lastGiftError = `Too many attempts. Try again in ${secondsLeft}s.`;
              await render(settings);
              return;
            }
            if (soldOutGiftVariantIds.has(variantId)) {
              debugLog('gift_click_blocked_sold_out_chip', { variantId });
              return;
            }
            debugLog('gift_click', {
              clickedVariantId: variantId,
              existingGiftVariant: existingGift?.variant_id || null,
              existingGiftKey: existingGift?.key || null
            });
            if (existingGift && Number(existingGift.variant_id) === variantId) {
              debugLog('gift_click_same_variant_noop', { variantId });
              await render(settings);
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
              await render(settings);
              return;
            }
            soldOutGiftVariantIds.delete(variantId);

            // Only remove prior gift after new gift is confirmed added.
            if (existingGift) {
              const removeResult = await cartChangeById(existingGift.key, 0);
              debugLog('gift_remove_result', {
                ok: removeResult.ok,
                status: removeResult.status,
                description: removeResult.data?.description || null,
                message: removeResult.data?.message || null
              });
            }
            const postCart = await cartGet();
            debugLog('post_cart_gifts', {
              giftVariantIds: (postCart.items || []).filter(isGift).map((i) => i.variant_id),
              itemCount: postCart.item_count,
              subtotal: postCart.items_subtotal_price
            });
            await render(settings);
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
      const cartLevelDiscount = (currentCart.cart_level_discount_applications || []).reduce((acc, d) => {
        const amount = Number(d.total_allocated_amount || 0);
        return acc + Math.round(amount * 100);
      }, 0);

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

    const reload = () => render(settings);
    bindCartTriggers(reload);
    bindHeaderCartIconTrigger(reload);
    patchNetworkCartListeners(reload);
    document.addEventListener('keydown', trapFocusInDrawer);

    await reload();

    // Fetch proxy config after triggers are already active so first cart click is intercepted.
    const proxyConfig = await getProxyConfig(baseSettings.proxyPath);
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
