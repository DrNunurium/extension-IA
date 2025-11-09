// Content script: injects an in-page side panel and responds to background/popup messages.
// Minimal, robust implementation to ensure the panel opens in the same tab and
// SCROLL_TO_SOURCE messages are handled to scroll/highlight saved fragments.
// @ts-nocheck
const IDS = {
    PANEL_HOST: 'ia-sidepanel-host',
    PANEL_CONTENT: 'ia-sidepanel-content'
};
let currentSavedItems = [];
// Phrases to hide and remove from storage/UI (case-insensitive substrings).
const BANNED_PHRASES = [
    // Keep only highly specific phrases so legitimate snippets are not removed.
    'método para navegación rápida en conversación',
    'método para que el usuario pueda regresar rápidamente a secciones previas de una conversación'
];
function isBannedText(text) {
    if (!text)
        return false;
    const low = String(text).toLowerCase();
    return BANNED_PHRASES.some(p => low.includes(p));
}
function normalizeUrlString(raw) {
    if (!raw)
        return null;
    try {
        const parsed = new URL(raw, globalThis.location?.origin ?? undefined);
        let path = parsed.pathname || '/';
        if (path !== '/' && path.endsWith('/'))
            path = path.slice(0, -1);
        const params = [];
        parsed.searchParams.forEach((value, key) => { params.push([key, value]); });
        params.sort((a, b) => {
            if (a[0] === b[0]) {
                if (a[1] === b[1])
                    return 0;
                return a[1] < b[1] ? -1 : 1;
            }
            return a[0] < b[0] ? -1 : 1;
        });
        const canonicalSearch = params.length
            ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
            : '';
        const hash = parsed.hash && parsed.hash !== '#' ? parsed.hash : '';
        return `${parsed.origin}${path}${canonicalSearch}${hash}`;
    }
    catch (_) {
        return raw || null;
    }
}
function getNormalizedPageKey(url) {
    const first = normalizeUrlString(url);
    if (first)
        return first;
    const fallback = normalizeUrlString(globalThis.location?.href ?? null);
    return fallback ?? (globalThis.location?.href ?? '');
}
function normalizeForSearch(text) {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
}
const chromeRuntime = globalThis.chrome?.runtime;
function ensurePanelHost() {
    let host = document.getElementById(IDS.PANEL_HOST);
    if (host && host.isConnected) {
        // If we previously created the ShadowRoot in closed mode we store a
        // reference on the host element so we can reuse it. Avoid accessing
        // host.shadowRoot because closed mode returns null.
        const existing = host.__ia_shadow;
        if (existing)
            return existing;
        // fallback: try host.shadowRoot (may be null) and return if present
        if (host.shadowRoot)
            return host.shadowRoot;
        // otherwise continue to recreate below (shouldn't usually happen)
    }
    host = document.createElement('div');
    host.id = IDS.PANEL_HOST;
    host.style.position = 'fixed';
    host.style.right = '0';
    host.style.top = '0';
    host.style.height = '100vh';
    host.style.zIndex = String(2147483647 - 1);
    const shadow = host.attachShadow({ mode: 'closed' });
    try {
        // store a reference on the host so future callers can access the closed ShadowRoot
        Object.defineProperty(host, '__ia_shadow', { value: shadow, configurable: true });
    }
    catch (_) {
        // ignore if host is not extensible
        host.__ia_shadow = shadow;
    }
    const container = document.createElement('div');
    container.style.width = '360px';
    container.style.height = '100%';
    container.style.boxShadow = '-6px 12px 24px rgba(0,0,0,0.12)';
    container.style.background = '#fff';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    // Use a nicer UI font for the panel and cards; fall back to common system fonts.
    container.style.fontFamily = "Inter, 'Segoe UI', Roboto, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";
    const header = document.createElement('div');
    header.style.padding = '10px';
    header.style.borderBottom = '1px solid #e6e6e6';
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    const title = document.createElement('div');
    title.textContent = 'Mapa conceptual';
    title.style.fontWeight = '600';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.border = 'none';
    closeBtn.style.background = 'transparent';
    closeBtn.style.cursor = 'pointer';
    closeBtn.addEventListener('click', () => destroyPanel());
    header.appendChild(title);
    header.appendChild(closeBtn);
    const content = document.createElement('div');
    content.id = IDS.PANEL_CONTENT;
    content.style.padding = '12px';
    content.style.overflow = 'auto';
    content.style.flex = '1';
    container.appendChild(header);
    container.appendChild(content);
    shadow.appendChild(container);
    // Inject font import and some base styles into the shadow root so card typography is consistent.
    try {
        const fontStyle = document.createElement('style');
        fontStyle.id = 'ia-panel-fonts';
        fontStyle.textContent = "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap');\n" +
            `#${IDS.PANEL_CONTENT} { font-family: ${container.style.fontFamily}; font-size: 13px; color: #111; }`;
        shadow.appendChild(fontStyle);
    }
    catch (_) { /* ignore network/import errors */ }
    document.documentElement.appendChild(host);
    return shadow;
}
function destroyPanel() {
    const host = document.getElementById(IDS.PANEL_HOST);
    if (host)
        host.remove();
}
function renderMindMap(map) {
    const shadow = ensurePanelHost();
    const content = shadow.getElementById(IDS.PANEL_CONTENT);
    if (!content)
        return;
    // keep two sections: map area and saved items area
    content.innerHTML = '';
    const mapSection = document.createElement('div');
    mapSection.id = 'ia-map-section';
    if (!map) {
        const p = document.createElement('p');
        p.textContent = 'No hay mapa disponible para esta página.';
        mapSection.appendChild(p);
    }
    else {
        const h = document.createElement('h3');
        h.textContent = map.titulo_central || 'Tema';
        mapSection.appendChild(h);
        if (Array.isArray(map.conceptos_clave) && map.conceptos_clave.length) {
            const s = document.createElement('strong');
            s.textContent = 'Conceptos clave';
            mapSection.appendChild(s);
            const ul = document.createElement('ul');
            map.conceptos_clave.forEach(c => { const li = document.createElement('li'); li.textContent = c; ul.appendChild(li); });
            mapSection.appendChild(ul);
        }
        if (map.resumen_ejecutivo) {
            const st = document.createElement('strong');
            st.textContent = 'Resumen ejecutivo';
            mapSection.appendChild(st);
            const p = document.createElement('p');
            p.textContent = map.resumen_ejecutivo;
            mapSection.appendChild(p);
        }
    }
    const divider = document.createElement('hr');
    divider.style.margin = '12px 0';
    const savedSection = document.createElement('div');
    savedSection.id = 'ia-saved-section';
    const savedTitle = document.createElement('h4');
    savedTitle.textContent = 'Conversaciones guardadas';
    savedSection.appendChild(savedTitle);
    const savedList = document.createElement('div');
    savedList.id = 'ia-saved-list';
    savedList.style.display = 'flex';
    savedList.style.flexDirection = 'column';
    savedList.style.gap = '8px';
    savedSection.appendChild(savedList);
    content.appendChild(mapSection);
    content.appendChild(divider);
    content.appendChild(savedSection);
    // load saved items for this page and render them
    loadSavedItemsForPage();
}
function loadMindMapForPage() {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage || typeof storage.get !== 'function') {
        renderMindMap(null);
        return;
    }
    const normalizedKey = getNormalizedPageKey();
    const legacyKey = `${location.origin}${location.pathname.replace(/\/+$/, '')}`;
    storage.get(['mindMaps'], (res) => {
        try {
            const maps = res?.mindMaps || {};
            const entry = maps[normalizedKey] ?? maps[legacyKey] ?? null;
            renderMindMap(entry?.data ?? null);
        }
        catch (e) {
            renderMindMap(null);
        }
    });
}
// Load saved items from storage and show those that belong to this normalized page
function loadSavedItemsForPage() {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage || typeof storage.get !== 'function')
        return;
    storage.get(null, (all) => {
        try {
            const items = [];
            const toRemoveKeys = [];
            const updates = {};
            const normalizedHere = getNormalizedPageKey();
            const legacyHere = `${location.origin}${location.pathname.replace(/\/+$/, '')}`;
            for (const [k, v] of Object.entries(all || {})) {
                if (!v || typeof v !== 'object')
                    continue;
                if (!v.source_id)
                    continue;
                let normalizedItem = normalizeUrlString(v.pageUrl ?? null) ?? normalizeUrlString(v.normalized_page ?? null);
                if (!normalizedItem)
                    normalizedItem = (typeof v.normalized_page === 'string') ? v.normalized_page : null;
                if (!normalizedItem)
                    continue;
                if (v.normalized_page !== normalizedItem) {
                    updates[k] = { ...v, normalized_page: normalizedItem };
                }
                const matchesCurrent = normalizedItem === normalizedHere || normalizedItem === legacyHere;
                if (!matchesCurrent)
                    continue;
                if (isBannedText(v.title) || isBannedText(v.original_text) || isBannedText(v.summary)) {
                    toRemoveKeys.push(k);
                    continue;
                }
                items.push({ ...v, normalized_page: normalizedItem });
            }
            const finalizeRender = () => {
                currentSavedItems = items.map((entry) => ({ ...entry }));
                try {
                    ensureMarkersForItems(currentSavedItems);
                }
                catch (_) { }
                renderSavedItems(items);
            };
            const maybeRemoveBanned = () => {
                if (!toRemoveKeys.length) {
                    finalizeRender();
                    return;
                }
                try {
                    storage.remove(toRemoveKeys, () => {
                        finalizeRender();
                    });
                }
                catch (_) {
                    finalizeRender();
                }
            };
            if (Object.keys(updates).length) {
                try {
                    storage.set(updates, () => {
                        maybeRemoveBanned();
                    });
                }
                catch (_) {
                    maybeRemoveBanned();
                }
            }
            else {
                maybeRemoveBanned();
            }
        }
        catch (_) { /* ignore */ }
    });
}
function renderSavedItems(items) {
    // Use ensurePanelHost() to obtain the ShadowRoot reference (we attach with closed mode)
    const shadow = ensurePanelHost();
    const container = shadow.getElementById('ia-saved-list');
    if (!container)
        return;
    container.innerHTML = '';
    if (!items || !items.length) {
        const p = document.createElement('div');
        p.textContent = 'No hay elementos guardados en esta página.';
        p.style.color = '#666';
        container.appendChild(p);
        return;
    }
    items.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')).reverse();
    for (const it of items) {
        const row = document.createElement('div');
        row.style.border = '1px solid #eee';
        row.style.padding = '8px';
        row.style.borderRadius = '6px';
        row.style.background = '#fafafa';
    // Apply nicer font and spacing for saved-item cards
    row.style.fontFamily = "Inter, 'Segoe UI', Roboto, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";
    row.style.fontSize = '13px';
    row.style.color = '#0f172a';
        const title = document.createElement('div');
        title.textContent = it.title || (it.original_text || '').slice(0, 80);
        title.style.fontWeight = '600';
        title.style.marginBottom = '6px';
    title.style.fontFamily = row.style.fontFamily;
        // For space savings: do not render any summary under the title.
        // The full saved text will be revealed only when the user clicks "Ver texto".
    // Create the full text element but don't append it to the card yet.
    // It will be inserted only when the user clicks "Ver texto".
    const messageLine = document.createElement('div');
    messageLine.textContent = it.original_text || it.summary || 'No se encontró el texto original.';
    messageLine.style.marginBottom = '8px';
    messageLine.style.padding = '8px';
    messageLine.style.borderRadius = '4px';
    messageLine.style.background = '#eef2ff';
    messageLine.style.whiteSpace = 'pre-wrap';
        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '8px';
    const viewBtn = document.createElement('button');
    viewBtn.textContent = 'Ver texto';
        viewBtn.style.cursor = 'pointer';
        viewBtn.style.padding = '6px 8px';
        viewBtn.style.border = 'none';
        viewBtn.style.background = '#2563eb';
        viewBtn.style.color = '#fff';
        viewBtn.style.borderRadius = '4px';
        viewBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            // If messageLine is attached, remove it; otherwise insert it before the actions node.
            if (messageLine.parentNode === row) {
                row.removeChild(messageLine);
                viewBtn.textContent = 'Ver texto';
            }
            else {
                // insert message before the actions container
                row.insertBefore(messageLine, actions);
                // ensure it's visible
                messageLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
                viewBtn.textContent = 'Ocultar texto';
            }
        });
        actions.appendChild(viewBtn);
        const navBtn = document.createElement('button');
        navBtn.textContent = 'Ir al mensaje';
        navBtn.style.cursor = 'pointer';
        navBtn.style.padding = '6px 8px';
        navBtn.style.border = 'none';
        navBtn.style.background = '#1e40af';
        navBtn.style.color = '#fff';
        navBtn.style.borderRadius = '4px';
        navBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const sid = it.source_id;
            try {
                ensureMarkersForItems([it]);
            }
            catch (_) { }
            navBtn.disabled = true;
            navBtn.textContent = 'Buscando...';
            const snippetText = it.original_text || it.summary || it.title || '';
            scrollToSource(sid, snippetText).then(ok => {
                if (!ok) {
                    safeSendMessage({ type: 'NAVIGATE_TO_SOURCE', payload: { pageUrl: it.pageUrl || location.href, sourceId: sid } }, (r) => {
                        if (r && r.ok) {
                            navBtn.textContent = r.openedNewTab ? 'Abriendo...' : 'Ir al mensaje';
                            setTimeout(() => {
                                navBtn.textContent = 'Ir al mensaje';
                                navBtn.disabled = false;
                            }, 1200);
                        }
                        else {
                            navBtn.textContent = 'No encontrado';
                            setTimeout(() => {
                                navBtn.textContent = 'Ir al mensaje';
                                navBtn.disabled = false;
                            }, 1500);
                        }
                    });
                }
                else {
                    setTimeout(() => {
                        navBtn.textContent = 'Ir al mensaje';
                        navBtn.disabled = false;
                    }, 500);
                }
            }).catch(() => {
                navBtn.textContent = 'No encontrado';
                setTimeout(() => {
                    navBtn.textContent = 'Ir al mensaje';
                    navBtn.disabled = false;
                }, 1500);
            });
        });
        actions.appendChild(navBtn);
        const delBtn = document.createElement('button');
        delBtn.textContent = 'Eliminar';
        delBtn.style.cursor = 'pointer';
        delBtn.style.padding = '6px 8px';
        delBtn.style.border = '1px solid #ddd';
        delBtn.style.background = '#fff';
        delBtn.style.borderRadius = '4px';
        delBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            try {
                safeSendMessage({ type: 'DELETE_SAVED_ITEM', payload: { sourceId: it.source_id } }, (r) => { if (r && r.ok) {
                    loadSavedItemsForPage();
                    loadMindMapForPage();
                } });
            }
            catch (_) { }
        });
    actions.appendChild(delBtn);
    row.appendChild(title);
    // summary intentionally omitted to save space; full text appears only via "Ver texto"
    row.appendChild(actions);
        container.appendChild(row);
    }
}
// Listen to storage changes so panel updates when new items are saved elsewhere
try {
    const storageArea = globalThis.chrome?.storage;
    if (storageArea && typeof storageArea.onChanged?.addListener === 'function') {
        storageArea.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local')
                return;
            // refresh both map and saved items (cheap)
            try {
                loadMindMapForPage();
            }
            catch (_) { }
            try {
                loadSavedItemsForPage();
            }
            catch (_) { }
        });
    }
}
catch (_) { }
function locateSourceElement(sourceId) {
    if (!sourceId)
        return null;
    let el = document.querySelector(`[data-source-id="${sourceId}"]`);
    if (!(el instanceof HTMLElement))
        el = null;
    if (!el) {
        const candidates = Array.from(document.querySelectorAll('[data-source-id],[data-message-id]'));
        for (const candidate of candidates) {
            if (!(candidate instanceof HTMLElement))
                continue;
            const ds = candidate.dataset || {};
            if (ds.sourceId === sourceId || ds.messageId === sourceId) {
                el = candidate;
                break;
            }
        }
    }
    return el || null;
}
let highlightStyleInjected = false;
let currentHighlightCleanup = null;
function ensureHighlightStyle() {
    if (highlightStyleInjected)
        return;
    const style = document.createElement('style');
    style.id = 'ia-highlight-style';
    style.textContent = `.ia-highlight-match, .ia-highlight-block { background-color: #fef08a !important; box-shadow: 0 0 0 2px rgba(234, 179, 8, 0.35); transition: background-color 0.4s ease; }`;
    (document.head || document.documentElement).appendChild(style);
    highlightStyleInjected = true;
}

