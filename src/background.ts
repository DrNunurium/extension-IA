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
const DEFAULT_GEMINI_MODEL = 'models/gemini-1.5-flash';
const GL_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

type SimpleMindMap = {
  concepto_principal: string;
  conceptos_secundarios: string[];
};

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
  "type": "object",
  "properties": {
    "concepto_principal": { "type": "string" },
    "conceptos_secundarios": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["concepto_principal", "conceptos_secundarios"]
}`;

  const MODEL_FALLBACK_PREFERENCE = [
    'models/gemini-1.5-flash',
    'models/gemini-2.5-flash',
    'models/text-bison-001',
    'models/text-bison-002'
  ];

  // Build a prompt that asks clearly for JSON output. Keep it reasonably short.
  let basePrompt = `**TAREA ESTRICTA:** Analiza el texto de la conversación y genera la estructura de un mapa conceptual estrictamente en formato JSON.\n**REGLAS:**\n1. NO DEBES incluir ninguna palabra, explicación, introducción, comentario o cualquier otro carácter ANTES O DESPUÉS del objeto JSON.\n2. La respuesta DEBE ser el JSON puro y nada más.\n3. Asegúrate de que el JSON comienza con '{' y termina con '}'.\n\nGenera un único objeto JSON que siga estrictamente este esquema: ${schemaDescription}.\n\nTexto de la conversación: \n"""\n${conversationText}\n"""`;

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
        if (parsed) return parsed;
      }

      const candidates: any[] = Array.isArray(respObj?.candidates) ? respObj.candidates : [];
      for (const cand of candidates) {
        const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
        for (const part of parts) {
          if (typeof part?.text === 'string') {
            const parsedText = safeParseJsonString(part.text);
            if (parsedText) return parsedText;
          }
          const inlineData = part?.inlineData;
          if (inlineData && typeof inlineData === 'object' && typeof inlineData.data === 'string') {
            const mime = inlineData.mimeType || inlineData.mime_type || '';
            if (typeof mime === 'string' && mime.toLowerCase().includes('json')) {
              try {
                if (typeof atob === 'function') {
                  const decoded = atob(inlineData.data);
                  const parsedInline = safeParseJsonString(decoded);
                  if (parsedInline) return parsedInline;
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

  function isSimpleMindMapShape(value: any): value is SimpleMindMap {
    return (
      value &&
      typeof value === 'object' &&
      typeof value.concepto_principal === 'string' &&
      Array.isArray(value.conceptos_secundarios) &&
      value.conceptos_secundarios.every((item: any) => typeof item === 'string')
    );
  }

  function convertSimpleMindMap(simple: SimpleMindMap): MindMapData {
    const centralId = '__central__';
    const nodes: MindMapNode[] = [
      {
        id: centralId,
        titulo: simple.concepto_principal,
        descripcion: simple.concepto_principal,
        source_ids: []
      },
      ...simple.conceptos_secundarios.map((concepto, idx) => ({
        id: `simple_${idx + 1}`,
        titulo: concepto,
        descripcion: concepto,
        source_ids: []
      }))
    ];

    const relaciones: MindMapRelation[] = nodes
      .filter((n) => n.id !== centralId)
      .map((n) => ({ desde: centralId, hacia: n.id, tipo: 'relacion' }));

    return {
      titulo_central: simple.concepto_principal,
      nodos: nodes,
      relaciones
    };
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
      const example: SimpleMindMap = {
        concepto_principal: 'Tema de ejemplo',
        conceptos_secundarios: ['Concepto 1', 'Concepto 2']
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
          if (isSimpleMindMapShape(parsedForced)) return convertSimpleMindMap(parsedForced);
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
    if (structuredDirect) {
      if (isValidMindMap(structuredDirect)) {
        return structuredDirect as MindMapData;
      }
      if (isSimpleMindMapShape(structuredDirect)) {
        return convertSimpleMindMap(structuredDirect);
      }
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
  if (isSimpleMindMapShape(json)) return convertSimpleMindMap(json);
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
