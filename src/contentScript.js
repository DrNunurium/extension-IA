// Note: chrome types come from @types/chrome; don't redeclare `chrome` here to avoid conflicts.
// Reglas y heurísticas para detectar mensajes en distintas UIs (ChatGPT, Gemini, etc.).
// Flujo:
// 1) Intentamos selectores específicos para la plataforma (más precisos).
// 2) Si no se encuentran candidatos por selectores, usamos la heurística general.
const BUTTON_CLASS = 'ai-chat-knowledge-organizer-save';
const BUTTON_LABEL = 'Guardar Datos';
const MIN_TEXT_LENGTH = 60; // mínimo número de caracteres para considerar un node como mensaje (reducción de falsos positivos)
const MIN_PARAGRAPH_LENGTH = 30; // mínimo para considerar un párrafo como candidato a botón
const seenElements = new WeakSet();
// Platform-specific selector sets (prioritized). These are best-effort and may need
// refinement for the exact DOM of each UI. We try them first for accuracy.
const PLATFORM_SELECTORS = {
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
const PLATFORM_CHAT_CONTAINERS = {
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
// Allowed hosts (derive from PLATFORM_SELECTORS). If you update PLATFORM_SELECTORS,
// keep this list in sync to avoid accidental injection on other sites.
const ALLOWED_HOSTS = new Set([
    'chat.openai.com',
    'gemini.google.com',
    'ai.google.com',
    'assistant.google.com'
]);
function isAllowedHost() {
    const host = window.location.host || '';
    for (const h of ALLOWED_HOSTS) {
        if (host.includes(h))
            return true;
    }
    return false;
}
function detectPlatform() {
    const host = window.location.host || '';
    for (const [platform, cfg] of Object.entries(PLATFORM_SELECTORS)) {
        if (cfg.hosts.some((h) => host.includes(h)))
            return platform;
    }
    // Fallback: detect by presence of selector nodes in the DOM
    for (const [platform, cfg] of Object.entries(PLATFORM_SELECTORS)) {
        for (const sel of cfg.selectors) {
            try {
                if (document.querySelector(sel))
                    return platform;
            }
            catch (_) {
                // ignore invalid selectors
            }
        }
    }
    return null;
}
function tryPlatformSelectors(root) {
    const platform = detectPlatform();
    if (!platform)
        return false;
    const cfg = PLATFORM_SELECTORS[platform];
    let found = false;
    for (const sel of cfg.selectors) {
        let nodes = null;
        try {
            nodes = root.querySelectorAll?.(sel);
        }
        catch (_) {
            nodes = null;
        }
        if (!nodes)
            continue;
        nodes.forEach((el) => {
            if (containsSignificantText(el) && !isInteractive(el) && isInsideChatWindow(el)) {
                injectSaveButton(el);
                found = true;
            }
        });
    }
    return found;
}
function isInsideChatWindow(el) {
    // Check platform-specific containers first
    const platform = detectPlatform();
    const containers = platform ? PLATFORM_CHAT_CONTAINERS[platform] || [] : [];
    for (const sel of containers) {
        try {
            const ancestor = el.closest(sel);
            if (ancestor)
                return true;
        }
        catch (_) { /* ignore invalid selectors */ }
    }
    // Fallback: prefer elements within role=main or aria-label that mentions "chat" or "conversation"
    const mainAncestor = el.closest('[role="main"], main');
    if (mainAncestor) {
        const aria = (mainAncestor.getAttribute('aria-label') || '').toLowerCase();
        if (aria.includes('chat') || aria.includes('conversation') || aria.includes('assistant'))
            return true;
    }
    // If nothing else, check that the page contains a visible element that looks like the chat area
    const maybeChat = document.querySelector('main, #chat, [aria-label*="chat"]');
    if (maybeChat && maybeChat.contains(el))
        return true;
    return false;
}
function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (['button', 'input', 'textarea', 'select', 'a'].includes(tag))
        return true;
    const role = el.getAttribute('role');
    if (role === 'button' || role === 'link')
        return true;
    return false;
}
function containsSignificantText(el) {
    const text = (el.textContent || '').trim();
    return text.length >= MIN_TEXT_LENGTH;
}
function findMessageCandidates(root) {
    const results = [];
    // strategy: get descendant elements that have significant text and are not interactive
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode(node) {
            const el = node;
            if (isInteractive(el))
                return NodeFilter.FILTER_REJECT;
            if (!containsSignificantText(el))
                return NodeFilter.FILTER_SKIP;
            // avoid extremely large containers (like entire page)
            if ((el.textContent || '').length > 2000)
                return NodeFilter.FILTER_SKIP;
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    let node = walker.nextNode();
    while (node) {
        results.push(node);
        node = walker.nextNode();
    }
    return results;
}
function injectSaveButton(messageEl) {
    // We add one small floating button per paragraph inside the message element.
    // This avoids many buttons in the middle of text and mimics the "copy" buttons UI.
    const existingSourceId = messageEl.dataset.sourceId || messageEl.dataset.messageId;
    const sourceId = existingSourceId ?? (crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString());
    try {
        messageEl.dataset.sourceId = sourceId;
    }
    catch (_) { }
    // We'll look for headings, list items (key points) and paragraphs. Buttons attached to
    // a heading will save the heading + following content until the next heading of same/higher level.
    // Buttons on a list-item will save that item (and nested content) until the next sibling list-item.
    // Paragraph buttons save only the paragraph.
    const headingNodes = Array.from(messageEl.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(n => (n.textContent || '').trim().length >= MIN_PARAGRAPH_LENGTH && !isInteractive(n));
    const listItemNodes = Array.from(messageEl.querySelectorAll('li')).filter(n => (n.textContent || '').trim().length >= MIN_PARAGRAPH_LENGTH && !isInteractive(n));
    const paragraphNodes = Array.from(messageEl.querySelectorAll('p, div > p, div')).filter(n => (n.textContent || '').trim().length >= MIN_PARAGRAPH_LENGTH && !isInteractive(n));
    // Heuristic: detect "pseudo-headings" inside paragraphs or divs that start sections, e.g. "1. Obtención" or emoji bullets like "🔑 1. ..."
    const pseudoHeadingRegex = /^\s*(?:[\u2700-\u27BF\u1F300-\u1F6FF\u1F900-\u1F9FF]|\*|\-|\d+\.|\d+\))\s+.{3,120}/;
    const extraPseudoHeadings = [];
    for (const p of paragraphNodes) {
        const txt = (p.textContent || '').trim();
        if (pseudoHeadingRegex.test(txt) || (/^\d+\./.test(txt) && txt.length < 140)) {
            try {
                p.dataset.pseudoHeading = 'true';
            }
            catch (_) { }
            extraPseudoHeadings.push(p);
        }
    }
    // include pseudo-headings into headingNodes so they get section capture behavior
    extraPseudoHeadings.forEach(n => headingNodes.push(n));
    // Merge candidates with ordering: headings first, then list items, then paragraphs (avoid duplicates)
    const candidates = [];
    const addIfUnique = (n) => { if (!candidates.includes(n))
        candidates.push(n); };
    headingNodes.forEach(addIfUnique);
    listItemNodes.forEach(addIfUnique);
    paragraphNodes.forEach(addIfUnique);
    // Always add a small "save whole response" button near the top of the message so
    // users can easily save the entire response irrespective of per-paragraph buttons.
    if (!messageEl.querySelector(`.${BUTTON_CLASS}[data-scope="message"]`)) {
        const topBtn = createFloatingButton('message');
        try {
            topBtn.dataset.scope = 'message';
        }
        catch (_) { }
        topBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const messageText = (messageEl.textContent || '').trim();
            // use message-level source id (one per message)
            sendSaveMessage({ type: 'SAVE_CHAT_DATA', payload: { sourceId, messageText, pageUrl: window.location.href } }, topBtn);
        });
        messageEl.style.position = messageEl.style.position || 'relative';
        // insert before first child so it's visually above the message
        if (messageEl.firstChild)
            messageEl.insertBefore(topBtn, messageEl.firstChild);
        else
            messageEl.appendChild(topBtn);
    }
    // If no finer-grained candidates found, we still keep the top-level button and exit
    if (candidates.length === 0)
        return;
    // Helper: collect fragment text depending on node type
    function collectFragmentText(start) {
        const tag = start.tagName.toUpperCase();
        if (/^H[1-6]$/.test(tag) || (start.dataset && start.dataset.pseudoHeading === 'true')) {
            // heading: collect until next heading of same or higher level
            const level = /^H[1-6]$/.test(tag) ? parseInt(tag[1], 10) : 2; // pseudo-heading treated at level 2
            const pieces = [];
            pieces.push((start.textContent || '').trim());
            let sib = start.nextElementSibling;
            while (sib && messageEl.contains(sib)) {
                const sTag = sib.tagName.toUpperCase();
                // stop when next real heading of same or higher level is encountered
                if (/^H[1-6]$/.test(sTag)) {
                    const sLevel = parseInt(sTag[1], 10);
                    if (sLevel <= level)
                        break; // stop at same or higher-level heading
                }
                pieces.push((sib.textContent || '').trim());
                sib = sib.nextElementSibling;
            }
            return pieces.filter(Boolean).join('\n\n').trim();
        }
        if (tag === 'LI') {
            // list item: collect this li and next sibling lis until next li at same parent
            const pieces = [];
            const parent = start.parentElement;
            if (!parent)
                return (start.textContent || '').trim();
            let include = false;
            for (const child of Array.from(parent.children)) {
                const el = child;
                if (el === start)
                    include = true;
                if (!include)
                    continue;
                // stop if we hit another li that is different and we already included at least one
                if (el.tagName.toUpperCase() === 'LI' && el !== start && pieces.length > 0)
                    break;
                pieces.push((el.textContent || '').trim());
                // also include following siblings that are not LI but are inside the same container until next LI
            }
            // Also attempt to include following siblings of the list (e.g., paragraphs after the list) until next list-item parent
            let siblingAfter = parent.nextElementSibling;
            while (siblingAfter && siblingAfter.tagName.toUpperCase() !== 'UL' && siblingAfter.tagName.toUpperCase() !== 'OL') {
                pieces.push((siblingAfter.textContent || '').trim());
                siblingAfter = siblingAfter.nextElementSibling;
            }
            return pieces.filter(Boolean).join('\n\n').trim();
        }
        // default: paragraph or other block-level element
        return (start.textContent || '').trim();
    }
    candidates.forEach((el, idx) => {
        if (seenElements.has(el))
            return;
        if (el.querySelector(`.${BUTTON_CLASS}`))
            return;
        seenElements.add(el);
        const prevPos = el.style.position;
        if (!prevPos || prevPos === '')
            el.style.position = 'relative';
        const tag = el.tagName.toUpperCase();
        const saveType = (/^H[1-6]$/.test(tag) ? 'heading' : (tag === 'LI' ? 'list' : 'paragraph'));
        // generate a fragment-specific source id so different fragments of the same message
        // don't overwrite each other. Prefer crypto.randomUUID when available.
        const fragSuffix = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        const fragmentSourceId = `${sourceId}::${saveType}::${fragSuffix}`;
        const btn = createFloatingButton(saveType);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                const fragment = collectFragmentText(el);
                if (!fragment || fragment.length < 8) {
                    // fallback to message-level if fragment too small
                    const messageText = (messageEl.textContent || '').trim();
                    sendSaveMessage({ type: 'SAVE_CHAT_DATA', payload: { sourceId: fragmentSourceId, messageText, pageUrl: window.location.href } }, btn);
                    return;
                }
                sendSaveMessage({ type: 'SAVE_CHAT_DATA', payload: { sourceId: fragmentSourceId, messageText: fragment, pageUrl: window.location.href } }, btn);
            }
            catch (err) {
                console.error('Failed to collect fragment', err);
                const messageText = (messageEl.textContent || '').trim();
                sendSaveMessage({ type: 'SAVE_CHAT_DATA', payload: { sourceId: fragmentSourceId, messageText, pageUrl: window.location.href } }, btn);
            }
        });
        el.appendChild(btn);
    });
}
function createFloatingButton(saveType) {
    const button = document.createElement('button');
    button.className = BUTTON_CLASS;
    button.textContent = '💾'; // small icon-like label
    button.title = BUTTON_LABEL;
    button.type = 'button';
    // color mapping by save type
    const colorMap = {
        message: { bg: '#2b6cb0', title: 'Guardar toda la respuesta' },
        heading: { bg: '#805ad5', title: 'Guardar sección (titular + contenido)' },
        list: { bg: '#38a169', title: 'Guardar punto clave' },
        paragraph: { bg: '#d69e2e', title: 'Guardar párrafo' }
    };
    const cfg = saveType ? colorMap[saveType] : null;
    if (cfg) {
        button.style.background = cfg.bg;
        button.style.color = '#fff';
        button.title = cfg.title;
    }
    else {
        button.style.background = 'rgba(0,0,0,0.06)';
        button.style.color = '#000';
        button.title = BUTTON_LABEL;
    }
    Object.assign(button.style, {
        position: 'absolute',
        right: '0px',
        top: '6px',
        transform: 'translateX(100%)', // move the button to the right outside the paragraph box
        padding: '4px 6px',
        fontSize: '12px',
        borderRadius: '6px',
        border: 'none',
        cursor: 'pointer',
        opacity: '0.9',
        transition: 'opacity 120ms ease'
    });
    button.addEventListener('mouseover', () => { button.style.opacity = '1'; });
    button.addEventListener('mouseout', () => { button.style.opacity = '0.9'; });
    // click handler is attached by caller so we don't close over UI state here
    return button;
}
function sendSaveMessage(message, button) {
    try {
        button.disabled = true;
        const prev = button.textContent;
        button.textContent = '...';
        button.style.opacity = '1';
        chrome.runtime.sendMessage(message, (response) => {
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
            }
            else {
                button.textContent = '!';
                setTimeout(() => { button.textContent = '💾'; button.disabled = false; button.style.opacity = '0.4'; }, 1200);
            }
        });
    }
    catch (err) {
        console.error('Failed to send save message', err);
        button.textContent = '!';
        setTimeout(() => { button.textContent = '💾'; button.disabled = false; button.style.opacity = '0.4'; }, 1200);
    }
}
function processExistingMessages(root) {
    // Try platform-specific selectors first for higher precision
    const usedPlatform = tryPlatformSelectors(root);
    if (usedPlatform)
        return;
    // Fallback to general heuristic
    const candidates = findMessageCandidates(root);
    candidates.forEach((el) => injectSaveButton(el));
}
function beginObserving() {
    processExistingMessages(document);
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of Array.from(mutation.addedNodes)) {
                if (!(node instanceof HTMLElement))
                    continue;
                // First try platform selectors on the added node (high precision)
                const foundByPlatform = tryPlatformSelectors(node);
                if (!foundByPlatform) {
                    // If not found, then fall back to the per-node heuristic
                    if (containsSignificantText(node) && !isInteractive(node)) {
                        injectSaveButton(node);
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
    document.addEventListener('DOMContentLoaded', () => {
        if (!isAllowedHost()) {
            // don't run on unrelated sites
            console.debug('AI organizer: host not allowed, aborting content script on', window.location.host);
            return;
        }
        beginObserving();
    }, { once: true });
}
else {
    if (isAllowedHost())
        beginObserving();
    else
        console.debug('AI organizer: host not allowed, aborting content script on', window.location.host);
}
// ---- Side panel (in-page) support using shadow DOM ---------------------------------
const PANEL_ID = 'ai-organizer-sidepanel';
let panelRoot = null;
let panelHost = null;
let storageListenerAttached = false;
let mindMapResizeObserver = null;
let currentMindMapData = null;
let currentMindMapUpdatedAt = null;
let currentMindMapPageUrl = null;
const storageChangeListener = (changes, area) => {
    if (area !== 'local')
        return;
    if (changes.groupsIndex)
        loadGroupsIntoPanel();
    if (changes.mindMaps)
        loadMindMapIntoPanel();
};
function createSidePanel() {
    if (panelRoot)
        return panelRoot;
    // host container to attach shadow root
    const host = document.createElement('div');
    host.id = PANEL_ID;
    // default width, may be overridden by saved value
    Object.assign(host.style, {
        position: 'fixed',
        right: '0',
        top: '0',
        height: '100vh',
        width: '420px',
        zIndex: '2147483647',
        boxShadow: '-4px 0 12px rgba(0,0,0,0.12)'
    });
    const shadow = host.attachShadow({ mode: 'closed' });
    // Basic styles for the panel
    const style = document.createElement('style');
    style.textContent = `
    :host { font-family: system-ui, Arial, sans-serif; }
    .panel { box-sizing: border-box; height: 100vh; width: 100%; background: #fff; border-left: 1px solid #e6e6e6; display:flex; flex-direction:column; }
    header { padding:12px; border-bottom:1px solid #eee }
    header h1 { margin:0; font-size:16px }
    #context-tree-list { padding:12px; overflow:auto; flex:1 }
    .group { margin-bottom:10px }
    .group-header { width:100%; text-align:left; padding:8px; background:#f7f7f7; border:none; cursor:pointer }
    ul { list-style:none; padding-left:8px }
    li { padding:6px 0; display:flex; align-items:center; justify-content:space-between }
    .close-btn { position: absolute; left: -42px; top: 8px; padding:6px 8px; border-radius:6px; border:none; background:rgba(0,0,0,0.6); color:#fff; cursor:pointer }
    #mind-map-section { border-top:1px solid #eee; padding:12px; }
    .mindmap-header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .mindmap-header h2 { font-size:15px; margin:0; }
    .mindmap-actions { display:flex; align-items:center; gap:6px; }
    .mindmap-button { padding:6px 10px; border-radius:6px; border:1px solid #d0d0d0; background:#f7f7f7; cursor:pointer; font-size:12px; }
    .mindmap-button[disabled] { opacity:0.6; cursor:progress; }
    #mind-map-status { margin:8px 0 4px 0; font-size:12px; color:#555; }
    #mind-map-status[data-tone="error"] { color:#b42318; }
    #mind-map-status[data-tone="success"] { color:#1b7d2b; }
    #mind-map-status[data-tone="loading"] { color:#0b5fff; }
    #mind-map-canvas { width:100%; height:280px; margin-top:8px; border:1px solid #f0f0f0; border-radius:8px; background:#fafafa; position:relative; overflow:hidden; }
    #mind-map-canvas svg { width:100%; height:100%; }
    .mindmap-info { margin-top:10px; font-size:12px; color:#333; min-height:48px; background:#f9f9ff; border:1px solid #ececff; border-radius:6px; padding:8px; }
    .mindmap-placeholder { display:flex; align-items:center; justify-content:center; height:100%; font-size:14px; color:#888; text-align:center; padding:12px; }
    .mindmap-node { transition:transform 120ms ease, fill 120ms ease; cursor:pointer; }
    .mindmap-node text { font-size:11px; pointer-events:none; fill:#222; }
    .mindmap-node circle { fill:#ffffff; stroke:#5a67d8; stroke-width:2; }
    .mindmap-node[data-central="true"] circle { fill:#5a67d8; stroke:#434190; stroke-width:2; }
    .mindmap-node[data-central="true"] text { fill:#fff; font-weight:600; }
    .mindmap-node:hover circle { fill:#ebf4ff; }
    .mindmap-link { stroke:#d0d5ff; stroke-width:1.6; marker-end:url(#arrowhead); opacity:0.85; transition:opacity 120ms ease; }
    .mindmap-link[data-highlight="true"] { stroke:#4250d6; opacity:1; }
    .mindmap-node[data-highlight="true"] circle { fill:#eef2ff; }
    .mindmap-node[data-highlight="true"] text { font-weight:600; }
    .mindmap-legend { font-size:11px; color:#777; margin-top:6px; }
  `;
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
    <button class="close-btn" title="Cerrar">✕</button>
    <header>
      <h1>Arbol Contextual</h1>
      <p id="context-tree-subtitle">Mensajes capturados y datos clave.</p>
      <div style="margin-top:8px"><button id="clear-all-btn" style="padding:6px 8px;border-radius:6px;border:1px solid #ddd;cursor:pointer">Borrar todo</button></div>
    </header>
    <nav id="context-tree-list" aria-live="polite"></nav>
    <section id="mind-map-section">
      <div class="mindmap-header">
        <h2>Mapa Conceptual</h2>
        <div class="mindmap-actions">
          <button id="regenerate-map-btn" class="mindmap-button" type="button">Actualizar con Gemini</button>
        </div>
      </div>
      <p id="mind-map-status" class="mindmap-status" data-tone="info">Conecta tu clave de la API de Gemini en las opciones para habilitar el mapa.</p>
      <div id="mind-map-canvas" role="img" aria-label="Visualización del mapa conceptual"></div>
      <div id="mind-map-info" class="mindmap-info" aria-live="polite"></div>
    </section>
  `;
    shadow.appendChild(style);
    shadow.appendChild(panel);
    document.documentElement.appendChild(host);
    panelHost = host;
    panelRoot = shadow;
    // apply saved width if present
    try {
        chrome.storage.local.get(['panelWidth'], (res) => {
            const w = res?.panelWidth;
            if (w && typeof w === 'number')
                host.style.width = `${Math.max(280, Math.min(800, w))}px`;
        });
    }
    catch (e) {
        // ignore
    }
    // add resize handle
    const handle = document.createElement('div');
    Object.assign(handle.style, {
        position: 'absolute',
        left: '-8px',
        top: '0',
        width: '8px',
        height: '100%',
        cursor: 'ew-resize',
        zIndex: '2147483648'
    });
    panelHost.appendChild(handle);
    // pointer-based resize
    let dragging = false;
    let startX = 0;
    let startWidth = 420;
    handle.addEventListener('pointerdown', (ev) => {
        dragging = true;
        startX = ev.clientX;
        startWidth = panelHost ? panelHost.getBoundingClientRect().width : 420;
        document.body.style.userSelect = 'none';
        handle.setPointerCapture(ev.pointerId);
    });
    window.addEventListener('pointermove', (ev) => {
        if (!dragging || !panelHost)
            return;
        const dx = startX - ev.clientX;
        const newW = Math.max(280, Math.min(800, startWidth + dx));
        panelHost.style.width = `${newW}px`;
    });
    window.addEventListener('pointerup', (ev) => {
        if (!dragging)
            return;
        dragging = false;
        try {
            document.body.style.userSelect = '';
        }
        catch (_) { }
        // persist width
        try {
            const w = panelHost ? panelHost.getBoundingClientRect().width : 420;
            chrome.storage.local.set({ panelWidth: Math.round(w) });
        }
        catch (e) { /* ignore */ }
    });
    // close button handler
    const closeBtn = shadow.querySelector('.close-btn');
    if (closeBtn)
        closeBtn.addEventListener('click', destroySidePanel);
    // clear all handler
    const clearBtn = shadow.querySelector('#clear-all-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            try {
                const ok = confirm('¿Borrar todos los elementos guardados? Esta acción eliminará todos los datos guardados.');
                if (!ok)
                    return;
                chrome.runtime.sendMessage({ type: 'CLEAR_ALL_SAVED' }, (resp) => {
                    if (chrome.runtime.lastError) {
                        console.error('Clear all error', chrome.runtime.lastError);
                        return;
                    }
                    // refresh panel
                    loadGroupsIntoPanel();
                    loadMindMapIntoPanel();
                });
            }
            catch (e) {
                console.error('Failed to clear all', e);
            }
        });
    }
    const regenerateBtn = shadow.querySelector('#regenerate-map-btn');
    if (regenerateBtn) {
        regenerateBtn.addEventListener('click', () => {
            requestMindMapRegeneration();
        });
    }
    // load groups into panel
    loadGroupsIntoPanel();
    loadMindMapIntoPanel();
    if (!storageListenerAttached) {
        chrome.storage.onChanged.addListener(storageChangeListener);
        storageListenerAttached = true;
    }
    if (panelHost) {
        if (!mindMapResizeObserver) {
            mindMapResizeObserver = new ResizeObserver(() => {
                if (currentMindMapData) {
                    renderMindMapGraph(currentMindMapData, currentMindMapUpdatedAt || undefined);
                }
            });
        }
        mindMapResizeObserver.observe(panelHost);
    }
    return shadow;
}
function destroySidePanel() {
    if (panelHost && mindMapResizeObserver) {
        try {
            mindMapResizeObserver.unobserve(panelHost);
        }
        catch (_) { /* ignore */ }
    }
    if (storageListenerAttached) {
        chrome.storage.onChanged.removeListener(storageChangeListener);
        storageListenerAttached = false;
    }
    if (panelHost && panelHost.parentElement)
        panelHost.parentElement.removeChild(panelHost);
    panelHost = null;
    panelRoot = null;
}
function toggleSidePanel() {
    if (panelRoot)
        destroySidePanel();
    else
        createSidePanel();
}
// Scroll / highlight logic used when the sidebar requests navigation
async function scrollToSource(sourceId) {
    try {
        const selector = `[data-source-id="${sourceId}"],[data-message-id="${sourceId}"]`;
        let el = document.querySelector(selector);
        if (!el) {
            // best-effort: scan dataset attributes
            el = Array.from(document.querySelectorAll('*')).find(e => {
                try {
                    const ds = e.dataset;
                    return ds && (ds.sourceId === sourceId || ds.messageId === sourceId);
                }
                catch (_) {
                    return false;
                }
            });
        }
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const prev = el.style.outline;
            el.style.outline = '3px solid #ffb86b';
            setTimeout(() => { el.style.outline = prev; }, 4000);
            return true;
        }
        // Fallback: try to find by saved text fragment in storage
        try {
            const res = await new Promise((resolve) => chrome.storage.local.get([sourceId], resolve));
            const item = res && res[sourceId];
            const text = item?.original_text || item?.summary || item?.title || '';
            const fragment = (text || '').trim().replace(/\s+/g, ' ').slice(0, 160);
            if (fragment && fragment.length >= 8) {
                const normFrag = fragment.toLowerCase();
                let best = null;
                let bestLen = Infinity;
                for (const node of Array.from(document.querySelectorAll('*'))) {
                    try {
                        const tc = node.textContent || '';
                        const tcl = tc.toLowerCase();
                        if (tcl.includes(normFrag)) {
                            const len = tc.trim().length;
                            if (len > 0 && len < bestLen) {
                                best = node;
                                bestLen = len;
                            }
                        }
                    }
                    catch (_) { /* ignore nodes we can't read */ }
                }
                if (best) {
                    best.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    const prev = best.style.outline;
                    best.style.outline = '3px solid #ffb86b';
                    return true;
                }
            }
        }
        catch (e) {
            console.debug('Text-match fallback failed', e);
        }
    }
    catch (e) {
        console.error('scrollToSource failed', e);
    }
    return false;
}
function normalizeUrlForCompare(u) {
    try {
        if (!u)
            return null;
        const url = new URL(u);
        // origin + pathname (strip trailing slash)
        let p = url.pathname || '/';
        if (p !== '/' && p.endsWith('/'))
            p = p.slice(0, -1);
        return `${url.origin}${p}`;
    }
    catch (e) {
        return null;
    }
}
// listen for messages from background/sidebar
chrome.runtime.onMessage.addListener((msg, _sender, sendResp) => {
    if (!msg || !msg.type)
        return;
    switch (msg.type) {
        case 'TOGGLE_SIDE_PANEL':
            toggleSidePanel();
            sendResp({ ok: true });
            return;
        case 'SCROLL_TO_SOURCE': {
            const sourceId = msg.payload?.sourceId;
            if (!sourceId) {
                sendResp({ ok: false, error: 'no sourceId' });
                return;
            }
            scrollToSource(sourceId)
                .then((ok) => sendResp({ ok }))
                .catch((err) => {
                console.error('SCROLL_TO_SOURCE error', err);
                sendResp({ ok: false, error: String(err) });
            });
            return true;
        }
        case 'MIND_MAP_UPDATED': {
            const map = msg.payload?.map;
            if (map) {
                renderMindMapGraph(map);
                setMindMapStatus('Mapa conceptual actualizado.', 'success');
            }
            else {
                loadMindMapIntoPanel();
            }
            return;
        }
        default:
            break;
    }
});
// --------- Panel content: load & render groups -------------------------------------
function renderGroupsInPanel(groups, itemsMap) {
    if (!panelRoot)
        return;
    const container = panelRoot.querySelector('#context-tree-list');
    if (!container)
        return;
    container.innerHTML = '';
    const groupKeys = Object.keys(groups || {});
    if (!groupKeys.length) {
        container.innerHTML = '<p>No hay elementos guardados todavía.</p>';
        return;
    }
    for (const key of groupKeys) {
        const group = groups[key];
        const section = document.createElement('section');
        section.className = 'group';
        const header = document.createElement('button');
        header.className = 'group-header';
        header.textContent = `${group.title} (${group.items.length})`;
        header.setAttribute('aria-expanded', 'false');
        const list = document.createElement('ul');
        list.style.display = 'none';
        header.addEventListener('click', () => {
            const expanded = header.getAttribute('aria-expanded') === 'true';
            header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
            list.style.display = expanded ? 'none' : 'block';
        });
        for (const sid of group.items) {
            const item = itemsMap[sid];
            const li = document.createElement('li');
            const title = (item && (item.title || item.source_id || (item.original_text || '').slice?.(0, 80))) || sid;
            const span = document.createElement('span');
            span.textContent = title;
            span.style.marginRight = '8px';
            const goto = document.createElement('button');
            goto.textContent = 'Ir al mensaje';
            goto.style.marginLeft = '8px';
            goto.addEventListener('click', async () => {
                try {
                    const itemUrlNorm = normalizeUrlForCompare(item?.pageUrl);
                    const currentNorm = normalizeUrlForCompare(window.location.href);
                    if (item && itemUrlNorm && currentNorm && itemUrlNorm === currentNorm) {
                        // same page (ignoring query/fragment): try to scroll; fallback to background if not found
                        const ok = await scrollToSource(sid);
                        if (!ok)
                            chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_SOURCE', payload: { pageUrl: item?.pageUrl || window.location.href, sourceId: sid } });
                    }
                    else if (item && item.pageUrl && item.pageUrl === window.location.href) {
                        const ok = await scrollToSource(sid);
                        if (!ok)
                            chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_SOURCE', payload: { pageUrl: item?.pageUrl || window.location.href, sourceId: sid } });
                    }
                    else {
                        // otherwise delegate to background to open/fallback
                        chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_SOURCE', payload: { pageUrl: item?.pageUrl || window.location.href, sourceId: sid } });
                    }
                }
                catch (e) {
                    console.error('Failed to request navigation', e);
                }
            });
            // delete button
            const del = document.createElement('button');
            del.textContent = 'Eliminar';
            del.style.marginLeft = '6px';
            del.addEventListener('click', () => {
                try {
                    const ok = confirm('¿Eliminar este elemento guardado? Esta acción no se puede deshacer.');
                    if (!ok)
                        return;
                    chrome.runtime.sendMessage({ type: 'DELETE_SAVED_ITEM', payload: { sourceId: sid } }, (resp) => {
                        if (chrome.runtime.lastError) {
                            console.error('Delete message error', chrome.runtime.lastError);
                            return;
                        }
                        if (resp && resp.ok) {
                            // refresh panel data
                            loadGroupsIntoPanel();
                        }
                    });
                }
                catch (e) {
                    console.error('Failed to delete', e);
                }
            });
            li.appendChild(span);
            const rightWrap = document.createElement('div');
            rightWrap.style.display = 'flex';
            rightWrap.style.alignItems = 'center';
            rightWrap.appendChild(goto);
            rightWrap.appendChild(del);
            li.appendChild(rightWrap);
            list.appendChild(li);
        }
        section.appendChild(header);
        section.appendChild(list);
        container.appendChild(section);
    }
}
function loadGroupsIntoPanel() {
    if (!panelRoot)
        return;
    const storage = chrome && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
    if (!storage) {
        renderGroupsInPanel({}, {});
        return;
    }
    storage.get(['groupsIndex'], (data) => {
        const groups = data?.groupsIndex || {};
        const allKeys = Object.values(groups).flatMap((g) => g.items || []);
        if (!allKeys.length) {
            renderGroupsInPanel(groups, {});
            return;
        }
        storage.get(allKeys, (itemsData) => {
            renderGroupsInPanel(groups, itemsData || {});
        });
    });
}
function loadMindMapIntoPanel() {
    if (!panelRoot)
        return;
    const storage = chrome?.storage?.local;
    const canvas = panelRoot.querySelector('#mind-map-canvas');
    if (!storage || !canvas)
        return;
    const normalized = normalizeUrlForCompare(window.location.href);
    if (!normalized) {
        renderMindMapEmptyState('No se pudo interpretar la URL actual.');
        setMindMapStatus('No se pudo interpretar la URL actual.', 'error');
        return;
    }
    storage.get(['mindMaps', 'geminiApiKey'], (res) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
            renderMindMapEmptyState('No se pudo leer el almacenamiento.');
            setMindMapStatus('Error al leer el almacenamiento local.', 'error');
            console.error('storage.get error', lastError);
            return;
        }
        const hasKey = typeof res?.geminiApiKey === 'string' && res.geminiApiKey.trim().length > 0;
        if (!hasKey) {
            renderMindMapEmptyState('Agrega tu clave de Gemini en las opciones para generar el mapa.');
            setMindMapStatus('Agrega tu clave de la API de Gemini en las opciones.', 'info');
            return;
        }
        const entry = res?.mindMaps?.[normalized];
        if (!entry || !entry.data) {
            renderMindMapEmptyState('Aún no hay un mapa conceptual. Pulsa “Actualizar con Gemini” para generarlo.');
            setMindMapStatus('Pulsa “Actualizar con Gemini” para generar un nuevo mapa.', 'info');
            currentMindMapData = null;
            currentMindMapUpdatedAt = null;
            currentMindMapPageUrl = null;
            return;
        }
        currentMindMapUpdatedAt = entry.updated_at || null;
        currentMindMapPageUrl = entry.pageUrl || null;
        renderMindMapGraph(entry.data, entry.updated_at || undefined);
    });
}
function renderMindMapEmptyState(message) {
    if (!panelRoot)
        return;
    currentMindMapData = null;
    currentMindMapUpdatedAt = null;
    const canvas = panelRoot.querySelector('#mind-map-canvas');
    const info = panelRoot.querySelector('#mind-map-info');
    if (canvas) {
        canvas.innerHTML = '';
        const placeholder = document.createElement('div');
        placeholder.className = 'mindmap-placeholder';
        placeholder.textContent = message;
        canvas.appendChild(placeholder);
    }
    if (info)
        info.textContent = '';
}
function setMindMapStatus(message, tone = 'info') {
    if (!panelRoot)
        return;
    const statusEl = panelRoot.querySelector('#mind-map-status');
    if (!statusEl)
        return;
    statusEl.textContent = message;
    statusEl.setAttribute('data-tone', tone);
}
function renderMindMapGraph(data, updatedAt) {
    if (!panelRoot)
        return;
    const canvas = panelRoot.querySelector('#mind-map-canvas');
    const info = panelRoot.querySelector('#mind-map-info');
    if (!canvas)
        return;
    currentMindMapData = data;
    currentMindMapUpdatedAt = updatedAt || null;
    canvas.innerHTML = '';
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || 520;
    const height = rect.height || 320;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    const defs = document.createElementNS(svgNS, 'defs');
    const marker = document.createElementNS(svgNS, 'marker');
    marker.setAttribute('id', 'arrowhead');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('refX', '6');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');
    const markerPath = document.createElementNS(svgNS, 'path');
    markerPath.setAttribute('d', 'M0,0 L6,3 L0,6 Z');
    markerPath.setAttribute('fill', '#5a67d8');
    marker.appendChild(markerPath);
    defs.appendChild(marker);
    svg.appendChild(defs);
    const linksGroup = document.createElementNS(svgNS, 'g');
    linksGroup.setAttribute('class', 'mindmap-links');
    const nodesGroup = document.createElementNS(svgNS, 'g');
    nodesGroup.setAttribute('class', 'mindmap-nodes');
    const radius = Math.min(width, height) / 2 - 70;
    const centerX = width / 2;
    const centerY = height / 2;
    const layoutNodes = [];
    const positionMap = new Map();
    const centerNode = {
        id: '__central__',
        titulo: data.titulo_central || 'Tema principal',
        descripcion: data.titulo_central || '',
        x: centerX,
        y: centerY,
        central: true
    };
    layoutNodes.push(centerNode);
    positionMap.set(centerNode.id, centerNode);
    const nodes = Array.isArray(data.nodos) ? data.nodos : [];
    nodes.forEach((node, index) => {
        const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2;
        const x = centerX + radius * Math.cos(angle);
        const y = centerY + radius * Math.sin(angle);
        const ln = { id: node.id || `n_${index}`, titulo: node.titulo || `Nodo ${index + 1}`, descripcion: node.descripcion || '', x, y, source_ids: Array.isArray(node.source_ids) ? node.source_ids.slice() : [] };
        layoutNodes.push(ln);
        positionMap.set(ln.id, ln);
    });
    const adjacency = new Map();
    const ensureKnownId = (rawId) => {
        if (!rawId)
            return '__central__';
        if (positionMap.has(rawId))
            return rawId;
        return '__central__';
    };
    const relations = Array.isArray(data.relaciones) ? data.relaciones : [];
    const connected = new Set();
    relations.forEach((rel) => {
        const fromId = ensureKnownId(rel.desde);
        const toId = ensureKnownId(rel.hacia);
        const fromNode = positionMap.get(fromId);
        const toNode = positionMap.get(toId);
        if (!fromNode || !toNode)
            return;
        const line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', String(fromNode.x));
        line.setAttribute('y1', String(fromNode.y));
        line.setAttribute('x2', String(toNode.x));
        line.setAttribute('y2', String(toNode.y));
        line.setAttribute('class', 'mindmap-link');
        line.setAttribute('marker-end', 'url(#arrowhead)');
        line.dataset.source = fromId;
        line.dataset.target = toId;
        linksGroup.appendChild(line);
        connected.add(fromId);
        connected.add(toId);
        const listFrom = adjacency.get(fromId) || [];
        listFrom.push(line);
        adjacency.set(fromId, listFrom);
        const listTo = adjacency.get(toId) || [];
        listTo.push(line);
        adjacency.set(toId, listTo);
    });
    layoutNodes.forEach((ln) => {
        if (ln.id === '__central__')
            return;
        if (!connected.has(ln.id)) {
            const line = document.createElementNS(svgNS, 'line');
            line.setAttribute('x1', String(centerNode.x));
            line.setAttribute('y1', String(centerNode.y));
            line.setAttribute('x2', String(ln.x));
            line.setAttribute('y2', String(ln.y));
            line.setAttribute('class', 'mindmap-link');
            line.setAttribute('marker-end', 'url(#arrowhead)');
            line.dataset.source = centerNode.id;
            line.dataset.target = ln.id;
            linksGroup.appendChild(line);
            const listFrom = adjacency.get(centerNode.id) || [];
            listFrom.push(line);
            adjacency.set(centerNode.id, listFrom);
            const listTo = adjacency.get(ln.id) || [];
            listTo.push(line);
            adjacency.set(ln.id, listTo);
        }
    });
    svg.appendChild(linksGroup);
    const highlightNode = (id, description, title) => {
        if (!panelRoot)
            return;
        const nodeElements = canvas.querySelectorAll('.mindmap-node');
        nodeElements.forEach((el) => el.removeAttribute('data-highlight'));
        const edgeElements = canvas.querySelectorAll('.mindmap-link');
        edgeElements.forEach((el) => el.removeAttribute('data-highlight'));
        const current = canvas.querySelector(`[data-node-id="${id}"]`);
        if (current)
            current.setAttribute('data-highlight', 'true');
        const edges = adjacency.get(id) || [];
        edges.forEach((edge) => edge.setAttribute('data-highlight', 'true'));
        if (id !== centerNode.id) {
            const centerEdges = adjacency.get(centerNode.id) || [];
            centerEdges.forEach((edge) => {
                const sourceMatch = edge.dataset.source === id || edge.dataset.target === id;
                if (sourceMatch)
                    edge.setAttribute('data-highlight', 'true');
            });
        }
        if (info) {
            info.innerHTML = '';
            const titleEl = document.createElement('strong');
            titleEl.textContent = title;
            const descEl = document.createElement('p');
            descEl.style.margin = '4px 0 0 0';
            descEl.textContent = description || 'Sin descripción disponible.';
            info.appendChild(titleEl);
            info.appendChild(descEl);
            // Show source links if the node has source_ids attached (stored in the rendered node dataset)
            try {
                const curEl = canvas.querySelector(`[data-node-id="${id}"]`);
                const raw = curEl?.dataset?.sourceIds;
                const srcIds = raw ? JSON.parse(raw) : [];
                if (Array.isArray(srcIds) && srcIds.length) {
                    const listWrap = document.createElement('div');
                    listWrap.style.marginTop = '8px';
                    const label = document.createElement('div');
                    label.textContent = 'Fragmentos relacionados:';
                    label.style.fontSize = '12px';
                    label.style.marginBottom = '6px';
                    listWrap.appendChild(label);
                    const ul = document.createElement('ul');
                    ul.style.listStyle = 'none';
                    ul.style.padding = '0';
                    ul.style.margin = '0';
                    for (const sid of srcIds) {
                        const li = document.createElement('li');
                        li.style.marginBottom = '6px';
                        const btn = document.createElement('button');
                        btn.textContent = `Ir al fragmento ${sid.slice(0, 8)}`;
                        btn.style.padding = '6px 8px';
                        btn.style.borderRadius = '6px';
                        btn.style.border = '1px solid #ddd';
                        btn.style.background = '#fff';
                        btn.style.cursor = 'pointer';
                        btn.addEventListener('click', () => {
                            try {
                                const targetPage = currentMindMapPageUrl || window.location.href;
                                chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_SOURCE', payload: { pageUrl: targetPage, sourceId: sid } }, (_resp) => { });
                            }
                            catch (e) {
                                console.error('Failed to request navigate', e);
                            }
                        });
                        const preview = document.createElement('div');
                        preview.style.fontSize = '12px';
                        preview.style.color = '#444';
                        preview.style.marginTop = '6px';
                        preview.textContent = 'Cargando vista previa...';
                        // try to load a preview of the saved fragment from storage
                        try {
                            chrome.storage.local.get([sid], (res) => {
                                const item = res?.[sid];
                                if (item) {
                                    const txt = (item.original_text || item.summary || item.title || '').replace(/\s+/g, ' ').trim();
                                    preview.textContent = txt ? txt.slice(0, 220) + (txt.length > 220 ? '…' : '') : 'Sin texto disponible.';
                                }
                                else {
                                    preview.textContent = 'Fragmento no encontrado en el almacenamiento.';
                                }
                            });
                        }
                        catch (_) {
                            preview.textContent = 'No se pudo cargar la vista previa.';
                        }
                        li.appendChild(btn);
                        li.appendChild(preview);
                        ul.appendChild(li);
                    }
                    listWrap.appendChild(ul);
                    info.appendChild(listWrap);
                }
            }
            catch (e) {
                console.debug('Failed to render source links', e);
            }
        }
    };
    layoutNodes.forEach((ln) => {
        const group = document.createElementNS(svgNS, 'g');
        group.setAttribute('class', 'mindmap-node');
        group.dataset.nodeId = ln.id;
        try {
            group.dataset.sourceIds = JSON.stringify(ln.source_ids || []);
        }
        catch (_) {
            group.dataset.sourceIds = '[]';
        }
        if (ln.central)
            group.dataset.central = 'true';
        group.setAttribute('tabindex', '0');
        group.setAttribute('role', 'button');
        group.setAttribute('aria-label', `Nodo ${ln.titulo}`);
        const circle = document.createElementNS(svgNS, 'circle');
        circle.setAttribute('cx', String(ln.x));
        circle.setAttribute('cy', String(ln.y));
        circle.setAttribute('r', ln.central ? '38' : '26');
        group.appendChild(circle);
        const text = document.createElementNS(svgNS, 'text');
        text.setAttribute('x', String(ln.x));
        text.setAttribute('y', String(ln.y + (ln.central ? 6 : 4)));
        text.setAttribute('text-anchor', 'middle');
        text.textContent = ln.titulo.slice(0, 24);
        group.appendChild(text);
        group.addEventListener('mouseenter', () => highlightNode(ln.id, ln.descripcion, ln.titulo));
        group.addEventListener('focus', () => highlightNode(ln.id, ln.descripcion, ln.titulo));
        group.addEventListener('click', () => highlightNode(ln.id, ln.descripcion, ln.titulo));
        nodesGroup.appendChild(group);
    });
    svg.appendChild(nodesGroup);
    canvas.appendChild(svg);
    if (info) {
        info.innerHTML = '';
        const legend = document.createElement('p');
        legend.className = 'mindmap-legend';
        legend.textContent = 'Selecciona un nodo para ver más detalles.';
        info.appendChild(legend);
    }
    highlightNode(centerNode.id, centerNode.descripcion, centerNode.titulo);
    const statusMessage = updatedAt ? `Mapa actualizado ${formatRelativeTime(updatedAt)}.` : 'Mapa actualizado.';
    setMindMapStatus(statusMessage, 'success');
}
function requestMindMapRegeneration() {
    if (!panelRoot)
        return;
    const button = panelRoot.querySelector('#regenerate-map-btn');
    if (button) {
        button.disabled = true;
        button.textContent = 'Generando...';
    }
    setMindMapStatus('Solicitando a Gemini...', 'loading');
    chrome.runtime.sendMessage({ type: 'GENERATE_MIND_MAP', payload: { pageUrl: window.location.href } }, (resp) => {
        if (button) {
            button.disabled = false;
            button.textContent = 'Actualizar con Gemini';
        }
        const lastError = chrome.runtime.lastError;
        if (lastError) {
            console.error('GENERATE_MIND_MAP error', lastError);
            setMindMapStatus('No se pudo contactar con el servicio en segundo plano.', 'error');
            return;
        }
        if (resp?.ok && resp.map) {
            renderMindMapGraph(resp.map);
        }
        else {
            const reason = resp?.error || 'No se pudo generar el mapa conceptual.';
            setMindMapStatus(reason, 'error');
            // fallback to reload in case hay datos previos
            loadMindMapIntoPanel();
        }
    });
}
function formatRelativeTime(iso) {
    try {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime()))
            return 'recientemente';
        const diffMs = Date.now() - date.getTime();
        const diffMinutes = Math.floor(diffMs / 60000);
        if (diffMinutes < 1)
            return 'hace instantes';
        if (diffMinutes === 1)
            return 'hace 1 minuto';
        if (diffMinutes < 60)
            return `hace ${diffMinutes} minutos`;
        const diffHours = Math.floor(diffMinutes / 60);
        if (diffHours === 1)
            return 'hace 1 hora';
        if (diffHours < 24)
            return `hace ${diffHours} horas`;
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays === 1)
            return 'hace 1 día';
        if (diffDays < 7)
            return `hace ${diffDays} días`;
        return `el ${date.toLocaleDateString()}`;
    }
    catch (e) {
        return 'recientemente';
    }
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