function clearCurrentHighlight() {
    if (typeof currentHighlightCleanup === 'function') {
        try {
            currentHighlightCleanup();
        }
        catch (_) { }
    }
    currentHighlightCleanup = null;
}
function getHighlightTarget(el) {
    if (!el || !(el instanceof HTMLElement))
        return null;
    const rect = el.getBoundingClientRect();
    const hasVisibleArea = rect && rect.width > 0 && rect.height > 0 && Boolean(el.textContent?.trim());
    if (hasVisibleArea)
        return el;
    if (typeof el.closest === 'function') {
        const container = el.closest(MESSAGE_CONTAINER_SELECTOR);
        if (container && container instanceof HTMLElement)
            return container;
    }
    return el;
}
function buildNormalizedMap(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const chars = [];
    const mapping = [];
    let lastWasSpace = false;
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.nodeValue || '';
        if (!text)
            continue;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const isSpace = /\s/.test(ch);
            if (isSpace) {
                if (lastWasSpace)
                    continue;
                lastWasSpace = true;
                chars.push(' ');
                mapping.push({ node, offset: i });
            }
            else {
                lastWasSpace = false;
                chars.push(ch.toLowerCase());
                mapping.push({ node, offset: i });
            }
        }
    }
    return { normalized: chars.join(''), mapping };
}

