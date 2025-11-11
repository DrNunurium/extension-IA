// Content script: injects an in-page side panel and responds to background/popup messages.
// Minimal, robust implementation to ensure the panel opens in the same tab and
// SCROLL_TO_SOURCE messages are handled to scroll/highlight saved fragments.
// @ts-nocheck
const IDS = {
    PANEL_HOST: 'ia-sidepanel-host',
    PANEL_CONTENT: 'ia-sidepanel-content'
};
const PANEL_FONT = "'Roboto','Noto Sans','Segoe UI',Arial,sans-serif";
let currentSavedItems = [];
let currentSearchQuery = '';
let searchInputEl = null;
const chromeRuntime = globalThis.chrome?.runtime ?? null;
const PANEL_STYLE_ID = 'ia-panel-theme';
let panelHostElement = null;
let panelShadowRoot = null;
let panelKeydownHandler = null;
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
    const candidate = typeof url === 'string' && url ? url : globalThis.location?.href ?? '';
    const normalized = normalizeUrlString(candidate);
    return normalized ?? candidate;
}

function normalizeForSearch(text) {
    if (!text)
        return '';
    return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function getChromeThemeColors() {
    const prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
    if (prefersDark) {
        return {
            isDark: true,
            panelBg: '#202124',
            cardBg: '#2d2f31',
            cardBorder: 'rgba(223,225,229,0.12)',
            cardShadow: '0 1px 2px rgba(0,0,0,0.25)',
            textPrimary: '#e8eaed',
            textSecondary: '#9aa0a6',
            inputBg: '#303134',
            inputBorder: 'rgba(223,225,229,0.16)',
            inputText: '#e8eaed',
            accent: '#8ab4f8',
            accentText: '#202124',
            messageBg: 'rgba(138,180,248,0.18)'
        };
    }
    return {
        isDark: false,
        panelBg: '#ffffff',
        cardBg: '#f8f9fa',
        cardBorder: 'rgba(60,64,67,0.2)',
        cardShadow: '0 1px 2px rgba(60,64,67,0.3)',
        textPrimary: '#202124',
        textSecondary: '#5f6368',
        inputBg: '#ffffff',
        inputBorder: 'rgba(60,64,67,0.26)',
        inputText: '#202124',
        accent: '#1a73e8',
        accentText: '#ffffff',
        messageBg: 'rgba(26,115,232,0.12)'
    };
}

function applyPanelChromeStyles(shadow, colors) {
    if (!shadow)
        return;
    let styleEl = shadow.getElementById(PANEL_STYLE_ID);
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = PANEL_STYLE_ID;
        shadow.appendChild(styleEl);
    }
    styleEl.textContent = `
        /* keep host layout and inline styles intact; only set font and color */
        :host {
            font-family: ${PANEL_FONT};
            color: ${colors.textPrimary};
        }
        *, *::before, *::after {
            box-sizing: border-box;
            font-family: inherit;
        }
        #${IDS.PANEL_CONTENT} {
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            height: 100%;
            width: 100%;
            background: ${colors.panelBg};
            color: ${colors.textPrimary};
            overflow-y: auto;
            overscroll-behavior: contain;
        }
        #${IDS.PANEL_CONTENT}::-webkit-scrollbar {
            width: 12px;
        }
        #${IDS.PANEL_CONTENT}::-webkit-scrollbar-thumb {
            background-color: ${colors.isDark ? '#5f6368' : '#c4c7c9'};
            border-radius: 999px;
            border: 3px solid ${colors.panelBg};
        }
        #${IDS.PANEL_CONTENT}::-webkit-scrollbar-track {
            background: ${colors.isDark ? '#202124' : '#f1f3f4'};
        }
    `;
}

// Attempt to patch page-level KaTeX/MathJax by asking the background script to
// run the sanitizer in the page context via scripting.executeScript. Inline
// script injection is blocked by many page CSPs, so we avoid creating
// script.textContent to prevent CSP failures.
function injectMathSanitizer() {
    try {
        if (!chromeRuntime || !chromeRuntime.sendMessage) return;
        // Ask background to execute the sanitizer in the page (background will
        // use chrome.scripting.executeScript targeting this tab). We don't need
        // the response except for logging.
        chromeRuntime.sendMessage({ type: 'INJECT_MATH_SANITIZER' }, (resp) => {
            try {
                // resp may be { ok: true } or an error object
                if (!resp || !resp.ok) {
                    console.debug('Math sanitizer injection reported failure or no response', resp);
                }
            }
            catch (e) { /* ignore */ }
        });
    }
    catch (e) { /* ignore */ }
}

