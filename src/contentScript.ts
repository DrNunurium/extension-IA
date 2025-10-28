// Note: chrome types come from @types/chrome; don't redeclare `chrome` here to avoid conflicts.

// Reglas y heurísticas para detectar mensajes en distintas UIs (ChatGPT, Gemini, etc.).
// Flujo:
// 1) Intentamos selectores específicos para la plataforma (más precisos).
// 2) Si no se encuentran candidatos por selectores, usamos la heurística general.
const BUTTON_CLASS = 'ai-chat-knowledge-organizer-save';
const BUTTON_LABEL = 'Guardar Datos';
const MIN_TEXT_LENGTH = 60; // mínimo número de caracteres para considerar un node como mensaje (reducción de falsos positivos)
const MIN_PARAGRAPH_LENGTH = 30; // mínimo para considerar un párrafo como candidato a botón

type ChatMessageElement = HTMLElement & { dataset: { messageId?: string; sourceId?: string } };

const seenElements = new WeakSet<HTMLElement>();

// Platform-specific selector sets (prioritized). These are best-effort and may need
// refinement for the exact DOM of each UI. We try them first for accuracy.
const PLATFORM_SELECTORS: Record<string, { hosts: string[]; selectors: string[] }> = {
  chatgpt: {
    hosts: ['chat.openai.com'],
    selectors: [
      // common ChatGPT message container patterns (may change over time)
      'div[data-testid="message"]',
      'div[class*="message"]',
      'div[class*="group"] > div[class*="flex"]'
    ]
  },
  gemini: {
    hosts: ['gemini.google.com', 'ai.google.com', 'assistant.google.com'],
    selectors: [
      // generic patterns that might match assistant responses in Google UIs
      'div[class*="assistant-response"]',
      'gc-message',
      'div[class*="response"]'
    ]
  }
};

// Optional selectors to identify the main chat container for each platform.
const PLATFORM_CHAT_CONTAINERS: Record<string, string[]> = {
  chatgpt: [
    'main',
    'div[class*="chat"]',
    '#chat-panel',
    'div[class*="conversation"]'
  ],
  gemini: [
    'main',
    'gc-message-list',
    'div[class*="assistant"]'
  ]
};

function detectPlatform(): string | null {
  const host = window.location.host || '';
  for (const [platform, cfg] of Object.entries(PLATFORM_SELECTORS)) {
    if (cfg.hosts.some((h) => host.includes(h))) return platform;
  }

  // Fallback: detect by presence of selector nodes in the DOM
  for (const [platform, cfg] of Object.entries(PLATFORM_SELECTORS)) {
    for (const sel of cfg.selectors) {
      try {
        if (document.querySelector(sel)) return platform;
      } catch (_) {
        // ignore invalid selectors
      }
    }
  }

  return null;
}

function tryPlatformSelectors(root: ParentNode): boolean {
  const platform = detectPlatform();
  if (!platform) return false;
  const cfg = PLATFORM_SELECTORS[platform];
  let found = false;
  for (const sel of cfg.selectors) {
    let nodes: NodeListOf<HTMLElement> | null = null;
    try {
      nodes = root.querySelectorAll?.(sel) as NodeListOf<HTMLElement> | null;
    } catch (_) {
      nodes = null;
    }
    if (!nodes) continue;
    nodes.forEach((el) => {
      if (containsSignificantText(el) && !isInteractive(el) && isInsideChatWindow(el)) {
        injectSaveButton(el as ChatMessageElement);
        found = true;
      }
    });
  }
  return found;
}

function isInsideChatWindow(el: Element): boolean {
  // Check platform-specific containers first
  const platform = detectPlatform();
  const containers = platform ? PLATFORM_CHAT_CONTAINERS[platform] || [] : [];
  for (const sel of containers) {
    try {
      const ancestor = el.closest(sel);
      if (ancestor) return true;
    } catch (_) { /* ignore invalid selectors */ }
  }

  // Fallback: prefer elements within role=main or aria-label that mentions "chat" or "conversation"
  const mainAncestor = el.closest('[role="main"], main');
  if (mainAncestor) {
    const aria = (mainAncestor.getAttribute('aria-label') || '').toLowerCase();
    if (aria.includes('chat') || aria.includes('conversation') || aria.includes('assistant')) return true;
  }

  // If nothing else, check that the page contains a visible element that looks like the chat area
  const maybeChat = document.querySelector('main, #chat, [aria-label*="chat"]');
  if (maybeChat && maybeChat.contains(el)) return true;

  return false;
}

function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (['button', 'input', 'textarea', 'select', 'a'].includes(tag)) return true;
  const role = el.getAttribute('role');
  if (role === 'button' || role === 'link') return true;
  return false;
}

function containsSignificantText(el: HTMLElement): boolean {
  const text = (el.textContent || '').trim();
  return text.length >= MIN_TEXT_LENGTH;
}

function findMessageCandidates(root: ParentNode): HTMLElement[] {
  const results: HTMLElement[] = [];

  // strategy: get descendant elements that have significant text and are not interactive
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const el = node as HTMLElement;
      if (isInteractive(el)) return NodeFilter.FILTER_REJECT;
      if (!containsSignificantText(el)) return NodeFilter.FILTER_SKIP;
      // avoid extremely large containers (like entire page)
      if ((el.textContent || '').length > 2000) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node = walker.nextNode() as HTMLElement | null;
  while (node) {
    results.push(node);
    node = walker.nextNode() as HTMLElement | null;
  }

  return results;
}

