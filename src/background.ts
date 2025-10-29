type SaveChatDataPayload = {
  messageText: string;
  sourceId: string;
  pageUrl?: string;
  paragraphIndex?: number;
};

type MindMapNode = {
  id: string;
  titulo: string;
  descripcion: string;
  // optional references to saved fragments (source_id values)
  source_ids?: string[];
};

type MindMapRelation = {
  desde: string;
  hacia: string;
  tipo: string;
};

type MindMapData = {
  titulo_central: string;
  nodos: MindMapNode[];
  relaciones: MindMapRelation[];
};

const chromeApi = (globalThis as typeof globalThis & { chrome?: any }).chrome;

// The model name can vary by API availability. Use a sensible default but allow
// overriding via `chrome.storage.local` key `geminiModel` if needed.
// Use Gemini 2.5 flash model by default as requested.
const DEFAULT_GEMINI_MODEL = 'models/gemini-2.5-flash';
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
          const structured = await saveDataWithGemini(messageText, sourceId, pageUrl, paragraphIndex);
          structured.normalized_page = normalizePageUrl(pageUrl);

          await new Promise((resolve, reject) => {
            chromeApi.storage.local.set({ [structured.source_id]: structured }, () => {
              const err = chromeApi.runtime.lastError;
              if (err) return reject(err);
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
          sendResponse({ ok: false, error: String(err) });
        }
      })();
      return true;
    }

    case 'NAVIGATE_TO_SOURCE': {
      const { pageUrl, sourceId } = message.payload || {};
      if (!pageUrl || !sourceId) return;
      (async () => {
        try {
          chromeApi.tabs.query({ active: true, currentWindow: true }, (tabs: any[]) => {
            const active = tabs && tabs[0];
            if (active && typeof active.id === 'number') {
              try {
                chromeApi.tabs.sendMessage(active.id, { type: 'SCROLL_TO_SOURCE', payload: { sourceId } }, () => {
                  const err = chromeApi.runtime.lastError;
                  if (err) {
                    console.debug('Active tab scroll failed, fallback to new tab', err);
                    tryOpenInNewTab(pageUrl, sourceId);
                    sendResponse({ ok: true, fallback: true });
                    return;
                  }
                  sendResponse({ ok: true, inPage: true });
                });
              } catch (e) {
                console.error('tabs.sendMessage failed', e);
                tryOpenInNewTab(pageUrl, sourceId);
                sendResponse({ ok: true, fallback: true });
              }
            } else {
              tryOpenInNewTab(pageUrl, sourceId);
              sendResponse({ ok: true, fallback: true });
            }
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
    return `${parsed.origin}${path}`;
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

async function callGeminiMindMap(apiKey: string, conversationText: string): Promise<MindMapData | null> {
  const schemaDescription = `{
  "titulo_central": "string",
  "nodos": [
    { "id": "string", "titulo": "string", "descripcion": "string", "source_ids": ["string"] }
  ],
  "relaciones": [
    { "desde": "string", "hacia": "string", "tipo": "string" }
  ]
}`;

  // Build a prompt that asks clearly for JSON output. Keep it reasonably short.
  let basePrompt = `Analiza la siguiente conversación de chat sobre un proyecto. Genera un único objeto JSON que cumpla con este esquema: ${schemaDescription}. El campo \"titulo_central\" debe resumir el tema principal. Incluye referencias a los fragmentos usando sus IDs cuando proceda. Texto de la conversación:\n${conversationText}`;

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
        maxOutputTokens: 2048
      },
      safetySettings: []
    };

    // log conversationText for debugging if something goes wrong
    try {
      console.debug('Calling Gemini with conversationText:', conversationText.slice(0, 2000));
    } catch (_) {}

    const modelName = await getModelName();
    const endpoint = buildEndpointForModel(modelName, apiKey);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
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
  // unreachable normally
  return null;
}

function parseJsonStrict(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
    if (match && match[1]) {
      return JSON.parse(match[1]);
    }
    throw new Error('No se pudo analizar JSON en la respuesta.');
  }
}

function isValidMindMap(value: any): value is MindMapData {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.titulo_central !== 'string') return false;
  if (!Array.isArray(value.nodos) || !Array.isArray(value.relaciones)) return false;
  // validate node shape
  for (const n of value.nodos) {
    if (!n || typeof n !== 'object') return false;
    if (typeof n.id !== 'string') return false;
    if (typeof n.titulo !== 'string') return false;
    if (typeof n.descripcion !== 'string') return false;
    if (n.source_ids && !Array.isArray(n.source_ids)) return false;
  }
  // validate relations shape
  for (const r of value.relaciones) {
    if (!r || typeof r !== 'object') return false;
    if (typeof r.desde !== 'string') return false;
    if (typeof r.hacia !== 'string') return false;
    if (typeof r.tipo !== 'string') return false;
  }
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

function tryOpenInNewTab(pageUrl: string, sourceId: string) {
  chromeApi.tabs.create({ url: pageUrl, active: true }, (tab: any) => {
    const tabId: number = tab.id as number;
    const listener = (updatedTabId: number, changeInfo: any) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        chromeApi.tabs.onUpdated.removeListener(listener);
        try {
          chromeApi.scripting.executeScript({
            target: { tabId },
            func: (sid: string) => {
              try {
                const selector = `[data-source-id="${sid}"],[data-message-id="${sid}"]`;
                let el = document.querySelector(selector) as HTMLElement | null;
                if (!el) {
                  el = Array.from(document.querySelectorAll('*')).find((e) => {
                    const ds = (e as HTMLElement).dataset as any;
                    return ds && (ds.sourceId === sid || ds.messageId === sid);
                  }) as HTMLElement | null;
                }
                if (el) {
                  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  const prev = el.style.outline;
                  el.style.outline = '3px solid #ffb86b';
                  setTimeout(() => {
                    el.style.outline = prev;
                  }, 4000);
                  return true;
                }
                return false;
              } catch (e) {
                console.error(e);
                return false;
              }
            },
            args: [sourceId]
          });
        } catch (execErr) {
          console.error('Failed to execute highlight script', execErr);
        }
      }
    };
    chromeApi.tabs.onUpdated.addListener(listener);
  });
}