// Ask the background to inject the sanitizer early
try { injectMathSanitizer(); } catch (e) { /* ignore */ }

function applyPanelHostFrame(colors) {
    if (!panelHostElement)
        return;
    // thicker border to match active-window color
    panelHostElement.style.border = `6px solid ${colors.accent}`;
    panelHostElement.style.background = colors.panelBg;
    panelHostElement.style.boxShadow = colors.isDark
        ? '0 6px 18px rgba(0,0,0,0.45)'
        : '0 6px 18px rgba(32,33,36,0.18)';
}

function getBrowserAccentColor(timeoutMs = 300) {
    return new Promise((resolve) => {
        try {
            if (!chromeRuntime || !chromeRuntime.sendMessage) {
                resolve(null);
                return;
            }
            let done = false;
            const timer = setTimeout(() => {
                if (done)
                    return;
                done = true;
                resolve(null);
            }, timeoutMs);
            chromeRuntime.sendMessage({ type: 'GET_CHROME_ACTIVE_COLOR' }, (resp) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                try {
                    if (resp && resp.color)
                        resolve(String(resp.color));
                    else
                        resolve(null);
                }
                catch (_) {
                    resolve(null);
                }
            });
        }
        catch (_) { resolve(null); }
    });
}

function ensurePanelHost() {
    if (panelShadowRoot && panelHostElement && panelHostElement.isConnected) {
        const existing = panelShadowRoot.getElementById(IDS.PANEL_CONTENT);
        if (!existing) {
            const content = document.createElement('div');
            content.id = IDS.PANEL_CONTENT;
            panelShadowRoot.appendChild(content);
        }
        return panelShadowRoot;
    }
    if (!document.body)
        return null;
    const hostColors = getChromeThemeColors();
    if (!panelHostElement || !panelHostElement.isConnected) {
        const existingHost = document.getElementById(IDS.PANEL_HOST);
        if (existingHost) {
            try {
                existingHost.remove();
            }
            catch (_) { }
        }
        panelHostElement = document.createElement('div');
        panelHostElement.id = IDS.PANEL_HOST;
        Object.assign(panelHostElement.style, {
            position: 'fixed',
            top: '0',
            right: '0',
            width: '360px',
            maxWidth: 'min(360px, 40vw)',
            height: '100vh',
            zIndex: '2147483645',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 0 16px rgba(0,0,0,0.18)'
        });
        document.body.appendChild(panelHostElement);
    }
    try {
        panelShadowRoot = panelHostElement.shadowRoot || panelHostElement.attachShadow({ mode: 'open' });
    }
    catch (_) {
        panelShadowRoot = null;
        return null;
    }
    panelShadowRoot.innerHTML = '';
    const baseStyle = document.createElement('style');
    baseStyle.textContent = `
        :host, :host * {
            box-sizing: border-box;
        }
    `;
    panelShadowRoot.appendChild(baseStyle);
    const content = document.createElement('div');
    content.id = IDS.PANEL_CONTENT;
    content.style.boxSizing = 'border-box';
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.height = '100%';
    // leave room at the top for the Buy Me a Coffee button so it doesn't
    // overlap the search card
    content.style.paddingTop = '56px';
    panelShadowRoot.appendChild(content);
    // add close button in the top-right corner of the panel
    try {
        // add 'Buy me a coffee' button in the top-left corner
        const buy = document.createElement('button');
        buy.id = 'ia-panel-buyme';
        buy.type = 'button';
        buy.textContent = 'Buy me a coffee ☕';
        Object.assign(buy.style, {
            position: 'absolute',
            top: '8px',
            left: '12px',
            height: '34px',
            padding: '6px 10px',
            borderRadius: '8px',
            border: 'none',
            cursor: 'pointer',
            fontSize: '13px',
            background: '#FFD54F',
            color: '#000000',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
        });
        buy.addEventListener('click', (ev) => {
            ev.stopPropagation();
            // Replace the URL below with your BuyMeACoffee page
            try { window.open('https://www.buymeacoffee.com/yourname', '_blank'); } catch (e) { /* ignore */ }
        });
        panelShadowRoot.appendChild(buy);

        const btn = document.createElement('button');
        btn.id = 'ia-panel-close';
        btn.type = 'button';
        btn.textContent = '✕';
        Object.assign(btn.style, {
            position: 'absolute',
            top: '8px',
            right: '8px',
            width: '34px',
            height: '34px',
            borderRadius: '8px',
            border: 'none',
            background: 'transparent',
            color: hostColors.textSecondary,
            cursor: 'pointer',
            fontSize: '16px',
            lineHeight: '1',
            padding: '0'
        });
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            destroyPanel();
        });
        // keyboard handler: Escape closes panel
        panelKeydownHandler = (e) => {
            if (e.key === 'Escape')
                destroyPanel();
        };
        document.addEventListener('keydown', panelKeydownHandler);
        panelShadowRoot.appendChild(btn);
    }
    catch (_) { }
    return panelShadowRoot;
}