function findSnippetRange(root, snippetText) {
    const normalizedSnippet = normalizeForSearch(snippetText);
    if (!normalizedSnippet)
        return null;
    const { normalized, mapping } = buildNormalizedMap(root);
    if (!normalized)
        return null;
    const index = normalized.indexOf(normalizedSnippet);
    if (index === -1)
        return null;
    const startMap = mapping[index];
    const endMap = mapping[index + normalizedSnippet.length - 1];
    if (!startMap || !endMap)
        return null;
    const range = document.createRange();
    range.setStart(startMap.node, startMap.offset);
    const endNode = endMap.node;
    const endText = endNode.nodeValue || '';
    const endOffset = Math.min(endText.length, endMap.offset + 1);
    range.setEnd(endNode, endOffset);
    return range;
}

function applySnippetHighlight(el, snippetText) {
    const range = findSnippetRange(el, snippetText);
    if (!range)
        return null;
    const span = document.createElement('span');
    span.className = 'ia-highlight-match';
    try {
        const extracted = range.extractContents();
        if (!extracted.childNodes.length)
            return null;
        span.appendChild(extracted);
        range.insertNode(span);
    }
    catch (_) {
        return null;
    }
    const cleanup = () => {
        if (!span.parentNode)
            return;
        const parent = span.parentNode;
        while (span.firstChild)
            parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
    };
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return { element: span, cleanup };
}

