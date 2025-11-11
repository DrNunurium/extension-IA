type SaveChatDataPayload = {
  messageText: string;
  sourceId: string;
  pageUrl?: string;
  paragraphIndex?: number;
};

type MindMapData = {
  titulo_central: string;
  conceptos_clave: string[];
  resumen_ejecutivo: string;
};

const chromeApi = (globalThis as typeof globalThis & { chrome?: any }).chrome;

// The model name can vary by API availability. Use a sensible default but allow
// overriding via `chrome.storage.local` key `geminiModel` if needed.
// Use Gemini 2.5 flash model by default as requested.
const DEFAULT_GEMINI_MODEL = 'models/gemini-1.5-flash';
const GL_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function getModelName(): Promise<string> {
  try {
    const data: Record<string, any> = await new Promise((resolve) => chromeApi.storage.local.get(['geminiModel'], resolve));
    const m = data?.geminiModel;
    if (typeof m === 'string' && m.trim()) return m.trim();
  } catch (e) {
    // ignore and fallback
  }
  return DEFAULT_GEMINI_MODEL;
}

function buildEndpointForModel(modelName: string, apiKey: string) {
  // modelName is expected like 'models/xyz'. Build the generateContent endpoint.
  return `${GL_API_BASE}/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

// List available models from the Generative Language API. Returns an array of model names.
async function listModels(apiKey: string): Promise<string[]> {
  try {
    const url = `${GL_API_BASE}/models?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) {
      try { const txt = await resp.text(); console.debug('ListModels failed', resp.status, txt); } catch (_) {}
      return [];
    }
    const js = await resp.json();
    // response may be { models: [{ name: 'models/xyz', ... }, ...] }
    const models = Array.isArray(js?.models) ? js.models.map((m: any) => m?.name).filter(Boolean) : [];
    return models as string[];
  } catch (e) {
    console.debug('listModels error', e);
    return [];
  }
}

if (!chromeApi?.runtime?.onMessage) {
  console.warn('Chrome runtime API is not available in this context.');
}