function destroyPanel() {
    try {
        if (panelHostElement) {
            panelHostElement.remove();
        }
    }
    catch (_) { }
    panelHostElement = null;
    panelShadowRoot = null;
    currentSearchQuery = '';
    searchInputEl = null;
    try {
        if (panelKeydownHandler)
            document.removeEventListener('keydown', panelKeydownHandler);
    }
    catch (_) { }
    panelKeydownHandler = null;
}

function createChromeCard(colors) {
    const card = document.createElement('div');
    card.className = 'ia-chrome-card';
    card.style.background = colors.cardBg;
    card.style.border = `1px solid ${colors.cardBorder}`;
    card.style.borderRadius = '12px';
    card.style.padding = '12px';
    card.style.boxShadow = colors.cardShadow;
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '8px';
    card.style.fontFamily = PANEL_FONT;
    return card;
}

function renderMindMap(map) {
    const shadow = ensurePanelHost();
    if (!shadow)
        return;
    const content = shadow.getElementById(IDS.PANEL_CONTENT);
    if (!content)
        return;
    // Base theme colors
    const colors = getChromeThemeColors();
    // Try to fetch the browser active-window color from background; fallback to accent
    getBrowserAccentColor(400).then((browserColor) => {
        const useColors = { ...colors };
        if (browserColor) {
            useColors.accent = browserColor;
        }
        applyPanelHostFrame(useColors);
        applyPanelChromeStyles(shadow, useColors);
        // continue render
        content.innerHTML = '';
        const layout = document.createElement('div');
        layout.style.display = 'flex';
        layout.style.flexDirection = 'column';
        layout.style.gap = '12px';
        layout.style.padding = '12px';
        layout.style.flex = '1';
        layout.style.background = useColors.panelBg;
        const searchCard = createChromeCard(useColors);
        searchCard.id = 'ia-search-card';
        const searchLabel = document.createElement('label');
        searchLabel.textContent = 'Buscar conversaciones';
        searchLabel.style.fontSize = '12px';
        searchLabel.style.color = useColors.textSecondary;
        searchLabel.style.fontWeight = '500';
        searchCard.appendChild(searchLabel);
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.placeholder = 'Buscar por título o contenido';
        searchInput.value = currentSearchQuery;
        Object.assign(searchInput.style, {
            width: '100%',
            padding: '8px 12px',
            borderRadius: '8px',
            border: `1px solid ${useColors.inputBorder}`,
            background: useColors.inputBg,
            color: useColors.inputText,
            fontFamily: PANEL_FONT,
            fontSize: '14px'
        });
        searchInput.addEventListener('keydown', ev => ev.stopPropagation());
        searchInput.addEventListener('input', () => {
            currentSearchQuery = searchInput.value || '';
            renderSavedItems(currentSavedItems);
        });
        searchCard.appendChild(searchInput);
        searchInputEl = searchInput;
        layout.appendChild(searchCard);
        if (map) {
            const mapCard = createChromeCard(useColors);
            mapCard.id = 'ia-map-card';
            const heading = document.createElement('div');
            heading.textContent = map.titulo_central || 'Mapa conceptual';
            heading.style.fontWeight = '600';
            heading.style.fontSize = '15px';
            heading.style.color = useColors.textPrimary;
            mapCard.appendChild(heading);
            if (Array.isArray(map.conceptos_clave) && map.conceptos_clave.length) {
                const sub = document.createElement('div');
                sub.textContent = 'Conceptos clave';
                sub.style.fontSize = '12px';
                sub.style.color = useColors.textSecondary;
                sub.style.fontWeight = '500';
                mapCard.appendChild(sub);
                const list = document.createElement('ul');
                list.style.margin = '0';
                list.style.paddingLeft = '18px';
                list.style.color = useColors.textPrimary;
                list.style.fontSize = '13px';
                map.conceptos_clave.forEach(c => {
                    const li = document.createElement('li');
                    li.textContent = c;
                    li.style.marginBottom = '2px';
                    list.appendChild(li);
                });
                mapCard.appendChild(list);
            }
            if (map.resumen_ejecutivo) {
                const resumeLabel = document.createElement('div');
                resumeLabel.textContent = 'Resumen ejecutivo';
                resumeLabel.style.fontSize = '12px';
                resumeLabel.style.color = useColors.textSecondary;
                resumeLabel.style.fontWeight = '500';
                resumeLabel.style.marginTop = '6px';
                mapCard.appendChild(resumeLabel);
                const resume = document.createElement('p');
                resume.textContent = map.resumen_ejecutivo;
                resume.style.margin = '4px 0 0';
                resume.style.fontSize = '13px';
                resume.style.color = useColors.textPrimary;
                resume.style.lineHeight = '1.5';
                mapCard.appendChild(resume);
            }
            layout.appendChild(mapCard);
        }
        const savedCard = createChromeCard(useColors);
        savedCard.id = 'ia-saved-card';
        const savedTitle = document.createElement('div');
        savedTitle.textContent = 'Conversaciones guardadas';
        savedTitle.style.fontWeight = '600';
        savedTitle.style.fontSize = '15px';
        savedTitle.style.color = useColors.textPrimary;
        savedCard.appendChild(savedTitle);
        const savedList = document.createElement('div');
        savedList.id = 'ia-saved-list';
        savedList.style.display = 'flex';
        savedList.style.flexDirection = 'column';
        savedList.style.gap = '8px';
        savedCard.appendChild(savedList);
        layout.appendChild(savedCard);
        content.appendChild(layout);
        loadSavedItemsForPage();
    }).catch(() => {
        // fallback synchronous render if promise rejects
        applyPanelHostFrame(colors);
        applyPanelChromeStyles(shadow, colors);
        content.innerHTML = '';
        const layout = document.createElement('div');
        layout.style.display = 'flex';
        layout.style.flexDirection = 'column';
        layout.style.gap = '12px';
        layout.style.padding = '12px';
        layout.style.flex = '1';
        layout.style.background = colors.panelBg;
        content.appendChild(layout);
        loadSavedItemsForPage();
    });
    // original synchronous render moved inside promise resolution above
}

