// Content script: injects an in-page side panel and responds to background/popup messages.
// Minimal, robust implementation to ensure the panel opens in the same tab and
// SCROLL_TO_SOURCE messages are handled to scroll/highlight saved fragments.
const IDS = {
    PANEL_HOST: 'ia-sidepanel-host',
    PANEL_CONTENT: 'ia-sidepanel-content'
};
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
    const key = location.origin + location.pathname.replace(/\/+$/, '');
    storage.get(['mindMaps'], (res) => {
        try {
            const maps = res?.mindMaps || {};
            const entry = maps[key] || null;
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
            const normalizedHere = (location.origin + location.pathname.replace(/\/+$/, ''));
            for (const [k, v] of Object.entries(all || {})) {
                try {
                    if (!v || typeof v !== 'object')
                        continue;
                    // saved snippet objects have source_id
                    if (v.source_id) {
                        const itemNormalized = v.normalized_page || (v.pageUrl ? (new URL(v.pageUrl)).origin + (new URL(v.pageUrl)).pathname.replace(/\/+$/, '') : null);
                        if (!itemNormalized)
                            continue;
                        if (itemNormalized === normalizedHere) {
                            // if item contains banned phrase, schedule removal
                            if (isBannedText(v.title) || isBannedText(v.original_text) || isBannedText(v.summary)) {
                                toRemoveKeys.push(k);
                                continue;
                            }
                            items.push(v);
                        }
                    }
                }
                catch (_) {
                    continue;
                }
            }
            if (toRemoveKeys.length) {
                try {
                    storage.remove(toRemoveKeys, () => {
                        // ignore errors; proceed to render remaining items
                        renderSavedItems(items);
                    });
                    return;
                }
                catch (_) {
                    // fallthrough to render
                }
            }
            renderSavedItems(items);
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
        const title = document.createElement('div');
        title.textContent = it.title || (it.original_text || '').slice(0, 80);
        title.style.fontWeight = '600';
        title.style.marginBottom = '6px';
        const txt = document.createElement('div');
        txt.textContent = (it.summary || it.original_text || '').slice(0, 240);
        txt.style.fontSize = '12px';
        txt.style.color = '#333';
        txt.style.marginBottom = '8px';
        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '8px';
        const goBtn = document.createElement('button');
        goBtn.textContent = 'Ir al mensaje';
        goBtn.style.cursor = 'pointer';
        goBtn.style.padding = '6px 8px';
        goBtn.style.border = 'none';
        goBtn.style.background = '#2563eb';
        goBtn.style.color = '#fff';
        goBtn.style.borderRadius = '4px';
        goBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const sid = it.source_id;
            // Try to scroll in-page first
            scrollToSource(sid).then(ok => {
                if (!ok) {
                    // send NAVIGATE_TO_SOURCE to background to try find tab
                    safeSendMessage({ type: 'NAVIGATE_TO_SOURCE', payload: { pageUrl: it.pageUrl || location.href, sourceId: sid } }, (r) => {
                        if (r && r.ok && r.inPage) {
                            // nothing else to do
                        }
                        else {
                            // provide visual feedback
                            goBtn.textContent = 'No encontrado';
                            setTimeout(() => goBtn.textContent = 'Ir al mensaje', 1400);
                        }
                    });
                }
            }).catch(() => { });
        });
        actions.appendChild(goBtn);
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
        row.appendChild(txt);
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
async function scrollToSource(sourceId) {
    try {
        let el = document.querySelector(`[data-source-id="${sourceId}"]`);
        if (!el)
            el = Array.from(document.querySelectorAll('[data-source-id],[data-message-id]')).find(e => e.dataset.sourceId === sourceId || e.dataset.messageId === sourceId) || null;
        if (!el)
            return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const prev = el.style.outline;
        el.style.outline = '3px solid #f97316';
        setTimeout(() => { el.style.outline = prev; }, 2500);
        return true;
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
                if (!sid) {
                    sendResponse?.({ ok: false, error: 'missing_source_id' });
                    break;
                }
                scrollToSource(sid).then(ok => sendResponse?.({ ok })).catch(() => sendResponse?.({ ok: false }));
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
                safeSendMessage({ type: 'SAVE_CHAT_DATA', payload: { sourceId: fid, messageText: snippet, pageUrl: location.href } }, (r) => { try {
                    if (r && (r.ok || r.item)) {
                        fb.textContent = 'Guardado';
                    }
                    else {
                        fb.textContent = 'Error';
                    }
                    loadMindMapForPage();
                }
                catch { } ; setTimeout(() => { fb.textContent = '💾'; }, 1000); });
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
    for (const m of ms)
        for (const n of Array.from(m.addedNodes))
            if (n.querySelector)
                scan(n);
});
try {
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
}
catch (e) { }
// initial pass
try {
    scan(document);
    loadMindMapForPage();
}
catch (e) { }
