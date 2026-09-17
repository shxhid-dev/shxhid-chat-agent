/**
 * Shopify Chat Agent - Production Ready
 * - Product carousel with click-to-open modal
 * - Auto-expand textarea with smooth placeholder fade
 * - Chat history with conversation loading
 * - Email capture via built-in overlay
 * - SSE streaming with thinking indicators
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

(function () {
  'use strict';

  // ─── Image placeholder SVG ────────────────────────────────────────────────
  const PLACEHOLDER_SVG = `<div class="shop-ai-img-placeholder" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#f5f5f5;border-radius:8px 8px 0 0;"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#c8c8c8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="14" rx="2"/><circle cx="12" cy="13" r="3"/><path d="M9 6l1.5-2h3L15 6"/></svg></div>`;

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
      placeholderIndex: 0,
      chatHistory: JSON.parse(localStorage.getItem('shopAiChatHistory') || '[]'),
      cartId: sessionStorage.getItem('shopAiCartId') || null,
      checkoutUrl: sessionStorage.getItem('shopAiCheckoutUrl') || null,
      selectedProduct: null,
      selectedProductModal: null,
      isCartUpdating: false,
      addedByProductId: JSON.parse(sessionStorage.getItem('shopAiAddedByProductId') || '{}'),
      productDataMap: new Map(),
      lastCheckoutUrlShown: null,
    },

    placeholders: [
      'Ask me anything...',
      'Search for products',
      'What do you need?',
      'Tell me a product name...',
    ],

    elements: {},

    init() {
      this.elements = {
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
      };

      if (!this.elements.modal) {
        console.error('❌ Modal element not found');
        return;
      }

      this.bindEvents();
      this.startPlaceholderRotation();
      this.restoreState();
      this.exposeAPI();

      console.log('ShopAIChat v4.0 initialized');
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
      if (this.elements.backdrop) {
        this.elements.backdrop.addEventListener('click', () => this.close());
      }

      if (this.elements.sendBtn) {
        this.elements.sendBtn.addEventListener('click', () => this.send());
      }
      if (this.elements.input) {
        this.elements.input.addEventListener('keypress', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.send();
          }
        });
        this.elements.input.addEventListener('input', () => {
          const el = this.elements.input;
          el.style.height = 'auto';
          el.style.height = Math.min(el.scrollHeight, 120) + 'px';
          if (this.elements.sendBtn) {
            this.elements.sendBtn.classList.toggle('active', !!el.value.trim());
          }
        });
      }

      if (this.elements.menuBtn) {
        this.elements.menuBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.elements.menuDropdown?.classList.toggle('active');
        });
      }

      if (this.elements.menuDropdown) {
        this.elements.menuDropdown.addEventListener('click', (e) => {
          const item = e.target.closest('[data-action]');
          if (!item) return;
          const action = item.dataset.action;
          this.elements.menuDropdown.classList.remove('active');
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
          this.elements.menuDropdown.classList.remove('active');
        }
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.state.isOpen) this.close();
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

    startPlaceholderRotation() {
      setInterval(() => {
        const input = this.elements.input;
        if (input && !input.value) {
          input.classList.add('placeholder-fade');
          setTimeout(() => {
            this.state.placeholderIndex = (this.state.placeholderIndex + 1) % this.placeholders.length;
            input.placeholder = this.placeholders[this.state.placeholderIndex];
            input.classList.remove('placeholder-fade');
          }, 300);
        }
      }, 4000);
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

      document.body.classList.add('shop-ai-open');
      if (this.elements.floatingGroup) {
        this.elements.floatingGroup.classList.add('hidden');
      }
      this.state.isOpen = true;
      this.elements.input?.focus();
    },

    close() {
      document.body.classList.remove('shop-ai-open');
      if (this.elements.floatingGroup) {
        this.elements.floatingGroup.classList.remove('hidden');
      }
      this.state.isOpen = false;
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

    async send(messageArg) {
      const message = (typeof messageArg === 'string' && messageArg.trim())
        ? messageArg.trim()
        : this.elements.input?.value?.trim();
      if (!message) return;

      if (this.state.isFirstMessage) {
        this.state.isFirstMessage = false;
        if (this.elements.suggestions) {
          this.elements.suggestions.classList.remove('visible');
          this.elements.suggestions.style.display = 'none';
        }
      }

      this.addMessage(message, 'user');
      if (this.elements.input) {
        this.elements.input.value = '';
        this.elements.input.style.height = 'auto';
      }
      if (this.elements.sendBtn) {
        this.elements.sendBtn.classList.remove('active');
      }

      if (!this.state.conversationId) {
        this.state.conversationId = 'conv_' + Date.now();
        sessionStorage.setItem('shopAiConversationId', this.state.conversationId);
      }

      this.saveToHistory(message);
      this.showThinking();

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
            shop_domain: window.shopChatConfig?.shopDomain || ''
          })
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          console.error('❌ API response:', response.status, errorText.substring(0, 200));
          throw new Error(`Server returned ${response.status}`);
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
        // Track whether products were rendered this turn
        let productsRenderedThisTurn = false;

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
                activeBubbleEl.innerHTML = this.parseMarkdown(fullText);
                this.scrollToBottom();
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
                currentTurnGridEl = this.renderProductsGrid(products);
                productsRenderedThisTurn = true;
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
              // v4.0: Products already rendered. Just clean up state.
              currentAssistantMsg = null;
              activeBubbleEl = null;
              fullText = '';
              currentTurnGridEl = null;
              productsRenderedThisTurn = false;
            }

            if (data.type === 'error') {
              this.removeThinking();
              this.addMessage(data.error || 'An error occurred', 'assistant');
            }
          }
        }

        this.removeThinking();
      } catch (err) {
        this.removeThinking();
        console.error('❌ Chat error:', err);
        this.addMessage('Sorry, there was an error. Please try again.', 'assistant');
      }
    },

    addMessage(content, role) {
      const msgDiv = document.createElement('div');
      msgDiv.className = `shop-ai-message ${role}`;

      const bubble = document.createElement('div');
      bubble.className = 'shop-ai-bubble';

      if (role === 'assistant') {
        bubble.innerHTML = this.parseMarkdown(content);
      } else {
        bubble.textContent = content;
      }

      msgDiv.appendChild(bubble);
      this.elements.messages?.appendChild(msgDiv);
      this.scrollToBottom();
      return msgDiv;
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

      const idlePhrases = [
        'Thinking...',
        'Analyzing your request...',
        'Processing...',
        'Working on it...',
      ];

      const container = document.createElement('div');
      container.id = 'shop-ai-thinking';
      container.className = 'shop-ai-thinking-container';
      container.innerHTML =
        '<div class="shop-ai-thinking-dots"><span></span><span></span><span></span></div>' +
        '<span class="shop-ai-thinking-text">' + (initialText || idlePhrases[0]) + '</span>';

      this.elements.messages?.appendChild(container);
      this.scrollToBottom();

      let cycleIdx = 0;
      this.state.thinkingInterval = setInterval(() => {
        cycleIdx = (cycleIdx + 1) % idlePhrases.length;
        const el = document.querySelector('#shop-ai-thinking .shop-ai-thinking-text');
        if (el) {
          el.style.opacity = '0';
          setTimeout(() => {
            if (el.parentNode) {
              el.textContent = idlePhrases[cycleIdx];
              el.style.opacity = '1';
            }
          }, 200);
        }
      }, 2500);
    },

    updateThinkingState(toolText) {
      clearInterval(this.state.thinkingInterval);
      this.state.thinkingInterval = null;

      const toolPhrases = {
        'Searching products...':   ['Searching catalog...', 'Finding best matches...', 'Filtering results...', 'Almost done...'],
        'Adding to cart...':       ['Adding to cart...', 'Preparing your order...', 'Updating basket...', 'Almost done...'],
        'Looking up product...':   ['Looking up product...', 'Fetching details...', 'Checking availability...', 'Almost done...'],
        'Looking up product details...': ['Fetching product details...', 'Loading specs...', 'Checking inventory...', 'Almost done...'],
        'Checking availability...': ['Checking availability...', 'Looking up stock...', 'Verifying details...', 'Almost done...'],
      };

      const phrases = toolPhrases[toolText] || [toolText, 'Processing...', 'Working on it...', 'Almost done...'];

      const el = document.querySelector('#shop-ai-thinking .shop-ai-thinking-text');
      if (el) {
        el.style.opacity = '0';
        setTimeout(() => {
          if (el.parentNode) {
            el.textContent = phrases[0];
            el.style.opacity = '1';
          }
        }, 150);

        let cycleIdx = 0;
        this.state.thinkingInterval = setInterval(() => {
          cycleIdx = (cycleIdx + 1) % phrases.length;
          const el2 = document.querySelector('#shop-ai-thinking .shop-ai-thinking-text');
          if (el2) {
            el2.style.opacity = '0';
            setTimeout(() => {
              if (el2.parentNode) {
                el2.textContent = phrases[cycleIdx];
                el2.style.opacity = '1';
              }
            }, 200);
          }
        }, 2500);
      } else {
        if (!this.state.isThinking) {
          this.showThinking(toolText);
        }
      }
    },

    removeThinking() {
      clearInterval(this.state.thinkingInterval);
      this.state.thinkingInterval = null;
      const ui = document.getElementById('shop-ai-thinking');
      if (ui) ui.remove();
      this.state.isThinking = false;
    },

    renderProductsGrid(products) {
      if (!products || !products.length) return null;

      console.log(`[ShopAIChat] Rendering ${products.length} products as carousel`);

      const container = document.createElement('div');
      container.className = 'shop-ai-product-grid';

      products.forEach((prod, idx) => {
        const productId = String(prod.id || `prod-${idx}`);
        this.state.productDataMap.set(productId, prod);

        const card = document.createElement('div');
        card.className = 'shop-ai-product-card';
        card.dataset.productId = productId;

        const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));

        const safeTitle = escapeHtml(prod.title || 'Untitled');
        const safeSku = escapeHtml(prod.sku || '');
        const safePrice = escapeHtml(prod.price || '');
        const safeAlt = escapeHtml(prod.title || 'Product');

        const imageEl = buildProductImage(prod.image_url, safeAlt, 'shop-ai-product-image-wrap');
        if (imageEl.tagName !== 'IMG') {
          imageEl.className = 'shop-ai-product-image shop-ai-product-image-wrap';
        }
        card.appendChild(imageEl);

        const infoDiv = document.createElement('div');
        infoDiv.className = 'shop-ai-product-info';
        infoDiv.innerHTML = `
          <h4 class="shop-ai-product-title" title="${safeTitle}">${safeTitle}</h4>
          ${safeSku ? `<div class="shop-ai-product-sku">SKU: ${safeSku}</div>` : ''}
          <div class="shop-ai-product-price">${safePrice}</div>
        `;
        card.appendChild(infoDiv);

        card.addEventListener('click', () => {
          this.handleOpenProductModal(productId);
        });

        container.appendChild(card);
      });

      this.elements.messages?.appendChild(container);
      this.scrollToBottom();
      return container;
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
        <div class="shop-ai-product-modal">
          <button class="shop-ai-product-modal-close" data-product-action="modal-close">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>

          <div class="shop-ai-product-modal-left" id="shop-ai-modal-img-slot"></div>

          <div class="shop-ai-product-modal-right">
            <div class="shop-ai-product-modal-title">${escapeHtmlAttr(product.title || 'Product')}</div>
            <div class="shop-ai-product-modal-price">${escapeHtmlAttr(product.price || 'Price on request')}</div>
            ${product.sku ? `<div class="shop-ai-product-modal-sku"><span class="shop-ai-sku-label">SKU</span> ${escapeHtmlAttr(product.sku)}</div>` : ''}
            ${safeDescription ? `<div class="shop-ai-product-modal-description">${escapeHtmlAttr(safeDescription)}</div>` : ''}

            <div class="shop-ai-product-modal-actions">
              ${product.url ? `<a href="${escapeHtmlAttr(product.url)}" target="_blank" rel="noopener noreferrer" class="shop-ai-product-modal-secondary">View on Store</a>` : ''}
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

      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('active'));
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
        setTimeout(() => m.remove(), 300);
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
        button.textContent = 'Adding...';
        button.disabled = true;
      }

      try {
        const cartApiUrl = window.shopChatConfig?.cartUrl ||
          (window.shopChatConfig?.apiUrl || '/chat').replace('/chat', '/api/cart');

        const response = await fetch(cartApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            variantId,
            quantity: 1,
            cartId: this.state.cartId,
            conversationId: this.state.conversationId,
            shop_domain: window.shopChatConfig?.shopDomain || ''
          })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();

        if (data.status === 'success' && data.checkoutUrl && data.cartId) {
          this.state.addedByProductId[productId] = true;
          sessionStorage.setItem('shopAiAddedByProductId', JSON.stringify(this.state.addedByProductId));

          this.updateCheckoutState(data.checkoutUrl, data.cartId);

          document.querySelectorAll(`[data-product-id="${productId}"]`).forEach(btn => {
            if (btn.dataset.productAction === 'add-to-cart') {
              btn.textContent = 'Go to Cart';
              btn.dataset.productAction = 'go-to-cart';
              btn.disabled = false;
            }
          });

          this.addMessage('Added to cart! 🎉', 'assistant');
        } else {
          throw new Error(data.message || 'Failed to add to cart');
        }
      } catch (err) {
        console.error('❌ Add to cart error:', err);
        if (button) {
          button.textContent = 'Add to Cart';
          button.disabled = false;
        }
        this.addMessage('Could not add to cart. Please try again.', 'assistant');
      } finally {
        this.state.isCartUpdating = false;
      }
    },

    handleGoToCart() {
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

    scrollToBottom() {
      if (this.elements.messages) {
        this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
      }
    },

    startNewChat() {
      this.state.addedByProductId = {};
      this.state.cartId = null;
      this.state.checkoutUrl = null;
      this.state.lastCheckoutUrlShown = null;
      this.state.conversationId = null;
      this.state.isFirstMessage = true;
      this.state.productDataMap.clear();

      sessionStorage.removeItem('shopAiConversationId');
      sessionStorage.removeItem('shopAiCartId');
      sessionStorage.removeItem('shopAiCheckoutUrl');
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
        list.innerHTML = '<div class="shop-ai-history-empty">No previous conversations yet</div>';
        return;
      }

      list.innerHTML = '';
      history.forEach(conv => {
        const item = document.createElement('div');
        item.className = 'shop-ai-history-item';

        const timeStr = conv.timestamp
          ? new Date(conv.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '';

        item.innerHTML = `
          <div class="shop-ai-history-item-title">${conv.title || 'Conversation'}</div>
          <div class="shop-ai-history-item-time">${timeStr}</div>
        `;

        item.addEventListener('click', () => this.loadConversation(conv.id));
        list.appendChild(item);
      });
    },

    async loadConversation(conversationId) {
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
              const content = typeof msg.content === 'string' ? msg.content : '';
              if (content) this.addMessage(content, msg.role);
            }
          });
          this.scrollToBottom();
        } else {
          this.addMessage('This conversation has no messages.', 'assistant');
        }
      } catch (err) {
        this.removeThinking();
        console.error('Failed to load conversation:', err);
        this.addMessage('Could not load conversation history.', 'assistant');
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