function injectSaveButton(messageEl: ChatMessageElement): void {
  // We add one small floating button per paragraph inside the message element.
  // This avoids many buttons in the middle of text and mimics the "copy" buttons UI.
  const existingSourceId = messageEl.dataset.sourceId || messageEl.dataset.messageId;
  const sourceId = existingSourceId ?? (crypto && (crypto as any).randomUUID ? (crypto as any).randomUUID() : Date.now().toString());
  try { messageEl.dataset.sourceId = sourceId; } catch (_) { }

  // find block-level paragraph candidates inside the message
  const paragraphSelectors = ['p', 'div > p', 'li'];
  const paragraphs: HTMLElement[] = [];
  for (const sel of paragraphSelectors) {
    try {
      const nodes = Array.from(messageEl.querySelectorAll<HTMLElement>(sel));
      for (const n of nodes) {
        const txt = (n.textContent || '').trim();
        if (txt.length >= MIN_PARAGRAPH_LENGTH && !isInteractive(n)) paragraphs.push(n);
      }
    } catch (_) { /* ignore bad selectors */ }
  }

  // If we found no paragraphs, fall back to using the message element itself (single button)
  if (paragraphs.length === 0) {
    if (seenElements.has(messageEl)) return;
    seenElements.add(messageEl);
    // capture message text before injecting the button so UI elements don't pollute it
    const messageText = (messageEl.textContent || '').trim();
    const btn = createFloatingButton();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      sendSaveMessage({ type: 'SAVE_CHAT_DATA', payload: { sourceId, messageText, pageUrl: window.location.href } }, btn);
    });
    messageEl.style.position = messageEl.style.position || 'relative';
    messageEl.appendChild(btn);
    return;
  }

  paragraphs.forEach((p, idx) => {
    if (seenElements.has(p)) return;
    if (p.querySelector(`.${BUTTON_CLASS}`)) return;
    seenElements.add(p);
    // ensure paragraph is positioned so absolute button can align to its top-right
    const prevPos = p.style.position;
    if (!prevPos || prevPos === '') p.style.position = 'relative';

    const paragraphIndex = idx;
    // capture paragraph text before injecting the button to avoid including the button label/icon
    const paragraphText = (p.textContent || '').trim();
    const btn = createFloatingButton();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      sendSaveMessage({ type: 'SAVE_CHAT_DATA', payload: { sourceId, messageText: paragraphText, pageUrl: window.location.href, paragraphIndex } }, btn);
    });
    p.appendChild(btn);
  });
}

function createFloatingButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = BUTTON_CLASS;
  button.textContent = '💾'; // small icon-like label
  button.title = BUTTON_LABEL;
  button.type = 'button';
  Object.assign(button.style, {
    position: 'absolute',
    right: '0px',
    top: '6px',
    transform: 'translateX(100%)', // move the button to the right outside the paragraph box
    padding: '4px 6px',
    fontSize: '12px',
    borderRadius: '6px',
    border: 'none',
    background: 'rgba(0,0,0,0.06)',
    cursor: 'pointer',
    opacity: '0.4',
    transition: 'opacity 120ms ease'
  } as CSSStyleDeclaration);
  button.addEventListener('mouseover', () => { button.style.opacity = '1'; });
  button.addEventListener('mouseout', () => { button.style.opacity = '0.4'; });
  // click handler is attached by caller so we don't close over UI state here
  return button;
}

function sendSaveMessage(message: any, button: HTMLButtonElement) {
  try {
    button.disabled = true;
    const prev = button.textContent;
    button.textContent = '...';
    button.style.opacity = '1';

    chrome.runtime.sendMessage(message, (response: any) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        console.error('sendMessage error', lastError);
        button.textContent = '!';
        setTimeout(() => { button.textContent = '💾'; button.disabled = false; button.style.opacity = '0.4'; }, 1200);
        return;
      }

      if (response && response.ok) {
        button.textContent = '✓';
        // optional: animate or flash
        setTimeout(() => { button.textContent = '💾'; button.disabled = false; button.style.opacity = '0.4'; }, 1200);
      } else {
        button.textContent = '!';
        setTimeout(() => { button.textContent = '💾'; button.disabled = false; button.style.opacity = '0.4'; }, 1200);
      }
    });
  } catch (err) {
    console.error('Failed to send save message', err);
    button.textContent = '!';
    setTimeout(() => { button.textContent = '💾'; button.disabled = false; button.style.opacity = '0.4'; }, 1200);
  }
}

function processExistingMessages(root: ParentNode): void {
  // Try platform-specific selectors first for higher precision
  const usedPlatform = tryPlatformSelectors(root);
  if (usedPlatform) return;

  // Fallback to general heuristic
  const candidates = findMessageCandidates(root);
  candidates.forEach((el) => injectSaveButton(el as ChatMessageElement));
}

function beginObserving(): void {
  processExistingMessages(document);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        // First try platform selectors on the added node (high precision)
        const foundByPlatform = tryPlatformSelectors(node);
        if (!foundByPlatform) {
          // If not found, then fall back to the per-node heuristic
          if (containsSignificantText(node) && !isInteractive(node)) {
            injectSaveButton(node as ChatMessageElement);
          }
          processExistingMessages(node);
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', beginObserving, { once: true });
} else {
  beginObserving();
}

/*
Notes sobre selectores y la heurística:
- Un "selector" (query selector) es una cadena como '.mensaje' o '#chat > div' que indica
  cómo encontrar elementos en el DOM. Antes usábamos un selector fijo como '[data-message-id]'.
- En lugar de depender de un selector fijo (que puede variar entre ChatGPT y Gemini),
  esta heurística busca nodos añadidos con texto significativo y evita inputs/botones.
- Esto suele funcionar en múltiples UIs, pero puede necesitar ajustes específicos para
  cada página si su DOM es muy particular. Si quieres, puedo añadir reglas específicas
  para ChatGPT y Gemini basadas en selectores concretos si me confirmas que quieres
  priorizar precisión sobre generalidad.
*/
