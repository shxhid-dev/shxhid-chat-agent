/**
 * Shopify Chat Agent - Production Ready
 * - Product carousel with click-to-open modal
 * - Auto-expand textarea with smooth placeholder fade
 * - Chat history with conversation loading
 * - Email capture via built-in overlay
 * - SSE streaming with thinking indicators
 * - Photo search: attach / paste / drop a photo of a part or nameplate
 *
 * v6.0 — Oct 26, 2026 — STUDIO UI
 *   - TIA logo mark on assistant messages, empty state and launcher; Lucide icons; no emoji.
 *   - Modal ⇄ side-panel switch is a FLIP layout animation (transform only, no flicker).
 *   - Streaming renders are batched per animation frame; auto-scroll only sticks to the bottom
 *     when the reader is already there.
 *   - Static typing-indicator labels (no cycling phrases / intervals), error rows with Retry,
 *     focus trap + focus return, Enter/Shift+Enter via keydown (IME-safe), visualViewport
 *     sizing on phones so the keyboard never covers the composer.
 *
 * v5.0 — Oct 26, 2026 — TIA REDESIGN
 *   - Display modes: 'modal' (full screen, page blurred) or 'popup' (bottom-right widget with a
 *     launcher bubble). Header toggle + menu; saved in localStorage 'shopAiDisplayMode'.
 *   - Theme: Light / Dark / Auto (follows the OS), saved in localStorage 'shopAiTheme'.
 *   - Streaming caret while text arrives; new typing indicator, product cards (part number chip,
 *     price, "View" link, "Best match" badge) and a match-confidence chip for photo results.
 *   - History strips the server's "[[Cards shown: …]]" follow-up memory note.
 *
 * v4.2 — Oct 24, 2026 — PHOTO SEARCH
 *   The camera button (or paste / drag-and-drop) attaches one photo. It is resized in the
 *   browser (longest side 1568 px, JPEG) before upload and sent as `image` with the message;
 *   the message text is optional. History shows "[Photo: …]" markers as a photo chip.
 *
 * v4.1 — Oct 5, 2026 — ADD TO CART FIX
 *   Add to Cart now uses the store's own cart (/cart/add.js), so the item shows
 *   in the theme cart icon, cart drawer and /cart page. Previously it created a
 *   separate Storefront API cart that only the chat's checkout link could see.
 *   The backend /api/cart cart is kept as a fallback; "Go to Cart" opens /cart.
 *
 * v4.0 — May 7, 2026 — CRITICAL RENDERING FIX
 *
 * ROOT CAUSE OF "CARDS NOT RENDERING" BUG:
 *   The v3.x deferred rendering strategy (buffer products until end_turn)
 *   had a fatal race condition:
 *
 *   1. Claude makes tool call #1 → product_results arrives → pendingProducts set
 *   2. Claude sends text → chunk events → message_complete fires
 *   3. message_complete handler resets currentAssistantMsg/fullText but does NOT
 *      flush pendingProducts
 *   4. Claude makes tool call #2 → NEW product_results arrives → pendingProducts
 *      overwritten with new (possibly empty) results
 *   5. end_turn fires → renders pendingProducts (which is now the wrong set,
 *      or empty if tool call #2 returned nothing)
 *
 *   Additionally, in long sessions (5+ searches), the `lastProductsGridEl`
 *   reference pointed to a DOM node that had already been scrolled far above,
 *   so the removal + re-add logic silently failed.
 *
 * FIX:
 *   - Render product cards IMMEDIATELY on product_results event
 *   - Remove deferred rendering entirely — it was an over-optimization
 *   - When a new product_results arrives in the same turn, remove the
 *     PREVIOUS grid from that turn (not from a prior turn)
 *   - This guarantees the user always sees the latest search results
 *
 * ALSO FIXED:
 *   - Image placeholder now uses buildProductImage() consistently
 *   - Modal description guards against [object Object]
 *   - onerror on <img> replaces with placeholder SVG
 */