chromeApi?.runtime?.onMessage.addListener((message: any, sender: any, sendResponse: (response?: unknown) => void) => {
  if (!message || !message.type) return;

  switch (message.type) {
    case 'SAVE_CHAT_DATA': {
      const payload = message.payload as SaveChatDataPayload | undefined;
      if (!payload) return;
      (async () => {
        const { messageText, sourceId, pageUrl, paragraphIndex } = payload;
        try {
          console.debug('Background: SAVE_CHAT_DATA received for sourceId=', sourceId, 'pageUrl=', pageUrl);
          const structured = await saveDataWithGemini(messageText, sourceId, pageUrl, paragraphIndex);
          structured.normalized_page = normalizePageUrl(pageUrl);

          // persist
          await new Promise((resolve, reject) => {
            chromeApi.storage.local.set({ [structured.source_id]: structured }, () => {
              const err = chromeApi.runtime.lastError;
              if (err) {
                console.error('Background: storage.set failed for', structured.source_id, err);
                return reject(err);
              }
              console.debug('Background: storage.set succeeded for', structured.source_id);
              resolve(true);
            });
          });

          try {
            await rebuildGroupsIndex();
          } catch (grpErr) {
            console.error('Failed to rebuild groups index', grpErr);
          }

          // Attempt to regenerate mind map for this page if we have a key
          if (pageUrl) {
            await generateMindMapForPage(pageUrl);
          }

          sendResponse({ ok: true, item: structured });
        } catch (err) {
          console.error('SAVE_CHAT_DATA failed', err);
          try { sendResponse({ ok: false, error: String(err) }); } catch(_){}
        }
      })();
      return true;
    }

    case 'GET_CHROME_ACTIVE_COLOR': {
      // Try to return stored preference first. If absent, attempt to derive
      // a color from the active tab's <meta name="theme-color">. This is
      // best-effort and may return null.
      try {
        chromeApi.storage.local.get(['panelAccentColor'], (data: any) => {
          try {
            const stored = data && data.panelAccentColor ? String(data.panelAccentColor) : null;
            if (stored) {
              sendResponse({ color: stored });
              return;
            }

            // No stored color; try to query active tab for theme-color
            try {
              chromeApi.tabs.query({ active: true, lastFocusedWindow: true }, (tabs: any[]) => {
                const tab = (tabs && tabs.length) ? tabs[0] : null;
                if (!tab || typeof tab.id !== 'number') {
                  sendResponse({ color: null });
                  return;
                }

                // Execute a small function in the page to read meta[name=theme-color]
                try {
                  chromeApi.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                      try {
                        const m = document.querySelector('meta[name="theme-color"]');
                        if (m && m.getAttribute) return m.getAttribute('content') || null;
                      } catch (e) { }
                      return null;
                    }
                  }, (results: any) => {
                    try {
                      const color = (Array.isArray(results) && results[0] && results[0].result) ? results[0].result : null;
                      sendResponse({ color });
                    } catch (e) { sendResponse({ color: null }); }
                  });
                } catch (e) {
                  sendResponse({ color: null });
                }
              });
            } catch (e) {
              sendResponse({ color: null });
            }
          }
          catch (e) {
            sendResponse({ color: null });
          }
        });
      }
      catch (e) {
        try { sendResponse({ color: null }); } catch(_) {}
      }
      return true;
    }

    case 'INJECT_MATH_SANITIZER': {
      // Run a function in the page context (via scripting.executeScript) that
      // patches katex.render and MathJax entrypoints to sanitize inputs before
      // rendering. Use sender.tab.id to target the correct tab.
      try {
        const tabId = sender?.tab?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ ok: false, error: 'no_tab' });
          return true;
        }

        chromeApi.scripting.executeScript({
          target: { tabId },
          func: () => {
            try {
              const bs = String.fromCharCode(92);
              const w = window;
              // To avoid TypeScript window typings when this function is serialized,
              // treat the page window as any at runtime.
              const pw: any = (window as any);
              function sanitizeTex(s) {
                if (typeof s !== 'string') return s;
                try {
                  let out = String(s);
                  const chars = ['€','£','¥','•','–','—','…','←','→','↑','↓'];
                  for (const ch of chars) {
                    out = out.split(ch).join(bs + 'text{' + ch + '}');
                  }
                  // Wrap runs of non-ASCII while avoiding backslash sequences
                  out = out.replace(/([^\\]|^)([\u0080-\uFFFF]+)/g, function(_, lead, run) {
                    return lead + bs + 'text{' + run + '}';
                  });
                  return out;
                } catch (e) { return s; }
              }

              function patchKatex() {
                try {
                  if (pw.katex && typeof pw.katex.render === 'function') {
                    const orig = pw.katex.render;
                    pw.katex.render = function(tex, el, opts) {
                      try {
                        const safe = sanitizeTex(tex);
                        const merged = Object.assign({ throwOnError: false, strict: 'ignore' }, opts || {});
                        return orig.call(this, safe, el, merged);
                      } catch (e) {
                        try { return orig.call(this, tex, el, opts); } catch (__) { return null; }
                      }
                    };
                  }
                } catch (e) { }
              }

              function patchMathJax() {
                try {
                  if (pw.MathJax) {
                    if (typeof pw.MathJax.typesetPromise === 'function') {
                      const orig = pw.MathJax.typesetPromise;
                      pw.MathJax.typesetPromise = function(elements) {
                        try {
                          const scripts = document.querySelectorAll('script[type^="math/tex"]');
                          scripts.forEach(s => { if (s.textContent) s.textContent = sanitizeTex(s.textContent); });
                        } catch (e) {}
                        return orig.call(this, elements);
                      };
                    }
                    if (pw.MathJax.Hub && pw.MathJax.Hub.Queue) {
                      const origQ = pw.MathJax.Hub.Queue;
                      pw.MathJax.Hub.Queue = function() {
                        try {
                          const scripts = document.querySelectorAll('script[type^="math/tex"]');
                          scripts.forEach(s => { if (s.textContent) s.textContent = sanitizeTex(s.textContent); });
                        } catch (e) {}
                        return origQ.apply(this, arguments);
                      };
                    }
                  }
                } catch (e) {}
              }

              patchKatex(); patchMathJax();
              const iv = setInterval(() => { try { patchKatex(); patchMathJax(); } catch (e) {} }, 1000);
              setTimeout(() => clearInterval(iv), 30000);
            } catch (e) { /* ignore */ }
          }
        }, (results) => {
          try {
            // If executeScript failed, results may be undefined
            if (!results) sendResponse({ ok: false, error: 'exec_failed' });
            else sendResponse({ ok: true });
          } catch (e) { try { sendResponse({ ok: false, error: String(e) }); } catch(_) {} }
        });
      } catch (e) {
        try { sendResponse({ ok: false, error: String(e) }); } catch(_) {}
      }
      return true;
    }

    case 'NAVIGATE_TO_SOURCE': {
      const { pageUrl, sourceId } = message.payload || {};
      if (!pageUrl || !sourceId) return;
      (async () => {
        try {
          const requestingTabId = sender?.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
          // Prefer sending SCROLL_TO_SOURCE to any existing tab that already has the target page open
          chromeApi.tabs.query({}, (tabs: any[]) => {
            const normalizedTarget = normalizePageUrl(pageUrl);
            const matching = (tabs || []).find((t: any) => normalizePageUrl(t?.url) === normalizedTarget && typeof t.id === 'number');
            if (matching) {
              scheduleHighlightForTab(matching.id, sourceId, (ok) => {
                sendResponse(ok ? { ok: true, inPage: true } : { ok: false, error: 'message_failed' });
              });
              return;
            }

            if (requestingTabId && pageUrl) {
              navigateExistingTabToSource(requestingTabId, pageUrl, sourceId, (result) => {
                sendResponse(result);
              });
              return;
            }

            if (pageUrl) {
              tryOpenInNewTab(pageUrl, sourceId);
              sendResponse({ ok: true, openedNewTab: true });
              return;
            }

            // No tab to reuse and no requesting tab id -> cannot navigate
            sendResponse({ ok: false, error: 'no_matching_tab_in_window' });
          });
        } catch (e) {
          console.error('NAVIGATE_TO_SOURCE failed', e);
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }

    case 'DELETE_SAVED_ITEM': {
      const sid = message.payload?.sourceId;
      if (!sid) return;
      (async () => {
        try {
          const itemData: Record<string, any> = await new Promise((resolve) => chromeApi.storage.local.get([sid], resolve));
          const pageUrl = itemData?.[sid]?.pageUrl as string | undefined;
          const normalized = itemData?.[sid]?.normalized_page as string | undefined;

          await new Promise((resolve, reject) => {
            chromeApi.storage.local.remove([sid], () => {
              const err = chromeApi.runtime.lastError;
              if (err) return reject(err);
              resolve(true);
            });
          });

          await rebuildGroupsIndex();

          if (pageUrl || normalized) {
            await generateMindMapForPage(pageUrl, normalized);
          }

          sendResponse({ ok: true, removed: sid });
        } catch (e) {
          console.error('Failed to delete item', e);
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }

    case 'CLEAR_ALL_SAVED': {
      (async () => {
        try {
          const data: Record<string, any> = await new Promise((resolve) => chromeApi.storage.local.get(null, resolve));
          const keysToRemove: string[] = [];
          for (const [k, v] of Object.entries(data)) {
            if (k === 'groupsIndex' || k === 'mindMaps') {
              keysToRemove.push(k);
            } else if (v && typeof v === 'object' && v.source_id) {
              keysToRemove.push(k);
            }
          }

          await new Promise((resolve, reject) => {
            chromeApi.storage.local.remove(keysToRemove, () => {
              const err = chromeApi.runtime.lastError;
              if (err) return reject(err);
              resolve(true);
            });
          });

          await new Promise((resolve, reject) => {
            chromeApi.storage.local.set({ groupsIndex: {}, mindMaps: {} }, () => {
              const err = chromeApi.runtime.lastError;
              if (err) return reject(err);
              resolve(true);
            });
          });

          sendResponse({ ok: true });
        } catch (e) {
          console.error('Failed to clear all saved items', e);
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }

    case 'GENERATE_MIND_MAP': {
      const pageUrl = message.payload?.pageUrl as string | undefined;
      (async () => {
        try {
          const map = await generateMindMapForPage(pageUrl);
          if (map) sendResponse({ ok: true, map });
          else sendResponse({ ok: false, error: 'No hay datos suficientes o falta la clave de API.' });
        } catch (e) {
          console.error('GENERATE_MIND_MAP failed', e);
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }
    case 'REMOVE_SAVED_TEXT_MATCH': {
      // payload: { pattern: string }
      const pattern = String(message.payload?.pattern || '').trim();
      if (!pattern) return;
      (async () => {
        try {
          const data: Record<string, any> = await new Promise((resolve) => chromeApi.storage.local.get(null, resolve));
          const toRemove: string[] = [];
          const normalizedPages = new Set<string>();
          const low = pattern.toLowerCase();
          for (const [k, v] of Object.entries(data)) {
            if (!v || typeof v !== 'object') continue;
            if (!(v as any).source_id) continue;
            const title = String((v as any).title || '').toLowerCase();
            const orig = String((v as any).original_text || '').toLowerCase();
            if (title.includes(low) || orig.includes(low)) {
              toRemove.push(k);
              const np = (v as any).normalized_page || (v as any).pageUrl || null;
              if (np) normalizedPages.add(np);
            }
          }
          if (!toRemove.length) { sendResponse({ ok: true, removed: 0 }); return; }
          await new Promise((resolve, reject) => {
            chromeApi.storage.local.remove(toRemove, () => {
              const err = chromeApi.runtime.lastError;
              if (err) return reject(err);
              resolve(true);
            });
          });
          try { await rebuildGroupsIndex(); } catch (e) { console.error('rebuildGroupsIndex failed after remove', e); }
          // regenerate mind maps for affected pages
          for (const np of Array.from(normalizedPages)) {
            try { await generateMindMapForPage(typeof np === 'string' ? np : undefined); } catch (e) { /* ignore */ }
          }
          sendResponse({ ok: true, removed: toRemove.length, keys: toRemove });
        } catch (e) {
          console.error('REMOVE_SAVED_TEXT_MATCH failed', e);
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }
    default:
      break;
  }
});

function normalizePageUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    let path = parsed.pathname || '/';
    if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1);

    // Canonicalize search params (sorted order) so SPA routes relying on query
    // segments are stable per conversation.
    const params: Array<[string, string]> = [];
    parsed.searchParams.forEach((value, key) => { params.push([key, value]); });
    params.sort((a, b) => {
      if (a[0] === b[0]) {
        if (a[1] === b[1]) return 0;
        return a[1] < b[1] ? -1 : 1;
      }
      return a[0] < b[0] ? -1 : 1;
    });
    const canonicalSearch = params.length
      ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '';

    const hash = parsed.hash && parsed.hash !== '#' ? parsed.hash : '';

    return `${parsed.origin}${path}${canonicalSearch}${hash}`;
  } catch (e) {
    console.debug('normalizePageUrl failed', e);
    return null;
  }
}

async function getAllSavedItems(): Promise<Record<string, any>[]> {
  const allData: Record<string, any> = await new Promise((resolve) => chromeApi.storage.local.get(null, resolve));
  const items: Record<string, any>[] = [];
  for (const value of Object.values(allData)) {
    if (value && typeof value === 'object' && (value as any).source_id) {
      items.push(value as Record<string, any>);
    }
  }
  return items;
}

async function saveDataWithGemini(messageText: string, sourceId: string, pageUrl?: string, paragraphIndex?: number): Promise<Record<string, any>> {
  // Lightweight local summary to avoid API cost per snippet; Gemini is used for the map generation.
  const summary = messageText.replace(/\s+/g, ' ').slice(0, 200);
  const title = messageText.split('\n')[0].split(' ').slice(0, 12).join(' ').slice(0, 120);
  return {
    source_id: sourceId,
    title: title || 'Mensaje guardado',
    summary,
    key_points: [],
    actions: [],
    entities: [],
    original_text: messageText,
    pageUrl: pageUrl || null,
    paragraphIndex: typeof paragraphIndex === 'number' ? paragraphIndex : null,
    created_at: new Date().toISOString()
  };
}

async function rebuildGroupsIndex(): Promise<void> {
  const items = await getAllSavedItems();
  const stopwords = new Set(['the','and','or','de','la','el','y','a','en','para','con','que','is','of','to','as','it']);
  const groups: Record<string, { title: string; items: string[]; updated_at: string }> = {};

  function extractKeywords(text: string) {
    return (text || '')
      .toLowerCase()
      .split(/[^a-záéíóúñ0-9]+/)
      .filter(Boolean)
      .filter((w) => !stopwords.has(w))
      .slice(0, 8);
  }

  for (const item of items) {
    const keywords = extractKeywords(`${item.title || ''} ${item.summary || ''}`);
    let placed = false;
    for (const kw of keywords) {
      if (groups[kw]) {
        groups[kw].items.push(item.source_id);
        groups[kw].updated_at = new Date().toISOString();
        placed = true;
        break;
      }
    }
    if (!placed) {
      const key = keywords[0] || 'otros';
      if (!groups[key]) {
        groups[key] = { title: key, items: [], updated_at: new Date().toISOString() };
      }
      groups[key].items.push(item.source_id);
    }
  }

  await new Promise((resolve, reject) => {
    chromeApi.storage.local.set({ groupsIndex: groups }, () => {
      const err = chromeApi.runtime.lastError;
      if (err) return reject(err);
      resolve(true);
    });
  });
}

async function generateMindMapForPage(pageUrl?: string, preNormalized?: string | null): Promise<MindMapData | null> {
  const normalized = preNormalized ?? normalizePageUrl(pageUrl);
  if (!normalized) return null;

  const apiKey = await getApiKey();
  if (!apiKey) {
    console.debug('Gemini API key not set; skipping mind map generation');
    return null;
  }

  const items = await getAllSavedItems();
  const relevant = items.filter((item) => (item.normalized_page || normalizePageUrl(item.pageUrl)) === normalized);
  if (!relevant.length) {
    console.debug('No hay elementos guardados para generar mapa', normalized);
    return null;
  }

  // Build conversation text including the source id for each snippet so Gemini can reference fragments
  const conversationText = relevant
    .map((item) => `- [ID:${item.source_id}] ${item.original_text.replace(/\s+/g, ' ').trim()}`)
    .join('\n\n');

  try {
    const map = await callGeminiMindMap(apiKey, conversationText);
    if (!map) return null;

    const existing: Record<string, any> = await new Promise((resolve) => chromeApi.storage.local.get(['mindMaps'], resolve));
    const maps = existing?.mindMaps || {};
    maps[normalized] = {
      data: map,
      updated_at: new Date().toISOString(),
      pageUrl: pageUrl || relevant[0].pageUrl || null
    };

    await new Promise((resolve, reject) => {
      chromeApi.storage.local.set({ mindMaps: maps }, () => {
        const err = chromeApi.runtime.lastError;
        if (err) return reject(err);
        resolve(true);
      });
    });

    notifyMindMapUpdated(normalized, map);
    return map;
  } catch (e) {
    console.error('Gemini mind map generation failed', e);
    return null;
  }
}

async function getApiKey(): Promise<string | null> {
  const data: Record<string, any> = await new Promise((resolve) => chromeApi.storage.local.get(['geminiApiKey'], resolve));
  const key = data?.geminiApiKey;
  if (typeof key === 'string' && key.trim()) return key.trim();
  return null;
}

const MAPA_MENTAL_SCHEMA_PLANO = {
  type: 'object',
  description: 'Lista plana de componentes para un mapa conceptual.',
  properties: {
    titulo_central: {
      type: 'string',
      description: 'El tema principal y conciso de toda la conversación.'
    },
    conceptos_clave: {
      type: 'array',
      description: 'Lista de 5 a 7 conceptos clave extraídos del texto.',
      items: {
        type: 'string',
        description: 'Un concepto clave, idea o estadística extraída.'
      }
    },
    resumen_ejecutivo: {
      type: 'string',
      description: 'Un resumen de la conversación de no más de 50 palabras.'
    }
  },
  required: ['titulo_central', 'conceptos_clave', 'resumen_ejecutivo']
} as const;

async function callGeminiMindMap(apiKey: string, conversationText: string): Promise<MindMapData | null> {
  const schemaDescription = JSON.stringify(MAPA_MENTAL_SCHEMA_PLANO, null, 2);

  const MODEL_FALLBACK_PREFERENCE = [
    'models/gemini-1.5-flash',
    'models/gemini-2.5-flash',
    'models/text-bison-001',
    'models/text-bison-002'
  ];

  let basePrompt = `Analiza la siguiente conversación. Genera estrictamente un objeto JSON que se ajuste al esquema proporcionado. Identifica los conceptos más importantes y un resumen conciso.
Instrucciones obligatorias:
- Devuelve SOLO el objeto JSON sin ningún texto adicional ni bloques de código.
- No incluyas saltos de línea \n ni comillas dobles " dentro de los valores de texto.
- Limita el resumen a un máximo de 50 palabras.
- Entrega entre 5 y 7 conceptos clave relevantes.

Esquema esperado:
${schemaDescription}

Texto de la conversación:
"""
${conversationText}
"""`;

  // Helper: recursively collect string values from the API response to find text candidates
  function collectStringValues(obj: any, acc: string[]) {
    if (obj == null) return;
    if (typeof obj === 'string') {
      acc.push(obj);
      return;
    }
    if (Array.isArray(obj)) {
      for (const it of obj) collectStringValues(it, acc);
      return;
    }
    if (typeof obj === 'object') {
      for (const k of Object.keys(obj)) collectStringValues(obj[k], acc);
    }
  }

  async function extractTextFromResponse(respObj: any): Promise<string | null> {
    // Preferred path used previously
    try {
      const cand = respObj?.candidates?.[0];
      const partsText = cand?.content?.parts?.[0]?.text;
      if (typeof partsText === 'string' && partsText.trim().length > 0) return partsText;
    } catch (_) {}

    // Fallback: collect strings found anywhere and pick the most JSON-like
    const acc: string[] = [];
    collectStringValues(respObj, acc);
    if (!acc.length) return null;
    // Prefer strings containing `{` or ```json
    const jsonLike = acc.find(s => /```\s*json|\{\s*"/.test(s));
    if (jsonLike && typeof jsonLike === 'string') return jsonLike;
    // Otherwise choose the longest string (likely main body)
    acc.sort((a,b) => b.length - a.length);
    return acc[0] || null;
  }

  function safeParseJsonString(str: string): any | null {
    try {
      return parseJsonStrict(str);
    } catch (_) {
      return null;
    }
  }

  function extractStructuredJson(respObj: any): any | null {
    try {
      if (!respObj || typeof respObj !== 'object') return null;

      if (typeof respObj.text === 'string') {
        const parsed = safeParseJsonString(respObj.text);
        if (parsed && isValidMindMap(parsed)) return parsed;
      }

      const candidates: any[] = Array.isArray(respObj?.candidates) ? respObj.candidates : [];
      for (const cand of candidates) {
        const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
        for (const part of parts) {
          if (typeof part?.text === 'string') {
            const parsedText = safeParseJsonString(part.text);
            if (parsedText && isValidMindMap(parsedText)) return parsedText;
          }
          const inlineData = part?.inlineData;
          if (inlineData && typeof inlineData === 'object' && typeof inlineData.data === 'string') {
            const mime = inlineData.mimeType || inlineData.mime_type || '';
            if (typeof mime === 'string' && mime.toLowerCase().includes('json')) {
              try {
                if (typeof atob === 'function') {
                  const decoded = atob(inlineData.data);
                  const parsedInline = safeParseJsonString(decoded);
                  if (parsedInline && isValidMindMap(parsedInline)) return parsedInline;
                } else {
                  console.debug('atob no está disponible para decodificar inlineData JSON');
                }
              } catch (decodeErr) {
                console.debug('No se pudo decodificar inlineData JSON', decodeErr);
              }
            }
          }
          if (part?.functionCall?.args && typeof part.functionCall.args === 'object') {
            const args = part.functionCall.args;
            if (isValidMindMap(args)) return args;
          }
        }
      }
    } catch (err) {
      console.debug('extractStructuredJson falló', err);
    }
    return null;
  }

  const looksLikeId = (s?: string | null) => {
    if (!s) return false;
    const t = s.trim();
    if (/^[A-Za-z0-9_\-]{10,}$/.test(t) && t.length < 120) return true;
    const parts = t.split(/\s+/);
    if (parts.length > 0 && parts.every(p => /^[A-Za-z0-9_\-]{6,}$/.test(p))) return true;
    return false;
  };

  async function forcedExampleRetry(currentModel: string): Promise<MindMapData | null> {
    try {
      const example: MindMapData = {
        titulo_central: 'Tema de ejemplo',
        conceptos_clave: [
          'Aspecto clave 1',
          'Aspecto clave 2',
          'Aspecto clave 3',
          'Aspecto clave 4',
          'Aspecto clave 5'
        ],
        resumen_ejecutivo: 'Resumen sintético del tema en menos de cincuenta palabras.'
      };
      const exampleStr = JSON.stringify(example, null, 2);
      const forcedPrompt = 'URGENTE: Devuelve SOLO el objeto JSON EXACTO que siga este ejemplo: ' + exampleStr + '\nAhora, usando la conversación anterior: ' + basePrompt;
      const forcedBody = {
        contents: [ { role: 'user', parts: [{ text: forcedPrompt }] } ],
        generationConfig: { temperature: 0.0, topP: 0.8, topK: 40, maxOutputTokens: 2048, responseMimeType: 'application/json' },
        safetySettings: []
      };

      const preferredSequence = [
        currentModel,
        'models/gemini-1.5-pro',
        ...MODEL_FALLBACK_PREFERENCE
      ].filter(Boolean);
      const tried = new Set<string>();

      let availableModels: string[] | null = null;

      for (const candidate of preferredSequence) {
        if (typeof candidate !== 'string' || !candidate.trim() || tried.has(candidate)) continue;
        tried.add(candidate);
        let resp: Response | null = null;
        try {
          const endpoint = buildEndpointForModel(candidate, apiKey);
          resp = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(forcedBody) });
        } catch (reqErr) {
          console.error('Forced retry request error', candidate, reqErr);
          continue;
        }

        if (!resp) continue;

        if (resp.status === 404) {
          // Only fetch available models once to avoid extra calls
          if (!availableModels) {
            try {
              availableModels = await listModels(apiKey);
              console.debug('Forced retry ListModels returned', availableModels);
            } catch (lmErr) {
              console.error('Forced retry listModels failed', lmErr);
            }
          }
          console.debug('Forced retry model not found', candidate);
          continue;
        }

        if (!resp.ok) {
          try {
            const errTxt = await resp.text();
            console.error('Gemini API error (forced retry)', candidate, resp.status, errTxt);
          } catch (_) {
            console.error('Gemini API error (forced retry)', candidate, resp.status);
          }
          continue;
        }

        try {
          const dataForced = await resp.json();
          const rawForced = await extractTextFromResponse(dataForced);
          if (!rawForced || typeof rawForced !== 'string') {
            console.debug('Forced retry returned empty text', candidate);
            continue;
          }
          if (looksLikeId(rawForced)) {
            console.debug('Forced retry still looks like an ID for model', candidate, rawForced.slice(0, 60));
            continue;
          }
          const parsedForced = parseJsonStrict(rawForced);
          if (isValidMindMap(parsedForced)) return parsedForced as MindMapData;
          console.debug('Forced retry JSON did not validate', candidate, parsedForced);
        } catch (err) {
          console.error('Forced retry parse failed', err);
        }
      }
      return null;
    } catch (err) {
      console.error('Forced example retry request failed', err);
      return null;
    }
  }

  let forcedExampleAttempts = 0;

  // We'll attempt up to 2 tries: initial prompt and then a stricter prompt wrapped in triple backticks
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0
      ? basePrompt
      : 'Por favor DEVUELVE SOLO EL OBJETO JSON entre triple backticks con etiqueta json. \n```json\n' + basePrompt + '\n```\nNada más.';

    const body = {
      contents: [ { role: 'user', parts: [{ text: prompt }] } ],
      generationConfig: {
        temperature: 0.0,
        topP: 0.8,
        topK: 40,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json'
      },
      safetySettings: []
    };

    // log conversationText for debugging if something goes wrong
    try {
      console.debug('Calling Gemini with conversationText:', conversationText.slice(0, 2000));
    } catch (_) {}

    let modelName = await getModelName();
    // If the configured/default model is a 'flash' variant and this is the second
    // attempt (stricter prompt), try the 'pro' variant which may produce more
    // structured outputs for complex schemas.
    if (attempt === 1 && typeof modelName === 'string' && modelName.includes('flash')) {
      console.debug('Fallback: switching model from', modelName, 'to models/gemini-1.5-pro for this attempt');
      modelName = 'models/gemini-1.5-pro';
    }
    const endpoint = buildEndpointForModel(modelName, apiKey);
    let response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    // If the model is not found (404), call ListModels to suggest alternatives and
    // attempt a fallback to a supported model from a preference list.
    if (response.status === 404) {
      try {
        const available = await listModels(apiKey);
        console.debug('ListModels returned', available);
        // preference order for falling back
        const pick = MODEL_FALLBACK_PREFERENCE.find(p => available.includes(p));
        if (pick) {
          console.debug('Falling back to model', pick);
          modelName = pick;
          const fallbackEndpoint = buildEndpointForModel(modelName, apiKey);
          response = await fetch(fallbackEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        } else {
          throw new Error('Modelo no disponible y no se encontró alternativa en la lista de modelos. Modelos disponibles: ' + available.join(', '));
        }
      } catch (e) {
        const errText = await response.text().catch(() => String(e));
        throw new Error(`Gemini API error: ${response.status} ${errText}`);
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();

    const structuredDirect = extractStructuredJson(data);
    if (structuredDirect && isValidMindMap(structuredDirect)) {
      return structuredDirect as MindMapData;
    }

    const rawText = await extractTextFromResponse(data);

    if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
      // if last attempt, throw an informative error with a bit of the response
      if (attempt === 1) {
        console.error('Gemini returned no text-like content. Full response:', data);
        throw new Error('La respuesta de Gemini no contiene texto.');
      }
      // otherwise retry with stricter prompt
      console.debug('No usable text found in Gemini response, retrying with stricter prompt...');
      continue;
    }

    if (looksLikeId(rawText)) {
      if (forcedExampleAttempts < 2) {
        forcedExampleAttempts++;
        console.debug('Raw response looks like an opaque ID; triggering forced example retry', forcedExampleAttempts);
        const forcedResult = await forcedExampleRetry(modelName);
        if (forcedResult) return forcedResult;
        console.debug('Forced example retry did not yield valid JSON, continuing with next attempt');
        continue;
      }
      if (attempt === 1) {
        throw new Error('La respuesta de Gemini parece un identificador opaco en vez de JSON.');
      }
      continue;
    }

    try {
  const json = parseJsonStrict(rawText);
  if (isValidMindMap(json)) return json as MindMapData;
      // If invalid, log and try stricter prompt once
      console.debug('Parsed JSON did not validate against schema. Attempt:', attempt, 'parsed:', json);

      if (attempt === 1) throw new Error('La respuesta no cumple con el esquema esperado.');
      // else continue to next attempt
    } catch (err) {
      console.error('Failed to parse Gemini JSON on attempt', attempt, err, rawText);
      if (attempt === 1) throw err;
      // fallback: try again with stricter prompt
    }
  }
  throw new Error('Fallo crítico: El modelo no generó JSON válido después de todos los intentos.');
}

function parseJsonStrict(raw: string): any {
  if (typeof raw !== 'string') throw new Error('Respuesta no es una cadena de texto');

  let cleaned = raw.trim();
  const firstBracket = cleaned.indexOf('{');
  const lastBracket = cleaned.lastIndexOf('}');

  if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) {
    console.error('Falló la limpieza de corchetes, contenido original:', cleaned.slice(0, 800));
    throw new Error('Respuesta no tiene formato JSON aparente.');
  }

  cleaned = cleaned.substring(firstBracket, lastBracket + 1);

  try {
    return JSON.parse(cleaned);
  } catch (primaryErr) {
    console.error('Falló el parseo JSON tras limpieza, intentando estrategias adicionales', primaryErr);
  }

  // Intentos adicionales reutilizando el contenido ya limpiado
  const codeBlockMatch = cleaned.match(/```json\s*([\s\S]*?)```/i) || cleaned.match(/```\s*([\s\S]*?)```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    try { return JSON.parse(codeBlockMatch[1]); } catch (_) { /* fall through */ }
  }

  const objMatches = cleaned.match(/\{[\s\S]*\}/g);
  if (objMatches && objMatches.length) {
    objMatches.sort((a, b) => b.length - a.length);
    for (const m of objMatches) {
      try { return JSON.parse(m); } catch (_) { /* continue */ }
    }
  }

  const preview = cleaned.slice(0, 800).replace(/\s+/g, ' ');
  throw new Error(`No se pudo analizar JSON en la respuesta. Preview: ${preview}`);
}

function isValidMindMap(value: any): value is MindMapData {
  if (!value || typeof value !== 'object') return false;

  const titulo = (value as any).titulo_central;
  if (typeof titulo !== 'string' || !titulo.trim()) return false;

  const conceptos = (value as any).conceptos_clave;
  if (!Array.isArray(conceptos) || conceptos.length < 5 || conceptos.length > 7) return false;
  if (!conceptos.every((item) => typeof item === 'string' && !!item.trim())) return false;

  const resumen = (value as any).resumen_ejecutivo;
  if (typeof resumen !== 'string' || !resumen.trim()) return false;

  return true;
}

function notifyMindMapUpdated(normalized: string, map: MindMapData) {
  chromeApi.tabs.query({}, (tabs: any[]) => {
    tabs.forEach((tab) => {
      if (!tab || typeof tab.id !== 'number' || !tab.url) return;
      const tabNorm = normalizePageUrl(tab.url);
      if (tabNorm === normalized) {
        chromeApi.tabs.sendMessage(tab.id, { type: 'MIND_MAP_UPDATED', payload: { map } }, () => {
          const err = chromeApi.runtime.lastError;
          if (err) console.debug('notifyMindMapUpdated error', err);
        });
      }
    });
  });
}

function scheduleHighlightForTab(tabId: number, sourceId: string, callback: (ok: boolean) => void): void {
  try {
    chromeApi.tabs.sendMessage(tabId, { type: 'SCROLL_TO_SOURCE', payload: { sourceId } }, () => {
      const err = chromeApi.runtime.lastError;
      if (!err) {
        callback(true);
        return;
      }

      try {
        chromeApi.scripting.executeScript({
          target: { tabId },
          func: (sid: string) => {
            try {
              const selector = `[data-source-id="${sid}"]`;
              const altSelector = `[data-message-id="${sid}"]`;
              let el = document.querySelector(selector) as HTMLElement | null;
              if (!el) el = document.querySelector(altSelector) as HTMLElement | null;
              if (!el) {
                el = Array.from(document.querySelectorAll<HTMLElement>('*')).find((e) => {
                  const ds = e.dataset as any;
                  return ds && (ds.sourceId === sid || ds.messageId === sid);
                }) || null;
              }
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const prev = el.style.outline;
                el.style.outline = '3px solid #ffb86b';
                setTimeout(() => { el.style.outline = prev; }, 4000);
                return true;
              }
              return false;
            } catch (highlightErr) {
              console.error(highlightErr);
              return false;
            }
          },
          args: [sourceId]
        }, () => {
          const execErr = chromeApi.runtime.lastError;
          if (execErr) {
            console.error('Failed to execute highlight script', execErr);
            callback(false);
          } else {
            callback(true);
          }
        });
      } catch (execErrOuter) {
        console.error('Failed to execute highlight script', execErrOuter);
        callback(false);
      }
    });
  } catch (sendErr) {
    console.error('tabs.sendMessage highlight failed', sendErr);
    callback(false);
  }
}

function navigateExistingTabToSource(tabId: number, targetUrl: string, sourceId: string, callback: (result: { ok: boolean; [key: string]: any }) => void): void {
  try {
    chromeApi.tabs.update(tabId, { url: targetUrl, active: true }, () => {
      const updateErr = chromeApi.runtime.lastError;
      if (updateErr) {
        console.error('tabs.update failed', updateErr);
        callback({ ok: false, error: 'tab_update_failed' });
        return;
      }

      const listener = (updatedTabId: number, changeInfo: any) => {
        if (updatedTabId !== tabId) return;
        if (changeInfo.status === 'complete') {
          chromeApi.tabs.onUpdated.removeListener(listener);
          scheduleHighlightForTab(tabId, sourceId, (ok) => {
            if (!ok) console.debug('Highlight after navigation may have failed for source', sourceId);
          });
        }
      };

      chromeApi.tabs.onUpdated.addListener(listener);
      callback({ ok: true, navigated: true });
    });
  } catch (e) {
    console.error('navigateExistingTabToSource failed', e);
    callback({ ok: false, error: String(e) });
  }
}

function tryOpenInNewTab(pageUrl: string, sourceId: string) {
  chromeApi.tabs.create({ url: pageUrl, active: true }, (tab: any) => {
    const tabId: number = tab.id as number;
    const listener = (updatedTabId: number, changeInfo: any) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        chromeApi.tabs.onUpdated.removeListener(listener);
        scheduleHighlightForTab(tabId, sourceId, () => { /* ignore result */ });
      }
    };
    chromeApi.tabs.onUpdated.addListener(listener);
  });
}

// One-time startup cleanup: remove saved snippets whose text/title/summary
// include known unwanted phrases. This runs when the service worker starts and
// permanently deletes matching storage entries so they won't reappear.
async function runStartupSavedTextCleanup(): Promise<void> {
  try {
    const bannedPhrases = [
      // Primary short identifier (will match partials)
      'Método para navegación rápida en conversación',
      // Full block (in case saved verbatim)
      `Método para navegación rápida en conversación\nConceptos clave\nMétodo\nFacilitar usuario\nVolver a conversación\nNavegación rápida\nDividir tarea\nTres fases\nResumen ejecutivo\nSe presenta un método para que el usuario pueda regresar rápidamente a secciones previas de una conversación. La tarea se estructura en tres fases para optimizar la navegación y la experiencia del usuario.`
    ];

    const allData: Record<string, any> = await new Promise((resolve) => chromeApi.storage.local.get(null, resolve));
    const toRemove: string[] = [];
    const affectedPages = new Set<string>();

    for (const [k, v] of Object.entries(allData)) {
      if (!v || typeof v !== 'object') continue;
      // Only consider saved-snippet shaped objects
      if (!(v as any).source_id) continue;
      try {
        const combined = `${String((v as any).title || '')} ${String((v as any).summary || '')} ${String((v as any).original_text || '')}`.toLowerCase();
        for (const bp of bannedPhrases) {
          if (!bp) continue;
          if (combined.includes(bp.toLowerCase())) {
            toRemove.push(k);
            const np = (v as any).normalized_page || (v as any).pageUrl || null;
            if (np) affectedPages.add(String(np));
            break;
          }
        }
      } catch (e) {
        // ignore individual parse errors
      }
    }

    if (!toRemove.length) {
      console.debug('Startup cleanup: no saved items matched banned phrases');
      return;
    }

    await new Promise((resolve, reject) => {
      chromeApi.storage.local.remove(toRemove, () => {
        const err = chromeApi.runtime.lastError;
        if (err) return reject(err);
        resolve(true);
      });
    });

    try {
      await rebuildGroupsIndex();
    } catch (e) {
      console.error('rebuildGroupsIndex failed after startup cleanup', e);
    }

    // Regenerate mind maps for affected pages to reflect removals
    for (const np of Array.from(affectedPages)) {
      try {
        await generateMindMapForPage(np);
      } catch (e) {
        // ignore per-page failures
      }
    }

    console.info('Startup cleanup removed saved keys:', toRemove.length, toRemove);
  } catch (e) {
    console.error('runStartupSavedTextCleanup failed', e);
  }
}

// Kick off cleanup now (non-blocking)
try {
  // Fire and forget; keep service worker start fast
  void runStartupSavedTextCleanup();
} catch (_) {}