function renderSavedItems(items) {
    const shadow = ensurePanelHost();
    if (!shadow)
        return;
    const container = shadow.getElementById('ia-saved-list');
    if (!container)
        return;
    const colors = getChromeThemeColors();
    container.innerHTML = '';
    const sorted = Array.isArray(items) ? [...items] : [];
    sorted.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')).reverse();
    const normalizedQuery = normalizeForSearch(currentSearchQuery || '');
    const filtered = normalizedQuery
        ? sorted.filter((it) => {
            const haystack = normalizeForSearch([it.title, it.original_text, it.summary].filter(Boolean).join(' '));
            return haystack.includes(normalizedQuery);
        })
        : sorted;
    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.textContent = sorted.length ? `No hay resultados para "${currentSearchQuery}".` : 'No hay elementos guardados en esta página.';
        empty.style.color = colors.textSecondary;
        empty.style.padding = '12px';
        empty.style.borderRadius = '8px';
        empty.style.background = colors.cardBg;
        empty.style.border = `1px solid ${colors.cardBorder}`;
        container.appendChild(empty);
        return;
    }
    for (const it of filtered) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.flexDirection = 'column';
        row.style.gap = '6px';
        row.style.padding = '10px 12px';
        row.style.borderRadius = '10px';
        row.style.background = colors.isDark ? '#303134' : '#f8f9fa';
        row.style.transition = 'background-color 0.2s ease';
        row.style.fontFamily = PANEL_FONT;
        row.style.color = colors.textPrimary;
        row.addEventListener('mouseenter', () => {
            row.style.background = colors.isDark ? '#3c4043' : '#eef1f5';
        });
        row.addEventListener('mouseleave', () => {
            row.style.background = colors.isDark ? '#303134' : '#f8f9fa';
        });
        const title = document.createElement('div');
        title.textContent = it.title || (it.original_text || '').slice(0, 80) || 'Fragmento guardado';
        title.style.fontWeight = '600';
        title.style.fontSize = '14px';
        title.style.color = colors.textPrimary;
        const messageLine = document.createElement('div');
        messageLine.textContent = it.original_text || it.summary || 'No se encontró el texto original.';
        messageLine.style.marginTop = '4px';
        messageLine.style.marginBottom = '8px';
        messageLine.style.padding = '10px 12px';
        messageLine.style.borderRadius = '8px';
        messageLine.style.background = colors.messageBg;
        messageLine.style.color = colors.textPrimary;
        messageLine.style.border = `1px solid ${colors.cardBorder}`;
        messageLine.style.whiteSpace = 'pre-wrap';
        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.flexWrap = 'wrap';
        actions.style.gap = '8px';
        const viewBtn = document.createElement('button');
        viewBtn.textContent = 'Ver texto';
        Object.assign(viewBtn.style, {
            cursor: 'pointer',
            padding: '6px 12px',
            borderRadius: '20px',
            border: 'none',
            background: colors.accent,
            color: colors.accentText,
            fontWeight: '600',
            fontFamily: PANEL_FONT
        });
        viewBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (messageLine.parentNode === row) {
                row.removeChild(messageLine);
                viewBtn.textContent = 'Ver texto';
            }
            else {
                row.insertBefore(messageLine, actions);
                messageLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
                viewBtn.textContent = 'Ocultar texto';
            }
        });
        actions.appendChild(viewBtn);
        const navBtn = document.createElement('button');
        navBtn.textContent = 'Ir al mensaje';
        Object.assign(navBtn.style, {
            cursor: 'pointer',
            padding: '6px 12px',
            borderRadius: '20px',
            border: `1px solid ${colors.accent}`,
            background: 'transparent',
            color: colors.accent,
            fontWeight: '600',
            fontFamily: PANEL_FONT
        });
        navBtn.addEventListener('mouseenter', () => {
            navBtn.style.background = colors.isDark ? '#1f3b63' : '#e8f0fe';
        });
        navBtn.addEventListener('mouseleave', () => {
            navBtn.style.background = 'transparent';
        });
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
        Object.assign(delBtn.style, {
            cursor: 'pointer',
            padding: '6px 12px',
            borderRadius: '20px',
            border: `1px solid ${colors.cardBorder}`,
            background: 'transparent',
            color: colors.textSecondary,
            fontWeight: '500',
            fontFamily: PANEL_FONT
        });
        delBtn.addEventListener('mouseenter', () => {
            delBtn.style.background = colors.isDark ? '#3c4043' : '#f1f3f4';
        });
        delBtn.addEventListener('mouseleave', () => {
            delBtn.style.background = 'transparent';
        });
        delBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            try {
                safeSendMessage({ type: 'DELETE_SAVED_ITEM', payload: { sourceId: it.source_id } }, (r) => {
                    if (r && r.ok) {
                        loadSavedItemsForPage();
                        loadMindMapForPage();
                    }
                });
            }
            catch (_) { }
        });
        actions.appendChild(delBtn);
        row.appendChild(title);
        row.appendChild(actions);
        container.appendChild(row);
    }
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