/* global PUB_SUB_EVENTS */ // Dawn's cart pub/sub, a script-level const (checked with typeof)
(function () {
  'use strict';

  // ─── Image placeholder SVG ────────────────────────────────────────────────
  const PLACEHOLDER_SVG = `<div class="shop-ai-img-placeholder"><svg class="tia-i" viewBox="0 0 24 24" aria-hidden="true" style="width:28px;height:28px;stroke-width:1.5"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/></svg></div>`;

  function buildProductImage(imageUrl, altText, cssClass) {
    const src = (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('http'))
      ? imageUrl : null;

    const wrapper = document.createElement('div');
    wrapper.className = cssClass || 'shop-ai-product-image-wrap';
    wrapper.style.cssText = 'width:100%;overflow:hidden;';

    if (!src) {
      wrapper.innerHTML = PLACEHOLDER_SVG;
      return wrapper;
    }

    const img = document.createElement('img');
    img.className = 'shop-ai-product-image';
    img.src = src;
    img.alt = altText || '';
    img.loading = 'lazy';
    img.onerror = function () {
      this.onerror = null;
      const ph = document.createElement('div');
      ph.innerHTML = PLACEHOLDER_SVG;
      if (this.parentElement) {
        this.parentElement.replaceChild(ph.firstElementChild, this);
      }
    };

    wrapper.appendChild(img);
    return wrapper;
  }

  // ─── Photo upload ─────────────────────────────────────────────────────────
  // 1568 px is the largest size Claude reads without downscaling; JPEG keeps uploads ~150-500 KB.
  const PHOTO_MAX_EDGE = 1568;
  const PHOTO_JPEG_QUALITY = 0.85;
  const PHOTO_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
  const PHOTO_MARKER_RE = /^\[Photo(?::\s*([^\]]*))?\]\s*/;

  // Same pattern as CARDS_MARKER_RE in app/services/card-memory.server.js.
  const CARDS_MARKER_RE = /\n*\[\[Cards shown:[\s\S]*?\]\]\s*$/;

  const MODE_KEY = 'shopAiDisplayMode';
  const THEME_KEY = 'shopAiTheme';
  const MODES = ['modal', 'popup'];
  const THEMES = ['light', 'dark', 'system'];

  // localStorage can throw (private mode, blocked storage): never let that break the widget.
  function readPref(key, allowed, fallback) {
    try {
      const v = localStorage.getItem(key);
      return allowed.includes(v) ? v : fallback;
    } catch (_) {
      return fallback;
    }
  }
  function writePref(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* ignore */ }
  }

  // ─── Brand + icons (Lucide paths, MIT) ────────────────────────────────────
  const MARK_SVG = '<svg class="tia-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect class="tia-mark-tile" width="24" height="24" rx="7"/><path class="tia-mark-glyph" d="M7.5 7.5h9M12 7.5v9"/><circle class="tia-mark-dot" cx="17.25" cy="16.5" r="1.75"/></svg>';
  const ICON_PATHS = {
    arrowUpRight: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  };
  function icon(name, size = '') {
    return `<svg class="tia-i${size ? ` tia-i-${size}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ''}</svg>`;
  }
  function avatarEl() {
    const span = document.createElement('span');
    span.className = 'tia-avatar';
    span.innerHTML = MARK_SVG;
    return span;
  }

  // Short, fixed labels for the typing indicator (the server sends these states).
  // Older backends sent these strings; newer ones send the final wording ("Analyzing your image").
  const THINKING_LABELS = {
    'Reading your photo...': 'Analyzing your image',
    'Searching products...': 'Searching the catalogue',
    'Adding to cart...': 'Adding to cart',
    'Looking up product...': 'Gathering product details',
    'Looking up product details...': 'Gathering product details',
    'Checking availability...': 'Checking availability',
    'Loading conversation...': 'Loading your conversation',
  };

  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  /** Decode, downscale and re-encode as JPEG. Rejects if the browser can't read the format (e.g. HEIC on Chrome). */
  async function preparePhoto(file) {
    let source;
    if (typeof createImageBitmap === 'function') {
      try {
        source = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (_) {
        source = null;
      }
    }
    if (!source) source = await loadImageElement(file);

    const w = source.width;
    const h = source.height;
    if (!w || !h) throw new Error('empty image');
    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // transparent PNGs would turn black in JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (typeof source.close === 'function') source.close();

    const dataUrl = canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY);
    return { dataUrl, data: dataUrl.split(',')[1], mediaType: 'image/jpeg' };
  }

  const ShopAIChat = {
    state: {
      isOpen: false,
      isThinking: false,
      thinkingInterval: null,
      conversationId: sessionStorage.getItem('shopAiConversationId') || null,
      visitorId: sessionStorage.getItem('shopAiVisitorId') || null,
      emailCaptured: localStorage.getItem('shopAiEmailCaptured') === 'true',
      emailPopupShown: sessionStorage.getItem('shopAiEmailPopupShown') === 'true',
      isFirstMessage: !sessionStorage.getItem('shopAiConversationId'),
      buffer: '',
      chatHistory: JSON.parse(localStorage.getItem('shopAiChatHistory') || '[]'),
      cartId: sessionStorage.getItem('shopAiCartId') || null,
      checkoutUrl: sessionStorage.getItem('shopAiCheckoutUrl') || null,
      // 'native'   = item went into the store's own cart (/cart/add.js) — same
      //              cart as the theme cart icon, cart drawer and /cart page.
      // 'headless' = fallback Storefront API cart created by the backend; only
      //              reachable through its checkoutUrl (/cart/c/...).
      cartMode: sessionStorage.getItem('shopAiCartMode') || null,
      selectedProduct: null,
      selectedProductModal: null,
      isCartUpdating: false,
      addedByProductId: JSON.parse(sessionStorage.getItem('shopAiAddedByProductId') || '{}'),
      productDataMap: new Map(),
      lastCheckoutUrlShown: null,
      // { dataUrl, data, mediaType } of the photo waiting to be sent with the next message
      pendingImage: null,
      isPreparingImage: false,
      displayMode: readPref(MODE_KEY, MODES, 'modal'),
      themePref: readPref(THEME_KEY, THEMES, 'light'),
    },

    elements: {},

    init() {
      this.elements = {
        root: document.querySelector('.shop-ai-reset'),
        modeBtn: document.getElementById('shop-ai-mode-btn'),
        floatingGroup: document.getElementById('shop-ai-floating-group'),
        modal: document.getElementById('shop-ai-modal'),
        backdrop: document.getElementById('shop-ai-backdrop'),
        messages: document.getElementById('shop-ai-messages'),
        input: document.getElementById('shop-ai-input'),
        sendBtn: document.getElementById('shop-ai-send-btn'),
        closeBtn: document.getElementById('shop-ai-close-btn'),
        menuBtn: document.getElementById('shop-ai-menu-btn'),
        menuDropdown: document.getElementById('shop-ai-menu'),
        suggestions: document.getElementById('shop-ai-suggestions'),
        historyPanel: document.getElementById('shop-ai-history-panel'),
        historyList: document.getElementById('shop-ai-history-list'),
        backBtn: document.getElementById('shop-ai-back-btn'),
        attachBtn: document.getElementById('shop-ai-attach-btn'),
        fileInput: document.getElementById('shop-ai-file-input'),
        imagePreview: document.getElementById('shop-ai-image-preview'),
        inputArea: document.querySelector('#shop-ai-modal .shop-ai-input-area'),
      };

      if (!this.elements.modal) {
        console.error('❌ Modal element not found');
        return;
      }

      // A shorter prompt fits one line on phones (a wrapped placeholder grows the box and shows a scrollbar).
      if (this.elements.input && window.matchMedia?.('(max-width: 599px)').matches) {
        this.elements.input.placeholder = 'Ask TIA about a part';
      }
      this.applyTheme(this.state.themePref);
      this.applyDisplayMode(this.state.displayMode, { animate: false, save: false });
      this.bindEvents();
      this.restoreState();
      this.exposeAPI();

      console.log('ShopAIChat v5.0 (TIA) initialized');
    },

    bindEvents() {
      document.querySelectorAll('[data-trigger]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          this.open();
        });
      });

      if (this.elements.closeBtn) {
        this.elements.closeBtn.addEventListener('click', () => this.close());
      }

      // Auto-scroll sticks to the bottom only while the reader is there.
      this._stick = true;
      this.elements.messages?.addEventListener('scroll', () => {
        const m = this.elements.messages;
        this._stick = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
      }, { passive: true });
      if (this.elements.backdrop) {
        this.elements.backdrop.addEventListener('click', () => this.close());
      }

      if (this.elements.sendBtn) {
        this.elements.sendBtn.addEventListener('click', () => this.send());
      }
      if (this.elements.input) {
        // keydown (not the deprecated keypress) and never while an IME is composing text.
        this.elements.input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            this.send();
          }
        });
        this.elements.input.addEventListener('input', () => {
          const el = this.elements.input;
          el.style.height = 'auto';
          el.style.height = Math.min(el.scrollHeight, 140) + 'px';
          this.updateSendState();
        });
        // Paste a screenshot / copied photo straight into the box.
        this.elements.input.addEventListener('paste', (e) => {
          const file = Array.from(e.clipboardData?.files || []).find(f => f.type.startsWith('image/'));
          if (file) {
            e.preventDefault();
            this.handleImageFile(file);
          }
        });
      }

      if (this.elements.attachBtn && this.elements.fileInput) {
        this.elements.attachBtn.addEventListener('click', () => this.elements.fileInput.click());
        this.elements.fileInput.addEventListener('change', () => {
          const file = this.elements.fileInput.files?.[0];
          this.elements.fileInput.value = ''; // allow picking the same file again
          if (file) this.handleImageFile(file);
        });
      }

      if (this.elements.imagePreview) {
        this.elements.imagePreview.addEventListener('click', (e) => {
          if (e.target.closest('[data-image-action="remove"]')) this.clearPendingImage();
        });
      }

      if (this.elements.modal && this.elements.attachBtn) {
        const area = this.elements.inputArea;
        let dragDepth = 0;
        const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
        this.elements.modal.addEventListener('dragenter', (e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth++;
          area?.classList.add('shop-ai-drop-active');
        });
        this.elements.modal.addEventListener('dragover', (e) => {
          if (hasFiles(e)) e.preventDefault();
        });
        this.elements.modal.addEventListener('dragleave', () => {
          dragDepth = Math.max(0, dragDepth - 1);
          if (!dragDepth) area?.classList.remove('shop-ai-drop-active');
        });
        this.elements.modal.addEventListener('drop', (e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth = 0;
          area?.classList.remove('shop-ai-drop-active');
          const file = Array.from(e.dataTransfer.files || []).find(f => f.type.startsWith('image/'));
          if (file) this.handleImageFile(file);
        });
      }

      if (this.elements.menuBtn) {
        this.elements.menuBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.setMenuOpen(!this.elements.menuDropdown?.classList.contains('active'));
        });
      }

      if (this.elements.modeBtn) {
        this.elements.modeBtn.addEventListener('click', () => {
          this.applyDisplayMode(this.state.displayMode === 'modal' ? 'popup' : 'modal');
        });
      }

      // OS theme changes while "Auto" is selected
      try {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => { if (this.state.themePref === 'system') this.applyTheme('system'); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
      } catch (_) { /* matchMedia unsupported */ }

      if (this.elements.menuDropdown) {
        this.elements.menuDropdown.addEventListener('click', (e) => {
          // Layout / appearance switches keep the menu open so the change is visible.
          const modeBtn = e.target.closest('[data-set-mode]');
          if (modeBtn) {
            e.stopPropagation();
            this.applyDisplayMode(modeBtn.dataset.setMode);
            return;
          }
          const themeBtn = e.target.closest('[data-set-theme]');
          if (themeBtn) {
            e.stopPropagation();
            this.applyTheme(themeBtn.dataset.setTheme, { save: true });
            return;
          }
          const item = e.target.closest('[data-action]');
          if (!item) return;
          const action = item.dataset.action;
          this.setMenuOpen(false);
          if (action === 'new') this.startNewChat();
          if (action === 'history') this.openHistory();
          if (action === 'end') { this.startNewChat(); this.close(); }
        });
      }

      if (this.elements.backBtn) {
        this.elements.backBtn.addEventListener('click', () => this.closeHistory());
      }

      document.addEventListener('click', (e) => {
        if (this.elements.menuDropdown?.classList.contains('active') &&
            !this.elements.menuBtn?.contains(e.target) &&
            !this.elements.menuDropdown?.contains(e.target)) {
          this.setMenuOpen(false);
        }
      });

      document.addEventListener('keydown', (e) => {
        if (!this.state.isOpen) return;
        if (e.key === 'Tab') return this.trapFocus(e);
        if (e.key !== 'Escape') return;
        // Close the innermost layer first: product details → menu → history → chat.
        if (this.state.selectedProductModal) return this.handleCloseProductModal();
        if (this.elements.menuDropdown?.classList.contains('active')) {
          this.setMenuOpen(false);
          return this.elements.menuBtn?.focus();
        }
        if (this.elements.historyPanel?.classList.contains('active')) return this.closeHistory();
        this.close();
      });

      document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-product-action]');
        if (!btn) return;

        e.preventDefault();
        e.stopPropagation();

        const action = btn.dataset.productAction;
        const productId = btn.dataset.productId;

        if (action === 'view-product') {
          this.handleViewProduct(productId);
        } else if (action === 'add-to-cart') {
          this.handleAddToCart(productId);
        } else if (action === 'go-to-cart') {
          this.handleGoToCart();
        } else if (action === 'modal-open') {
          this.handleOpenProductModal(productId);
        } else if (action === 'modal-close') {
          this.handleCloseProductModal();
        }
      });
    },

    open() {
      // Email capture popup is controlled by the "Show email capture popup"
      // setting on the app embed (off by default).
      const emailPopupEnabled = window.shopChatConfig?.emailPopupEnabled === true;
      if (emailPopupEnabled && this.state.isFirstMessage && !this.state.emailCaptured && !this.state.emailPopupShown) {
        this.showEmailPopup();
        this.state.emailPopupShown = true;
        sessionStorage.setItem('shopAiEmailPopupShown', 'true');
      }

      document.body.classList.add('shop-ai-open', `shop-ai-mode-${this.state.displayMode}`);
      if (this.state.needsRestore) {
        this.state.needsRestore = false;
        const hasMessages = !!this.elements.messages?.querySelector('.shop-ai-message');
        if (!hasMessages && this.state.conversationId) this.loadConversation(this.state.conversationId, { quiet: true });
      }
      if (this.elements.floatingGroup) {
        this.elements.floatingGroup.classList.add('hidden');
      }
      if (!this.state.isOpen) this.state.returnFocus = document.activeElement;
      this.state.isOpen = true;
      this.bindViewport(true);
      // Wait for the open transition so mobile keyboards don't jump the layout.
      setTimeout(() => this.elements.input?.focus({ preventScroll: true }), 120);
    },

    close() {
      document.body.classList.remove('shop-ai-open', 'shop-ai-mode-modal', 'shop-ai-mode-popup');
      this.setMenuOpen(false);
      if (this.elements.floatingGroup) {
        this.elements.floatingGroup.classList.remove('hidden');
      }
      this.state.isOpen = false;
      this.bindViewport(false);
      // Give focus back to whatever opened the chat (header button, launcher, suggestion).
      const back = this.state.returnFocus;
      this.state.returnFocus = null;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus({ preventScroll: true });
      else this.elements.floatingGroup?.querySelector('button')?.focus({ preventScroll: true });
    },

    setMenuOpen(open) {
      this.elements.menuDropdown?.classList.toggle('active', !!open);
      this.elements.menuBtn?.setAttribute('aria-expanded', String(!!open));
    },

    /** Keep Tab inside the dialog while it is modal (full screen, or the phone sheet). */
    trapFocus(e) {
      const modal = this.elements.modal;
      const isSheet = window.matchMedia?.('(max-width: 599px)').matches;
      if (!modal || (this.state.displayMode !== 'modal' && !isSheet && !this.state.selectedProductModal)) return;
      const scope = this.state.selectedProductModal || modal;
      // Skip controls in the closed menu / history panel: they are visibility:hidden, not display:none.
      const focusable = [...scope.querySelectorAll('button, [href], textarea, input:not([type="hidden"]), [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !scope.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    },

    /**
     * Phones: size the sheet to the visual viewport so the on-screen keyboard never covers the
     * composer. Writes two CSS variables at most once per frame.
     */
    bindViewport(on) {
      const vv = window.visualViewport;
      const root = this.elements.root;
      if (!vv || !root) return;
      if (!this._onViewport) {
        let frame = 0;
        this._onViewport = () => {
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            root.style.setProperty('--tia-vv-height', `${Math.round(vv.height)}px`);
            root.style.setProperty('--tia-vv-top', `${Math.round(vv.offsetTop)}px`);
          });
        };
      }
      if (on) {
        this._onViewport();
        vv.addEventListener('resize', this._onViewport);
        vv.addEventListener('scroll', this._onViewport);
      } else {
        vv.removeEventListener('resize', this._onViewport);
        vv.removeEventListener('scroll', this._onViewport);
      }
    },

    /** 'modal' (full screen with a scrim) or 'popup' (bottom-right side panel). */
    applyDisplayMode(mode, { animate = true, save = true } = {}) {
      const next = MODES.includes(mode) ? mode : 'modal';
      const root = this.elements.root;
      const panel = this.elements.modal;
      const swap = () => {
        this.state.displayMode = next;
        if (root) {
          root.classList.remove('tia-mode-modal', 'tia-mode-popup');
          root.classList.add(`tia-mode-${next}`);
        }
        if (this.state.isOpen) {
          document.body.classList.remove('shop-ai-mode-modal', 'shop-ai-mode-popup');
          document.body.classList.add(`shop-ai-mode-${next}`);
        }
        this.elements.modeBtn?.setAttribute('aria-label', next === 'modal' ? 'Switch to side panel' : 'Switch to full screen');
        root?.querySelectorAll('[data-set-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.setMode === next)));
        if (save) writePref(MODE_KEY, next);
      };

      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const isSheet = window.matchMedia?.('(max-width: 599px)').matches;
      if (!animate || !root || !panel || !this.state.isOpen || this.state.displayMode === next || reduced || isSheet) return swap();

      // FLIP: measure, switch layout, then animate the panel from its old box to the new one
      // with transform only. Content fades out for the morph so stretched text is never seen.
      const first = panel.getBoundingClientRect();
      root.classList.add('tia-morphing');
      swap();
      const last = panel.getBoundingClientRect();
      if (!last.width || !last.height) {
        root.classList.remove('tia-morphing');
        return;
      }
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      const sx = first.width / last.width;
      const sy = first.height / last.height;
      panel.style.transition = 'none';
      panel.style.transformOrigin = 'top left';
      panel.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      panel.getBoundingClientRect(); // commit the inverted frame before animating
      panel.style.transition = 'transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1)';
      panel.style.transform = '';
      const done = () => {
        panel.removeEventListener('transitionend', onEnd);
        clearTimeout(fallback);
        panel.style.transition = '';
        panel.style.transformOrigin = '';
        root.classList.remove('tia-morphing');
      };
      const onEnd = (ev) => { if (ev.target === panel && ev.propertyName === 'transform') done(); };
      const fallback = setTimeout(done, 320);
      panel.addEventListener('transitionend', onEnd);
      // Bring the content back while the panel settles, so the whole switch stays near 250ms.
      setTimeout(() => root.classList.remove('tia-morphing'), 120);
    },

    /** 'light' | 'dark' | 'system' (follows the OS). */
    applyTheme(pref, { save = false } = {}) {
      const choice = THEMES.includes(pref) ? pref : 'light';
      let resolved = choice;
      if (choice === 'system') {
        try { resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (_) { resolved = 'light'; }
      }
      this.state.themePref = choice;
      this.elements.root?.setAttribute('data-theme', resolved);
      this.elements.root?.querySelectorAll('[data-set-theme]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.setTheme === choice)));
      if (save) writePref(THEME_KEY, choice);
    },

    openPhotoPicker() {
      if (!this.state.isOpen) this.open();
      this.elements.fileInput?.click();
    },

    showEmailPopup() {
      const overlay = document.getElementById('shop-ai-email-overlay');
      if (!overlay) return;

      overlay.classList.add('active');

      const submitBtn = document.getElementById('shop-ai-email-submit');
      const skipBtn = document.getElementById('shop-ai-email-skip');
      const emailInput = document.getElementById('shop-ai-email-input');
      const errorEl = document.getElementById('shop-ai-email-error');

      const closeOverlay = () => overlay.classList.remove('active');

      const onSubmit = () => {
        const email = emailInput?.value?.trim();
        if (email && email.includes('@') && email.includes('.')) {
          this.state.emailCaptured = true;
          localStorage.setItem('shopAiEmailCaptured', 'true');
          closeOverlay();
          this.captureEmail(email);
          submitBtn?.removeEventListener('click', onSubmit);
          skipBtn?.removeEventListener('click', onSkip);
        } else {
          if (errorEl) errorEl.classList.add('visible');
        }
      };

      const onSkip = () => {
        closeOverlay();
        submitBtn?.removeEventListener('click', onSubmit);
        skipBtn?.removeEventListener('click', onSkip);
      };

      submitBtn?.addEventListener('click', onSubmit);
      skipBtn?.addEventListener('click', onSkip);

      setTimeout(() => emailInput?.focus(), 300);
    },

    async captureEmail(email) {
      try {
        const leadsUrl = window.shopChatConfig?.leadsUrl;
        if (!leadsUrl) {
          console.warn('Leads URL not configured');
          return;
        }
        await fetch(leadsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            visitorId: this.state.visitorId,
            conversationId: this.state.conversationId,
            shop_domain: window.shopChatConfig?.shopDomain || '',
          })
        });
      } catch (e) {
        console.warn('Email capture failed:', e);
      }
    },

    async send(messageArg, { retry = false } = {}) {
      let message;
      let image;
      if (retry) {
        // "Retry" on an error row re-sends the last request without adding a new user bubble.
        if (!this.state.lastRequest) return;
        ({ message, image } = this.state.lastRequest);
      } else {
        const fromArg = typeof messageArg === 'string' && !!messageArg.trim();
        message = fromArg ? messageArg.trim() : (this.elements.input?.value?.trim() || '');
        // Suggestion buttons (openAndSend) send their text only; a typed send carries the pending photo.
        if (!fromArg && this.state.isPreparingImage) return;
        image = fromArg ? null : this.state.pendingImage;
      }
      if (!message && !image) return;
      this.state.lastRequest = { message, image };

      // Hide the welcome on any send (it can also be showing after a restored chat failed to load).
      this.state.isFirstMessage = false;
      if (this.elements.suggestions) {
        this.elements.suggestions.classList.remove('visible');
        this.elements.suggestions.style.display = 'none';
      }

      if (!retry) {
        this.addMessage(message, 'user', { imageUrl: image?.dataUrl });
        if (this.elements.input) {
          this.elements.input.value = '';
          this.elements.input.style.height = 'auto';
        }
        if (image) this.clearPendingImage();
        this.updateSendState();
      }

      if (!this.state.conversationId) {
        this.state.conversationId = 'conv_' + Date.now();
        sessionStorage.setItem('shopAiConversationId', this.state.conversationId);
      }

      if (!retry) this.saveToHistory(message || 'Photo');
      // The first real status arrives from the server; until then say what has started.
      this.showThinking(image ? 'Analyzing your image' : 'Thinking');

      try {
        const apiUrl = window.shopChatConfig?.apiUrl;
        if (!apiUrl) {
          throw new Error('Chat API URL not configured. Check theme extension settings.');
        }

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            conversation_id: this.state.conversationId,
            prompt_type: window.shopChatConfig?.promptType || 'standardAssistant',
            shop_domain: window.shopChatConfig?.shopDomain || '',
            ...(image ? { image: { data: image.data, media_type: image.mediaType } } : {}),
          })
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          console.error('❌ API response:', response.status, errorText.substring(0, 200));
          // Photo rejections (413 too large, 415 format, 429 too many) carry a readable reason.
          let reason = '';
          try { reason = JSON.parse(errorText)?.error || ''; } catch (_) { /* not JSON */ }
          const error = new Error(`Server returned ${response.status}`);
          if (image && reason && [400, 413, 415, 429].includes(response.status)) error.userMessage = reason;
          throw error;
        }

        const contentType = response.headers.get('Content-Type') || '';
        if (contentType.includes('text/html')) {
          console.error('❌ Received HTML instead of SSE — check backend URL');
          throw new Error('Received HTML response instead of stream. Backend URL may be wrong.');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let currentAssistantMsg = null;
        let buffer = '';
        let fullText = '';

        // v4.0: Track the current turn's product grid element so we can
        // replace it if Claude does multiple searches in one turn.
        // This is a per-turn reference — reset on each send().
        let currentTurnGridEl = null;

        // Track the active assistant text bubble across tool-result cycles.
        let activeBubbleEl = null;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const chunk of parts) {
            const line = chunk.trim();
            if (!line) continue;

            const jsonStr = line.startsWith('data:') ? line.slice(5).trim() : line;
            let data;
            try {
              data = JSON.parse(jsonStr);
            } catch (err) {
              continue;
            }

            if (data.type === 'id' && data.conversation_id) {
              this.state.conversationId = data.conversation_id;
              sessionStorage.setItem('shopAiConversationId', data.conversation_id);
            }

            if (data.type === 'thinking_state') {
              this.updateThinkingState(data.state);
            }

            if (data.type === 'chunk') {
              if (this.state.isThinking) {
                this.removeThinking();
              }
              fullText += data.chunk;
              if (!currentAssistantMsg) {
                currentAssistantMsg = this.addMessage('', 'assistant');
                activeBubbleEl = currentAssistantMsg.querySelector('.shop-ai-bubble');
              }
              if (activeBubbleEl) {
                activeBubbleEl.classList.add('is-streaming');
                this.queueStreamRender(activeBubbleEl, fullText);
              }
            }

            // ═══════════════════════════════════════════════════════════
            // v4.0 CRITICAL FIX: Render products IMMEDIATELY
            //
            // The v3.x "deferred to end_turn" approach caused cards to
            // vanish in long sessions. Now we render on every
            // product_results event. If Claude searches again in the
            // same turn, we remove the previous grid and render the new
            // one. This guarantees the user always sees the latest.
            // ═══════════════════════════════════════════════════════════
            if (data.type === 'product_results') {
              this.removeThinking();
              const products = data.products || [];
              if (products.length > 0) {
                // Remove previous grid from THIS turn (if Claude retried)
                if (currentTurnGridEl && currentTurnGridEl.parentNode) {
                  currentTurnGridEl.parentNode.removeChild(currentTurnGridEl);
                }
                currentTurnGridEl = this.renderProductsGrid(products, data.match || null);
              }
            }

            if (data.type === 'cart_updated') {
              this.removeThinking();
              if (data.checkout_url) {
                this.updateCheckoutState(data.checkout_url, data.cart?.id);
              }
            }

            if (data.type === 'message_complete') {
              this.removeThinking();
              this.flushStreamRender();
              activeBubbleEl?.classList.remove('is-streaming');
              if (currentAssistantMsg) {
                // v4.0: Do NOT reset currentTurnGridEl here.
                // The grid belongs to the turn, not the message.
                currentAssistantMsg = null;
                activeBubbleEl = null;
                fullText = '';
              }
            }

            if (data.type === 'end_turn') {
              this.removeThinking();
              this.flushStreamRender();
              this.stopStreamingCarets();
              // v4.0: Products already rendered. Just clean up state.
              currentAssistantMsg = null;
              activeBubbleEl = null;
              fullText = '';
              currentTurnGridEl = null;
            }

            if (data.type === 'error') {
              this.removeThinking();
              this.flushStreamRender();
              this.addError(data.error || 'Something went wrong on our side.', { retry: true });
            }
          }
        }

        this.removeThinking();
        this.flushStreamRender();
        this.stopStreamingCarets();
      } catch (err) {
        this.removeThinking();
        this.flushStreamRender();
        this.stopStreamingCarets();
        console.error('❌ Chat error:', err);
        if (err.userMessage) this.addError(err.userMessage);
        else this.addError("Couldn't reach TIA. Check your connection and try again.", { retry: true });
      }
    },

    /** Coalesce streamed chunks into one DOM write per animation frame. */
    queueStreamRender(el, text) {
      this._stream = { el, text };
      if (this._streamFrame) return;
      this._streamFrame = requestAnimationFrame(() => {
        this._streamFrame = 0;
        this.flushStreamRender();
      });
    },

    flushStreamRender() {
      if (this._streamFrame) {
        cancelAnimationFrame(this._streamFrame);
        this._streamFrame = 0;
      }
      const job = this._stream;
      if (!job) return;
      this._stream = null;
      job.el.innerHTML = this.parseMarkdown(job.text);
      this.scrollToBottom();
    },

    /** Error row: icon, message and (for network / server errors) a Retry button. */
    addError(text, { retry = false } = {}) {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'shop-ai-message assistant is-error tia-enter';
      msgDiv.setAttribute('role', 'alert');
      msgDiv.appendChild(avatarEl());
      const row = document.createElement('div');
      row.className = 'shop-ai-error';
      row.innerHTML = `${icon('alert', 'sm')}<span class="shop-ai-error-text"></span>`;
      row.querySelector('.shop-ai-error-text').textContent = text;
      if (retry && this.state.lastRequest) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'shop-ai-retry';
        btn.textContent = 'Retry';
        btn.addEventListener('click', () => {
          msgDiv.remove();
          this.send(null, { retry: true });
        }, { once: true });
        row.appendChild(btn);
      }
      msgDiv.appendChild(row);
      this.elements.messages?.appendChild(msgDiv);
      this.scrollToBottom({ force: true });
      return msgDiv;
    },

    addMessage(content, role, opts = {}) {
      const msgDiv = document.createElement('div');
      msgDiv.className = `shop-ai-message ${role} tia-enter`;

      const bubble = document.createElement('div');
      bubble.className = 'shop-ai-bubble';

      if (role === 'assistant') {
        msgDiv.appendChild(avatarEl());
        bubble.innerHTML = this.parseMarkdown(content);
        msgDiv.appendChild(bubble);
      } else {
        // History stores photos as "[Photo: brand · part · type] caption" — show a chip instead.
        let text = String(content || '');
        let photoLabel = null;
        const marker = PHOTO_MARKER_RE.exec(text);
        if (marker) {
          photoLabel = (marker[1] || '').trim() || 'Photo';
          text = text.slice(marker[0].length);
        }

        if (opts.imageUrl) {
          const photo = document.createElement('img');
          photo.className = 'shop-ai-user-photo';
          photo.src = opts.imageUrl;
          photo.alt = 'Photo you sent';
          photo.addEventListener('load', () => this.scrollToBottom({ force: true }), { once: true });
          msgDiv.appendChild(photo);
        } else if (photoLabel) {
          const chip = document.createElement('div');
          chip.className = 'shop-ai-photo-chip';
          chip.innerHTML = icon('camera', 'xs');
          const label = document.createElement('span');
          label.textContent = photoLabel;
          chip.appendChild(label);
          msgDiv.appendChild(chip);
        }

        if (text.trim()) {
          bubble.textContent = text;
          msgDiv.appendChild(bubble);
        }
      }
      this.elements.messages?.appendChild(msgDiv);
      this.scrollToBottom({ force: role === 'user' });
      return msgDiv;
    },

    updateSendState() {
      const hasText = !!this.elements.input?.value?.trim();
      const ready = (hasText || !!this.state.pendingImage) && !this.state.isPreparingImage;
      this.elements.sendBtn?.classList.toggle('active', ready);
    },

    async handleImageFile(file) {
      if (!file || this.state.isPreparingImage) return;
      if (!file.type.startsWith('image/')) {
        this.addError('Please attach a photo (JPG, PNG or WebP).');
        return;
      }
      if (file.size > PHOTO_MAX_SOURCE_BYTES) {
        this.addError('That photo is too large — please pick one under 25 MB.');
        return;
      }

      this.state.isPreparingImage = true;
      this.renderImagePreview(null, true);
      this.updateSendState();
      try {
        this.state.pendingImage = await preparePhoto(file);
        this.renderImagePreview(this.state.pendingImage.dataUrl, false);
      } catch (err) {
        console.warn('Photo could not be read:', err);
        this.state.pendingImage = null;
        this.renderImagePreview(null, false);
        this.addError("I couldn't open that photo. Please try a JPG or PNG — on iPhone, a screenshot of the photo works too.");
      } finally {
        this.state.isPreparingImage = false;
        this.updateSendState();
        this.elements.input?.focus();
      }
    },

    renderImagePreview(dataUrl, loading) {
      const preview = this.elements.imagePreview;
      if (!preview) return;
      if (!dataUrl && !loading) {
        preview.hidden = true;
        preview.innerHTML = '';
        return;
      }
      preview.hidden = false;
      preview.innerHTML = `
        <div class="shop-ai-image-preview-thumb">
          ${dataUrl ? '<img alt="Photo to send">' : '<span class="shop-ai-image-preview-spinner" aria-hidden="true"></span>'}
        </div>
        <div class="shop-ai-image-preview-text" aria-live="polite">
          <span class="shop-ai-image-preview-title">${loading ? 'Preparing photo' : 'Photo attached'}</span>
          <span class="shop-ai-image-preview-hint">${loading ? 'Resizing for upload' : 'Add a question, or press Enter to send'}</span>
        </div>
        ${loading ? '' : `<button type="button" class="shop-ai-image-preview-remove tia-press" data-image-action="remove" aria-label="Remove photo">${icon('x', 'sm')}</button>`}
      `;
      if (dataUrl) preview.querySelector('img').src = dataUrl;
    },

    clearPendingImage() {
      this.state.pendingImage = null;
      this.renderImagePreview(null, false);
      this.updateSendState();
    },

    parseMarkdown(text) {
      if (!text || typeof text !== 'string') return '<p></p>';

      let cleaned = text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
          (_m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);

      const html = cleaned
        .split('\n')
        .filter(line => line.trim())
        .join('<br>');

      return `<p>${html}</p>`;
    },

    showThinking(initialText) {
      if (this.state.isThinking) return;
      this.state.isThinking = true;

      const container = document.createElement('div');
      container.id = 'shop-ai-thinking';
      container.className = 'shop-ai-thinking-container tia-enter';
      container.setAttribute('role', 'status');
      container.appendChild(avatarEl());
      container.insertAdjacentHTML(
        'beforeend',
        '<span class="shop-ai-thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span>' +
          '<span class="shop-ai-thinking-label"><span class="shop-ai-thinking-text"></span></span>'
      );
      container.querySelector('.shop-ai-thinking-text').textContent = this.thinkingLabel(initialText);

      this.elements.messages?.appendChild(container);
      this.scrollToBottom();
    },

    thinkingLabel(state) {
      return THINKING_LABELS[state] || String(state || 'Thinking').replace(/\.+$/, '');
    },

    /**
     * Live status line, driven by the server's thinking_state events. The old label slides out
     * and the new one slides in (transform + opacity); both share one grid cell, so the row
     * never changes height.
     */
    updateThinkingState(state) {
      const label = this.thinkingLabel(state);
      const holder = document.querySelector('#shop-ai-thinking .shop-ai-thinking-label');
      if (!holder) return this.showThinking(label);
      const current = holder.querySelector('.shop-ai-thinking-text:not(.is-leaving)');
      if (current && current.textContent === label) return;
      if (current) {
        current.classList.add('is-leaving');
        current.addEventListener('animationend', () => current.remove(), { once: true });
        setTimeout(() => current.remove(), 400); // reduced motion / no animation events
      }
      const next = document.createElement('span');
      next.className = 'shop-ai-thinking-text is-entering';
      next.textContent = label;
      holder.appendChild(next);
    },

    removeThinking() {
      clearInterval(this.state.thinkingInterval);
      this.state.thinkingInterval = null;
      const ui = document.getElementById('shop-ai-thinking');
      if (ui) ui.remove();
      this.state.isThinking = false;
    },

    /**
     * Cards carousel, optionally headed by a confidence chip (photo matches send
     * match = { confidence: 'high'|'medium'|'low', label }). Returns the wrapper so a
     * later search in the same turn can replace it.
     */
    renderProductsGrid(products, match = null) {
      if (!products || !products.length) return null;


      const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
      const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');

      const wrapper = document.createElement('div');
      wrapper.className = 'shop-ai-results';

      // 'none' = closest catalogue products, not a confirmed match (shown with a neutral chip).
      const confidence = match && ['high', 'medium', 'low', 'none'].includes(match.confidence) ? match.confidence : null;
      const head = document.createElement('div');
      head.className = 'shop-ai-results-head';
      const count = document.createElement('span');
      count.textContent = `${products.length} ${products.length === 1 ? 'product' : 'products'}`;
      head.appendChild(count);
      if (confidence) {
        const sep = document.createElement('span');
        sep.className = 'shop-ai-results-sep';
        sep.setAttribute('aria-hidden', 'true');
        const chip = document.createElement('span');
        chip.className = `shop-ai-match is-${confidence}`;
        chip.textContent =
          match.label || { high: 'Strong match', medium: 'Likely match', low: 'Possible matches' }[confidence];
        head.append(sep, chip);
      }
      wrapper.appendChild(head);

      const container = document.createElement('div');
      container.className = 'shop-ai-product-grid';
      container.setAttribute('role', 'list');

      products.forEach((prod, idx) => {
        const productId = String(prod.id || `prod-${idx}`);
        this.state.productDataMap.set(productId, prod);

        const card = document.createElement('div');
        card.className = 'shop-ai-product-card';
        card.dataset.productId = productId;
        card.setAttribute('role', 'listitem');
        card.tabIndex = 0;

        const safeTitle = escapeHtml(prod.title || 'Untitled');
        const safeSku = escapeHtml(prod.sku || '');
        const url = safeUrl(prod.url);

        const media = document.createElement('div');
        media.className = 'shop-ai-product-media';
        media.appendChild(buildProductImage(prod.image_url, prod.title || 'Product', 'shop-ai-product-image-wrap'));
        // Best match badge: first card of a confident photo match, else the card's own label.
        // Photo matches label every card ("Best match", "Possible match"); plain searches only the
        // first card of a confident match.
        const PHOTO_BADGES = { 'Exact part number': 'Exact match', 'Best match': 'Best match', 'Possible match': 'Possible match' };
        const badgeText = confidence
          ? PHOTO_BADGES[prod.match_label] || (idx === 0 && (confidence === 'high' || confidence === 'medium') ? 'Best match' : null)
          : null;
        if (badgeText) {
          const badge = document.createElement('span');
          badge.className = `shop-ai-badge${badgeText === 'Best match' || badgeText === 'Exact match' ? ' is-best' : ''}`;
          badge.textContent = badgeText;
          media.appendChild(badge);
        }
        card.appendChild(media);

        const infoDiv = document.createElement('div');
        infoDiv.className = 'shop-ai-product-info';
        infoDiv.innerHTML = `
          <h4 class="shop-ai-product-title" title="${safeTitle}">${safeTitle}</h4>
          ${safeSku ? `<div class="shop-ai-product-sku" title="Part number">${safeSku}</div>` : ''}
          <div class="shop-ai-product-foot">
            <span class="shop-ai-product-price${prod.price ? '' : ' is-empty'}">${prod.price ? escapeHtml(prod.price) : 'Price on request'}</span>
            ${url ? `<a class="shop-ai-product-link tia-press" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="View ${safeTitle} on the store" title="View on the store">${icon('arrowUpRight', 'sm')}</a>` : ''}
          </div>
        `;
        card.appendChild(infoDiv);

        // The "View" link opens the product page; anywhere else on the card opens the details.
        infoDiv.querySelector('.shop-ai-product-link')?.addEventListener('click', (e) => e.stopPropagation());
        card.addEventListener('click', () => this.handleOpenProductModal(productId));
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.handleOpenProductModal(productId);
          }
        });

        container.appendChild(card);
      });

      wrapper.appendChild(container);
      wrapper.classList.add('tia-enter');
      this.elements.messages?.appendChild(wrapper);
      this.scrollToBottom();
      return wrapper;
    },

    stopStreamingCarets() {
      this.elements.messages?.querySelectorAll('.is-streaming').forEach((el) => el.classList.remove('is-streaming'));
    },

    handleOpenProductModal(productId) {
      const product = this.state.productDataMap.get(productId);
      if (!product) return;

      this.handleCloseProductModal();

      const overlay = document.createElement('div');
      overlay.id = 'shop-ai-product-modal';
      overlay.className = 'shop-ai-product-modal-overlay';

      const isAdded = this.state.addedByProductId[productId] === true;
      const safeTitle = (product.title || 'Product').replace(/"/g, '&quot;');

      let rawDesc = product.description;
      if (typeof rawDesc !== 'string') {
        rawDesc = (rawDesc && typeof rawDesc === 'object')
          ? (rawDesc.value || rawDesc.text || rawDesc.html || rawDesc.content || '')
          : '';
      }
      const safeDescription = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      const escapeHtmlAttr = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));

      overlay.innerHTML = `
        <div class="shop-ai-product-modal" role="dialog" aria-modal="true" aria-label="${escapeHtmlAttr(product.title || 'Product details')}">
          <button type="button" class="shop-ai-product-modal-close tia-press" data-product-action="modal-close" aria-label="Close details">${icon('x')}</button>

          <div class="shop-ai-product-modal-left" id="shop-ai-modal-img-slot"></div>

          <div class="shop-ai-product-modal-right">
            <div class="shop-ai-product-modal-title">${escapeHtmlAttr(product.title || 'Product')}</div>
            <div class="shop-ai-product-modal-price">${escapeHtmlAttr(product.price || 'Price on request')}</div>
            ${product.sku ? `<div class="shop-ai-product-modal-sku"><span class="shop-ai-sku-label">Part no.</span> ${escapeHtmlAttr(product.sku)}</div>` : ''}
            ${safeDescription ? `<div class="shop-ai-product-modal-description">${escapeHtmlAttr(safeDescription)}</div>` : ''}

            <div class="shop-ai-product-modal-actions">
              ${product.url ? `<a href="${escapeHtmlAttr(product.url)}" target="_blank" rel="noopener noreferrer" class="shop-ai-product-modal-secondary">View on store</a>` : ''}
              ${(product.variant_id || product.merchandise_id) ? `<button class="shop-ai-product-modal-primary"
                data-product-action="${isAdded ? 'go-to-cart' : 'add-to-cart'}"
                data-product-id="${productId}">
                ${isAdded ? 'Go to Cart' : 'Add to Cart'}
              </button>` : ''}
            </div>
          </div>
        </div>
      `;

      const imgSlot = overlay.querySelector('#shop-ai-modal-img-slot');
      if (imgSlot) {
        const modalImg = buildProductImage(product.image_url, safeTitle, 'shop-ai-modal-image-wrap');
        modalImg.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;';
        imgSlot.appendChild(modalImg);
      }

      // Inside the widget root so it picks up the theme tokens (light / dark).
      (this.elements.root || document.body).appendChild(overlay);
      this.state.modalReturnFocus = document.activeElement;
      requestAnimationFrame(() => {
        overlay.classList.add('active');
        overlay.querySelector('.shop-ai-product-modal-close')?.focus({ preventScroll: true });
      });
      this.state.selectedProductModal = overlay;

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this.handleCloseProductModal();
      });
    },

    handleCloseProductModal() {
      if (this.state.selectedProductModal) {
        const m = this.state.selectedProductModal;
        m.classList.remove('active');
        this.state.selectedProductModal = null;
        setTimeout(() => m.remove(), 250);
        const back = this.state.modalReturnFocus;
        this.state.modalReturnFocus = null;
        if (back && document.contains(back)) back.focus({ preventScroll: true });
      }
    },

    handleViewProduct(productId) {
      const product = this.state.productDataMap.get(productId);
      if (!product) return;

      const url = product.url || product.product_url;
      if (!url) {
        alert('Product page link not available');
        return;
      }

      window.open(url, '_blank');
    },

    async handleAddToCart(productId) {
      if (this.state.isCartUpdating) return;

      const product = this.state.productDataMap.get(productId);
      if (!product) return;

      const variantId = product.variant_id || product.merchandise_id;
      if (!variantId) {
        this.addMessage('Cannot add this product - missing variant.', 'assistant');
        return;
      }

      this.state.isCartUpdating = true;
      const button = document.querySelector(`[data-product-action="add-to-cart"][data-product-id="${productId}"]`);

      if (button) {
        button.textContent = 'Adding…';
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
      }

      try {
        let added = false;

        // 1) Store's own cart. The backend /api/cart creates a separate
        //    Storefront API cart that the theme never sees (cart icon stays 0,
        //    /cart page is empty), so the native Ajax Cart API comes first.
        const numericVariantId = this.toNumericVariantId(variantId);
        if (numericVariantId) {
          try {
            await this.addToNativeCart(numericVariantId, 1);
            this.setCartMode('native');
            added = true;
            this.refreshThemeCart();
          } catch (nativeErr) {
            // 422 = Shopify refused the item (sold out, qty limit…). The
            // headless cart would refuse it too, so show the reason instead.
            if (nativeErr.status === 422) {
              throw Object.assign(new Error(nativeErr.message), { userMessage: nativeErr.message });
            }
            console.warn('Native cart add failed, falling back to app cart:', nativeErr);
          }
        }

        // 2) Fallback: backend Storefront API cart (pages without the Online
        //    Store cart, e.g. a headless/custom page).
        if (!added) {
          const data = await this.addToHeadlessCart(variantId, 1);
          this.updateCheckoutState(data.checkoutUrl, data.cartId);
          this.setCartMode('headless');
        }

        this.state.addedByProductId[productId] = true;
        sessionStorage.setItem('shopAiAddedByProductId', JSON.stringify(this.state.addedByProductId));

        document.querySelectorAll(`[data-product-id="${productId}"]`).forEach(btn => {
          if (btn.dataset.productAction === 'add-to-cart') {
            btn.textContent = 'Go to Cart';
            btn.dataset.productAction = 'go-to-cart';
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
          }
        });

        this.addMessage('Added to your cart. Use **Go to Cart** to review it and check out.', 'assistant');
      } catch (err) {
        console.error('❌ Add to cart error:', err);
        if (button) {
          button.textContent = 'Add to Cart';
          button.disabled = false;
          button.removeAttribute('aria-busy');
        }
        this.addMessage(
          err.userMessage
            ? `Could not add to cart: ${err.userMessage}`
            : 'Could not add to cart. Please try again.',
          'assistant'
        );
      } finally {
        this.state.isCartUpdating = false;
      }
    },

    // "gid://shopify/ProductVariant/123" → "123" (the Ajax Cart API needs the numeric ID)
    toNumericVariantId(variantId) {
      const match = String(variantId || '').match(/(\d+)\s*$/);
      return match ? match[1] : null;
    },

    getStoreRoot() {
      let root = window.shopChatConfig?.rootUrl || window.Shopify?.routes?.root || '/';
      if (!root.endsWith('/')) root += '/';
      return root;
    },

    getCartPageUrl() {
      return window.shopChatConfig?.cartPageUrl || `${this.getStoreRoot()}cart`;
    },

    async addToNativeCart(numericVariantId, quantity) {
      const url = window.shopChatConfig?.cartAddUrl
        ? `${window.shopChatConfig.cartAddUrl}.js`
        : `${this.getStoreRoot()}cart/add.js`;

      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ items: [{ id: Number(numericVariantId), quantity }] }),
      });

      let data = null;
      try { data = await response.json(); } catch (_) { /* non-JSON (e.g. 404 page) */ }

      if (!response.ok || !data || data.status) {
        const message = (data && (data.description || data.message)) || `HTTP ${response.status}`;
        const error = new Error(message);
        error.status = (data && data.status) || response.status;
        throw error;
      }
      return data;
    },

    async addToHeadlessCart(variantId, quantity) {
      const cartApiUrl = window.shopChatConfig?.cartUrl ||
        (window.shopChatConfig?.apiUrl || '/chat').replace('/chat', '/api/cart');

      const response = await fetch(cartApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantId,
          quantity,
          cartId: this.state.cartMode === 'headless' ? this.state.cartId : null,
          conversationId: this.state.conversationId,
          shop_domain: window.shopChatConfig?.shopDomain || ''
        })
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      if (data.status !== 'success' || !data.checkoutUrl || !data.cartId) {
        throw new Error(data.message || 'Failed to add to cart');
      }
      return data;
    },

    setCartMode(mode) {
      this.state.cartMode = mode;
      sessionStorage.setItem('shopAiCartMode', mode);
    },

    // Best-effort: update the theme's cart icon count / drawer without a reload.
    async refreshThemeCart() {
      try {
        const root = this.getStoreRoot();

        // Dawn-family themes: re-render the cart icon bubble and cart drawer sections.
        const sectionsRes = await fetch(`${root}?sections=cart-icon-bubble,cart-drawer`, {
          credentials: 'same-origin',
        });
        if (sectionsRes.ok) {
          const sections = await sectionsRes.json().catch(() => null);
          if (sections) this.applyThemeSections(sections);
        }

        // Generic count badges used by many themes.
        const cartRes = await fetch(`${root}cart.js`, {
          credentials: 'same-origin',
          headers: { 'Accept': 'application/json' },
        });
        const cart = cartRes.ok ? await cartRes.json().catch(() => null) : null;
        if (cart && typeof cart.item_count === 'number') {
          document.querySelectorAll('[data-cart-count], .cart-count, .cart-count-bubble span[aria-hidden="true"]')
            .forEach(el => { el.textContent = String(cart.item_count); });
        }

        // Notify the theme (Dawn pub/sub + common custom events).
        // Dawn declares PUB_SUB_EVENTS with `const`, so it is a global binding
        // but not a window property.
        const pubSubEvents = typeof PUB_SUB_EVENTS !== 'undefined' ? PUB_SUB_EVENTS : window.PUB_SUB_EVENTS;
        if (typeof window.publish === 'function' && pubSubEvents?.cartUpdate) {
          window.publish(pubSubEvents.cartUpdate, { source: 'shop-ai-chat', cartData: cart });
        }
        document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true, detail: { cart } }));
        document.dispatchEvent(new CustomEvent('cart:updated', { bubbles: true, detail: { cart } }));
      } catch (err) {
        console.warn('Theme cart refresh skipped:', err);
      }
    },

    applyThemeSections(sections) {
      const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

      if (sections['cart-icon-bubble']) {
        const target = document.getElementById('cart-icon-bubble');
        const source = parse(sections['cart-icon-bubble']).querySelector('.shopify-section');
        if (target && source) target.innerHTML = source.innerHTML;
      }

      if (sections['cart-drawer']) {
        const target = document.getElementById('CartDrawer');
        const source = parse(sections['cart-drawer']).getElementById('CartDrawer');
        if (target && source) {
          target.innerHTML = source.innerHTML;
          target.closest('cart-drawer')?.classList.remove('is-empty');
        }
      }
    },

    handleGoToCart() {
      if (this.state.cartMode === 'native') {
        window.location.href = this.getCartPageUrl();
        return;
      }
      this.openCheckout();
    },

    updateCheckoutState(checkoutUrl, cartId) {
      if (checkoutUrl && checkoutUrl !== this.state.lastCheckoutUrlShown) {
        this.state.checkoutUrl = checkoutUrl;
        this.state.lastCheckoutUrlShown = checkoutUrl;
        sessionStorage.setItem('shopAiCheckoutUrl', checkoutUrl);
      }
      if (cartId) {
        this.state.cartId = cartId;
        sessionStorage.setItem('shopAiCartId', cartId);
      }
    },

    openCheckout() {
      const url = this.state.checkoutUrl;

      if (!url || typeof url !== 'string') {
        console.error('No checkout URL available');
        this.addMessage('Could not open cart.', 'assistant');
        return;
      }

      const safeUrl = String(url).trim();

      if (!safeUrl.startsWith('https://') && !safeUrl.startsWith('http://')) {
        console.error('Invalid protocol:', safeUrl.substring(0, 30));
        this.addMessage('Invalid cart link.', 'assistant');
        return;
      }

      if (!safeUrl.includes('/cart/c/')) {
        console.error('Invalid checkout path:', safeUrl.substring(0, 60));
        this.addMessage('Invalid cart link format.', 'assistant');
        return;
      }

      try {
        window.open(safeUrl, '_blank');
      } catch (err) {
        console.warn('Popup blocked, using redirect');
        window.location.href = safeUrl;
      }
    },

    /**
     * Keep the newest message in view, but only if the reader is already near the bottom
     * (force: their own message, or an error). One scroll write per animation frame.
     */
    scrollToBottom({ force = false } = {}) {
      const m = this.elements.messages;
      if (!m) return;
      if (force) this._stick = true;
      if (this._scrollFrame) return;
      this._scrollFrame = requestAnimationFrame(() => {
        this._scrollFrame = 0;
        if (this._stick !== false) m.scrollTop = m.scrollHeight;
      });
    },

    startNewChat() {
      this.state.addedByProductId = {};
      this.state.cartId = null;
      this.state.checkoutUrl = null;
      this.state.lastCheckoutUrlShown = null;
      this.state.cartMode = null;
      this.state.conversationId = null;
      this.state.isFirstMessage = true;
      this.state.productDataMap.clear();
      this.clearPendingImage();

      sessionStorage.removeItem('shopAiConversationId');
      sessionStorage.removeItem('shopAiCartId');
      sessionStorage.removeItem('shopAiCheckoutUrl');
      sessionStorage.removeItem('shopAiCartMode');
      sessionStorage.removeItem('shopAiAddedByProductId');

      if (this.elements.messages) {
        this.elements.messages.innerHTML = '';
      }

      if (this.elements.suggestions) {
        this.elements.suggestions.style.display = '';
        this.elements.messages?.appendChild(this.elements.suggestions);
        this.elements.suggestions.classList.add('visible');
      }

      if (this.elements.input) {
        this.elements.input.value = '';
        this.elements.input.style.height = 'auto';
        this.elements.input.focus();
      }
      if (this.elements.sendBtn) {
        this.elements.sendBtn.classList.remove('active');
      }
    },

    openHistory() {
      this.elements.historyPanel?.classList.add('active');
      this.renderHistoryList();
    },

    closeHistory() {
      this.elements.historyPanel?.classList.remove('active');
    },

    renderHistoryList() {
      const list = this.elements.historyList;
      if (!list) return;

      const history = JSON.parse(localStorage.getItem('shopAiChatHistory') || '[]');

      if (!history.length) {
        list.innerHTML = `<div class="shop-ai-history-empty">${icon('message')}<span>No previous chats yet</span></div>`;
        return;
      }

      list.innerHTML = '';
      history.forEach(conv => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'shop-ai-history-item tia-press';

        const timeStr = conv.timestamp
          ? new Date(conv.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '';

        item.innerHTML = '<div class="shop-ai-history-item-title"></div><div class="shop-ai-history-item-time"></div>';
        item.firstChild.textContent = conv.title || 'Conversation';
        item.lastChild.textContent = timeStr;

        item.addEventListener('click', () => this.loadConversation(conv.id));
        list.appendChild(item);
      });
    },

    /** Greeting + suggestion chips (also used when a restored chat can't be loaded). */
    showWelcome() {
      const sugg = this.elements.suggestions;
      if (!sugg) return;
      sugg.style.display = '';
      if (!sugg.parentNode) this.elements.messages?.appendChild(sugg);
      sugg.classList.add('visible');
    },

    /** quiet: used when re-opening after a page reload — on failure fall back to the greeting. */
    async loadConversation(conversationId, { quiet = false } = {}) {
      this.closeHistory();

      if (this.elements.messages) {
        this.elements.messages.innerHTML = '';
      }

      this.state.conversationId = conversationId;
      this.state.isFirstMessage = false;
      sessionStorage.setItem('shopAiConversationId', conversationId);

      if (this.elements.suggestions) {
        this.elements.suggestions.classList.remove('visible');
        this.elements.suggestions.style.display = 'none';
      }

      this.showThinking('Loading conversation...');

      try {
        const apiUrl = window.shopChatConfig?.apiUrl;
        if (!apiUrl) throw new Error('API URL not configured');

        const historyUrl = `${apiUrl}?history=true&conversation_id=${encodeURIComponent(conversationId)}`;
        const response = await fetch(historyUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        this.removeThinking();

        if (data.messages && data.messages.length) {
          data.messages.forEach(msg => {
            if (msg.role === 'user' || msg.role === 'assistant') {
              const content = typeof msg.content === 'string' ? msg.content.replace(CARDS_MARKER_RE, '') : '';
              if (content) this.addMessage(content, msg.role);
            }
          });
          this.scrollToBottom();
        } else if (quiet) {
          this.showWelcome();
        } else {
          this.addMessage('This conversation has no messages.', 'assistant');
        }
      } catch (err) {
        this.removeThinking();
        console.error('Failed to load conversation:', err);
        if (quiet) this.showWelcome();
        else this.addMessage('Could not load conversation history.', 'assistant');
      }
    },

    saveToHistory(firstMessage) {
      if (!this.state.conversationId) return;

      const history = JSON.parse(localStorage.getItem('shopAiChatHistory') || '[]');

      if (history.some(h => h.id === this.state.conversationId)) return;

      history.unshift({
        id: this.state.conversationId,
        title: (firstMessage || 'Chat').substring(0, 60),
        timestamp: Date.now(),
      });

      if (history.length > 30) history.length = 30;

      localStorage.setItem('shopAiChatHistory', JSON.stringify(history));
    },

    restoreState() {
      if (this.state.conversationId) {
        this.state.isFirstMessage = false;
        // The page was reloaded mid-conversation: bring the messages back on first open.
        this.state.needsRestore = true;
        if (this.elements.suggestions) {
          this.elements.suggestions.classList.remove('visible');
          this.elements.suggestions.style.display = 'none';
        }
      }
    },

    openAndSend(message) {
      if (!this.state.isOpen) {
        this.open();
      }
      if (typeof message === 'string' && message.trim()) {
        setTimeout(() => this.send(message), 150);
      }
    },

    exposeAPI() {
      window.ShopAIChat = this;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ShopAIChat.init());
  } else {
    ShopAIChat.init();
  }

  window.ShopAIChat = ShopAIChat;
})();