function highlightElement(el, snippetText) {
    ensureHighlightStyle();
    clearCurrentHighlight();
    if (el instanceof HTMLElement) {
        const snippetResult = applySnippetHighlight(el, snippetText);
        if (snippetResult) {
            currentHighlightCleanup = snippetResult.cleanup;
            setTimeout(() => {
                if (currentHighlightCleanup === snippetResult.cleanup) {
                    try {
                        currentHighlightCleanup();
                    }
                    catch (_) { }
                    currentHighlightCleanup = null;
                }
            }, 4000);
            return true;
        }
    }
    const target = getHighlightTarget(el);
    if (!target)
        return false;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('ia-highlight-block');
    const cleanup = () => target.classList.remove('ia-highlight-block');
    currentHighlightCleanup = cleanup;
    setTimeout(() => {
        if (currentHighlightCleanup === cleanup) {
            cleanup();
            currentHighlightCleanup = null;
        }
    }, 4000);
    return true;
}
async function scrollToSource(sourceId, snippetText) {
    try {
        let el = locateSourceElement(sourceId);
        if (!el && currentSavedItems.length) {
            try {
                ensureMarkersForItems(currentSavedItems);
            }
            catch (_) { }
            el = locateSourceElement(sourceId);
        }
        if (!el)
            return false;
        return highlightElement(el, snippetText);
    }
    catch (e) {
        return false;
    }
}
// Message listener
if (chromeRuntime && chromeRuntime.onMessage && typeof chromeRuntime.onMessage.addListener === 'function') {
    chromeRuntime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || !msg.type)
            return;
        switch (msg.type) {
            case 'TOGGLE_SIDE_PANEL': {
                const host = document.getElementById(IDS.PANEL_HOST);
                if (host) {
                    destroyPanel();
                    sendResponse?.({ ok: true, inPage: false });
                }
                else {
                    ensurePanelHost();
                    loadMindMapForPage();
                    sendResponse?.({ ok: true, inPage: true });
                }
                break;
            }
            case 'MIND_MAP_UPDATED': {
                try {
                    loadMindMapForPage();
                }
                catch (_) { }
                break;
            }
            case 'SCROLL_TO_SOURCE': {
                const sid = msg.payload?.sourceId;
                const snippetText = msg.payload?.snippet;
                if (!sid) {
                    sendResponse?.({ ok: false, error: 'missing_source_id' });
                    break;
                }
                scrollToSource(sid, snippetText).then(ok => sendResponse?.({ ok })).catch(() => sendResponse?.({ ok: false }));
                return true;
            }
            default: break;
        }
        return undefined;
    });
}
// Small bootstrap: try to create selection button listeners later if desired. For now just ensure listener exists.
// Expose nothing; keep minimal.
// --- Selection and fragment save buttons -----------------------------------
const MESSAGE_SELECTORS = [
    'div[data-testid="message"]', 'article', 'div[class*="assistant-response"]', 'gc-message', 'div[class*="response"]', 'div[class*="message"]'
];
const MESSAGE_CONTAINER_SELECTOR = MESSAGE_SELECTORS.join(',');
const MIN_TEXT_LENGTH = 60;
const MIN_FRAGMENT_LENGTH = 30;
function safeSendMessage(message, cb) {
    try {
        if (!chromeRuntime || !chromeRuntime.sendMessage) {
            if (cb)
                setTimeout(() => cb({ ok: false, error: 'runtime_unavailable' }), 0);
            return;
        }
        chromeRuntime.sendMessage(message, (resp) => { if (cb)
            cb(resp); });
    }
    catch (e) {
        if (cb)
            setTimeout(() => cb({ ok: false, error: String(e) }), 0);
    }
}
// Selection save button
let selectionBtn = null;
let selectionTimer;
function makeSelectionButton() {
    if (selectionBtn)
        return selectionBtn;
    const b = document.createElement('button');
    b.id = 'ia-selection-save-btn';
    b.type = 'button';
    b.textContent = 'Guardar selección';
    Object.assign(b.style, {
        position: 'fixed', zIndex: '2147483647', padding: '6px 10px', display: 'none', background: '#fff', border: '1px solid #ddd', cursor: 'pointer'
    });
    b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const s = window.getSelection();
        const txt = s?.toString().trim() || '';
        if (!txt || txt.length < MIN_FRAGMENT_LENGTH) {
            hideSelectionButton();
            return;
        }
        const id = `sel-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        // insert invisible marker at end of selection to enable later navigation
        try {
            const range = s.getRangeAt(0).cloneRange();
            range.collapse(false);
            const marker = document.createElement('span');
            marker.dataset.sourceId = id;
            marker.className = 'ia-source-marker';
            marker.style.display = 'inline-block';
            marker.style.width = '0';
            marker.style.height = '0';
            marker.style.overflow = 'hidden';
            range.insertNode(marker);
        }
        catch (e) { /* ignore insertion errors */ }
        safeSendMessage({ type: 'SAVE_CHAT_DATA', payload: { sourceId: id, messageText: txt, pageUrl: location.href } }, (r) => {
            try {
                if (r && (r.ok || r.item)) {
                    b.textContent = 'Guardado';
                }
                else {
                    b.textContent = 'Error';
                }
                try {
                    loadMindMapForPage();
                }
                catch (_) { }
                try {
                    loadSavedItemsForPage();
                }
                catch (_) { }
            }
            catch (_) { }
            setTimeout(() => { hideSelectionButton(); b.textContent = 'Guardar selección'; }, 900);
        });
        s?.removeAllRanges();
    });
    document.body.appendChild(b);
    selectionBtn = b;
    return b;
}
function showSelectionButtonAt(rect) {
    const b = makeSelectionButton();
    const x = Math.min(window.innerWidth - 12, Math.max(8, rect.right + window.scrollX - 8));
    const y = Math.max(8, rect.top + window.scrollY - 34);
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
    b.style.display = 'block';
}
function hideSelectionButton() { if (!selectionBtn)
    return; selectionBtn.style.display = 'none'; }
document.addEventListener('selectionchange', () => {
    if (selectionTimer)
        clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => {
        const s = window.getSelection();
        if (!s || s.rangeCount === 0)
            return hideSelectionButton();
        const txt = s.toString().trim();
        if (!txt || txt.length < MIN_FRAGMENT_LENGTH)
            return hideSelectionButton();
        try {
            const r = s.getRangeAt(0);
            let rect = r.getBoundingClientRect();
            if ((!rect || (rect.width === 0 && rect.height === 0)) && r.getClientRects().length)
                rect = r.getClientRects()[0];
            if (!rect)
                return hideSelectionButton();
            showSelectionButtonAt(rect);
        }
        catch (e) {
            hideSelectionButton();
        }
    }, 120);
});
// Fragment and message buttons
const injected = new WeakSet();
function isInteractive(el) {
    const t = el.tagName.toLowerCase();
    if (['button', 'input', 'textarea', 'select', 'a'].includes(t))
        return true;
    const role = el.getAttribute('role');
    return role === 'button' || role === 'link';
}
function findExistingSourceElement(sourceId) {
    const all = document.querySelectorAll('[data-source-id]');
    for (const el of Array.from(all)) {
        const ds = (el.dataset || {});
        if (ds.sourceId === sourceId)
            return el;
    }
    return null;
}
function ensureMarkerForItem(item) {
    if (!item || !item.source_id)
        return;
    const sourceId = String(item.source_id);
    if (!sourceId)
        return;
    if (findExistingSourceElement(sourceId))
        return;
    const rawSnippet = String(item.original_text || item.summary || item.title || '').trim();
    if (!rawSnippet)
        return;
    const snippetSlice = rawSnippet.length > 320 ? rawSnippet.slice(0, 320) : rawSnippet;
    const normalizedFull = normalizeForSearch(snippetSlice);
    if (!normalizedFull)
        return;
    const segments = [];
    const addSegment = (seg) => {
        const s = seg.trim();
        if (!s)
            return;
        if (!segments.includes(s))
            segments.push(s);
    };
    addSegment(normalizedFull);
    if (normalizedFull.length > 200)
        addSegment(normalizedFull.slice(0, 200));
    if (normalizedFull.length > 140)
        addSegment(normalizedFull.slice(0, 140));
    if (normalizedFull.length > 80)
        addSegment(normalizedFull.slice(0, 80));
    const matches = (text) => {
        const norm = normalizeForSearch(text || '');
        if (!norm)
            return false;
        return segments.some(seg => {
            if (!seg)
                return false;
            if (seg.length >= 24)
                return norm.includes(seg);
            // For very short segments require whole-word match to reduce false positives
            const words = seg.split(' ').filter(Boolean);
            if (!words.length)
                return false;
            return words.every(w => norm.includes(w));
        });
    };
    const attachToElement = (el) => {
        try {
            el.dataset.sourceId = sourceId;
        }
        catch (_) {
            el.setAttribute('data-source-id', sourceId);
        }
    };
    const seen = new Set();
    const gatherElements = (selectors, scope) => {
        for (const sel of selectors) {
            try {
                const nodes = scope.querySelectorAll?.(sel);
                if (!nodes)
                    continue;
                for (const node of Array.from(nodes)) {
                    if (node instanceof HTMLElement && !seen.has(node)) {
                        seen.add(node);
                    }
                }
            }
            catch (_) { /* ignore */ }
        }
    };
    gatherElements(MESSAGE_SELECTORS, document);
    const orderedCandidates = Array.from(seen);
    const subSelectors = ['p', 'li', 'blockquote', 'div', 'span', 'section', 'article'];
    const subSelectorString = subSelectors.join(',');
    const tryCandidates = (elements) => {
        for (const el of elements) {
            if (!el || isInteractive(el))
                continue;
            if (matches(el.textContent || '')) {
                attachToElement(el);
                return true;
            }
        }
        return false;
    };
    if (tryCandidates(orderedCandidates))
        return;
    const childCandidates = [];
    for (const parent of orderedCandidates) {
        try {
            for (const child of Array.from(parent.querySelectorAll(subSelectorString))) {
                if (child instanceof HTMLElement && !isInteractive(child) && !childCandidates.includes(child))
                    childCandidates.push(child);
            }
        }
        catch (_) { /* ignore */ }
    }
    if (tryCandidates(childCandidates))
        return;
    const fallback = Array.from(document.querySelectorAll(subSelectorString));
    tryCandidates(fallback);
}
function ensureMarkersForItems(items) {
    if (!Array.isArray(items) || !items.length)
        return;
    for (const item of items)
        ensureMarkerForItem(item);
}
function createFloatingButton(scope) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ia-save-btn';
    b.textContent = '💾';
    Object.assign(b.style, { position: 'absolute', right: '0px', top: '6px', transform: 'translateX(100%)', padding: '4px 6px', fontSize: '12px', borderRadius: '6px', border: 'none', cursor: 'pointer', background: scope === 'message' ? '#2563eb' : '#7c3aed', color: '#fff' });
    b.addEventListener('mouseenter', () => b.style.opacity = '1');
    b.addEventListener('mouseleave', () => b.style.opacity = '0.92');
    return b;
}
function injectInto(container) {
    try {
        if (container.querySelector('.ia-save-btn'))
            return;
        const fullText = (container.textContent || '').trim();
        if (fullText.length < MIN_TEXT_LENGTH)
            return;
        let sourceId = container.dataset?.sourceId || container.dataset?.messageId || '';
        if (!sourceId) {
            sourceId = `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
            try {
                container.dataset.sourceId = sourceId;
            }
            catch { }
            ;
        }
        // message-level button
        if (!container.querySelector('.ia-save-btn[data-scope="message"]')) {
            const mb = createFloatingButton('message');
            mb.dataset.scope = 'message';
            mb.addEventListener('click', (ev) => {
                ev.stopPropagation();
                mb.textContent = 'Guardando...';
                safeSendMessage({ type: 'SAVE_CHAT_DATA', payload: { sourceId, messageText: (container.textContent || '').trim(), pageUrl: location.href } }, (r) => {
                    try {
                        if (r && (r.ok || r.item)) {
                            mb.textContent = 'Guardado';
                        }
                        else {
                            mb.textContent = 'Error';
                        }
                        loadMindMapForPage();
                        loadSavedItemsForPage();
                    }
                    catch { }
                    setTimeout(() => { mb.textContent = '💾'; }, 1000);
                });
            });
            try {
                container.style.position = container.style.position || 'relative';
                container.insertBefore(mb, container.firstChild || null);
            }
            catch { }
        }
        // fragment candidates
        const candidates = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,div')).filter(n => n instanceof HTMLElement && !injected.has(n) && !n.querySelector('.ia-save-btn') && (n.textContent || '').trim().length >= MIN_FRAGMENT_LENGTH && !isInteractive(n));
        for (const c of candidates) {
            injected.add(c);
            const fid = `${sourceId}::frag::${Date.now()}-${Math.floor(Math.random() * 10000)}`;
            const fb = createFloatingButton('fragment');
            fb.dataset.scope = 'fragment';
            fb.addEventListener('click', (ev) => {
                ev.stopPropagation();
                fb.textContent = 'Guardando...';
                const snippet = (c.textContent || '').trim() || fullText;
                try {
                    c.dataset.sourceId = fid;
                }
                catch { }
                ;
                safeSendMessage({ type: 'SAVE_CHAT_DATA', payload: { sourceId: fid, messageText: snippet, pageUrl: location.href } }, (r) => {
                    try {
                        if (r && (r.ok || r.item)) {
                            fb.textContent = 'Guardado';
                        }
                        else {
                            fb.textContent = 'Error';
                        }
                        loadMindMapForPage();
                        loadSavedItemsForPage();
                    }
                    catch { }
                    setTimeout(() => { fb.textContent = '💾'; }, 1000);
                });
            });
            try {
                c.style.position = c.style.position || 'relative';
                c.appendChild(fb);
            }
            catch { }
        }
    }
    catch (e) { /* ignore injection errors */ }
}
function scan(root) {
    for (const s of MESSAGE_SELECTORS) {
        let nodes = null;
        try {
            nodes = root.querySelectorAll?.(s) ?? null;
        }
        catch {
            nodes = null;
        }
        if (!nodes)
            continue;
        nodes.forEach(n => { if (n instanceof HTMLElement)
            injectInto(n); });
    }
}
const observer = new MutationObserver(ms => {
    let shouldEnsure = false;
    for (const m of ms) {
        for (const n of Array.from(m.addedNodes)) {
            if (n.querySelector) {
                scan(n);
                shouldEnsure = true;
            }
        }
    }
    if (shouldEnsure && currentSavedItems.length) {
        try {
            ensureMarkersForItems(currentSavedItems);
        }
        catch (_) { }
    }
});
try {
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
}
catch (e) { }
// initial pass
try {
    scan(document);
    loadMindMapForPage();
    loadSavedItemsForPage();
}
catch (e) { }
let lastKnownPageKey = getNormalizedPageKey();
function handlePossiblePageChange(force = false) {
    try {
        const current = getNormalizedPageKey();
        if (!force && current === lastKnownPageKey)
            return;
        lastKnownPageKey = current;
        currentSavedItems = [];
        try {
            loadMindMapForPage();
        }
        catch (_) { }
        try {
            loadSavedItemsForPage();
        }
        catch (_) { }
    }
    catch (_) {
        // ignore errors during route change detection
    }
}
function patchHistoryMethod(method) {
    try {
        const original = history[method];
        if (typeof original !== 'function')
            return;
        history[method] = function patchedHistory(...args) {
            const result = original.apply(this, args);
            setTimeout(() => handlePossiblePageChange(false), 50);
            return result;
        };
    }
    catch (_) { /* ignore */ }
}
patchHistoryMethod('pushState');
patchHistoryMethod('replaceState');
window.addEventListener('popstate', () => setTimeout(() => handlePossiblePageChange(false), 50));
window.addEventListener('hashchange', () => handlePossiblePageChange(false));
setInterval(() => handlePossiblePageChange(false), 1500);