// More robust finder: if the full snippet is not found, try progressively shorter
// substring matches (sliding windows) and return the best (longest) match found.
function findSnippetRangeWithFallback(root, snippetText) {
    const normalizedSnippet = normalizeForSearch(snippetText);
    if (!normalizedSnippet)
        return { range: null, matched: null };
    const { normalized, mapping } = buildNormalizedMap(root);
    if (!normalized)
        return { range: null, matched: null };
    const makeRange = (startIndex, length) => {
        const startMap = mapping[startIndex];
        const endMap = mapping[startIndex + length - 1];
        if (!startMap || !endMap)
            return null;
        try {
            const range = document.createRange();
            range.setStart(startMap.node, startMap.offset);
            const endNode = endMap.node;
            const endText = endNode.nodeValue || '';
            const endOffset = Math.min(endText.length, endMap.offset + 1);
            range.setEnd(endNode, endOffset);
            return range;
        }
        catch (_) {
            return null;
        }
    };

    // Exact match first
    let idx = normalized.indexOf(normalizedSnippet);
    if (idx !== -1) {
        const r = makeRange(idx, normalizedSnippet.length);
        if (r)
            return { range: r, matched: normalizedSnippet };
    }

    // Try progressively shorter windows (prefer longer matches)
    const windowLens = [240, 200, 160, 120, 80, 40, 20];
    for (const len of windowLens) {
        if (normalizedSnippet.length <= len)
            continue;
        const step = Math.max(1, Math.floor(len / 4));
        for (let start = 0; start + len <= normalizedSnippet.length; start += step) {
            const sub = normalizedSnippet.slice(start, start + len);
            const pos = normalized.indexOf(sub);
            if (pos !== -1) {
                const r = makeRange(pos, sub.length);
                if (r)
                    return { range: r, matched: sub };
            }
        }
    }

    // Try shorter contiguous word groups
    const words = normalizedSnippet.split(' ').filter(Boolean);
    for (let wlen = Math.min(words.length, 8); wlen >= 1; wlen--) {
        for (let i = 0; i + wlen <= words.length; i++) {
            const sub = words.slice(i, i + wlen).join(' ');
            const pos = normalized.indexOf(sub);
            if (pos !== -1) {
                const r = makeRange(pos, sub.length);
                if (r)
                    return { range: r, matched: sub };
            }
        }
    }

    return { range: null, matched: null };
}

function applySnippetHighlight(el, snippetText) {
    const { range, matched } = findSnippetRangeWithFallback(el, snippetText);
    if (!range)
        return null;
    if (matched && normalizeForSearch(snippetText).length !== matched.length) {
        try {
            console.debug('[IA] applySnippetHighlight: used fallback fragment', { originalLength: normalizeForSearch(snippetText).length, matchedLength: matched.length });
        }
        catch (_) { }
    }
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
    // If direct highlight failed, try the enclosing message container (more likely to contain text nodes)
    try {
        const container = (el instanceof HTMLElement && typeof el.closest === 'function') ? el.closest(MESSAGE_CONTAINER_SELECTOR) : null;
        if (container && container instanceof HTMLElement) {
            const containerResult = applySnippetHighlight(container, snippetText);
            if (containerResult) {
                currentHighlightCleanup = containerResult.cleanup;
                setTimeout(() => {
                    if (currentHighlightCleanup === containerResult.cleanup) {
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
    }
    catch (_) { }

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
// Toggle to disable floating diskette save buttons entirely (message/fragment level)
const DISABLE_SAVE_BUTTONS = true;

// If disabling, remove any previously injected save buttons that may exist in the page
try {
    if (DISABLE_SAVE_BUTTONS) {
        Array.from(document.querySelectorAll('.ia-save-btn')).forEach(n => { try { n.remove(); } catch (_) { } });
    }
}
catch (_) { }
function makeSelectionButton() {
    if (selectionBtn)
        return selectionBtn;
    const b = document.createElement('button');
    b.id = 'ia-selection-save-btn';
    b.type = 'button';
    b.textContent = 'Guardar selección';
    Object.assign(b.style, {
        position: 'fixed',
        zIndex: '2147483647',
        padding: '6px 10px',
        display: 'none',
        background: '#fff',
        color: '#0f172a',
        border: '1px solid #cfcfcf',
        borderRadius: '6px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        cursor: 'pointer',
        fontWeight: '600'
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
    if (DISABLE_SAVE_BUTTONS)
        return; // no-op when save buttons are disabled
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
