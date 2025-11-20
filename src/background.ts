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
const persistentStorage = chromeApi?.storage?.sync ?? chromeApi?.storage?.local;

// Gemini API integration removed: mind-map generation is done locally now.
// Keep a few no-op stubs to satisfy legacy helper references (these are unused).
async function getModelName(): Promise<string> {
  return 'models/text-bison-001';
}
function buildEndpointForModel(_modelName: string, _apiKey: string) {
  return '';
}
async function listModels(_apiKey: string): Promise<string[]> {
  return [];
}

if (!chromeApi?.runtime?.onMessage) {
  console.warn('Chrome runtime API is not available in this context.');
}

chromeApi?.runtime?.onMessage.addListener(
  (message: any, sender: any, sendResponse: (response?: unknown) => void) => {
    if (!message || !message.type) return;

    switch (message.type) {
      case 'SAVE_CHAT_DATA': {
        const payload = message.payload as SaveChatDataPayload | undefined;
        if (!payload) return;
        (async () => {
          const { messageText, sourceId, pageUrl, paragraphIndex } = payload;
          try {
            console.debug(
              'Background: SAVE_CHAT_DATA received for sourceId=',
              sourceId,
              'pageUrl=',
              pageUrl,
            );
            const structured = await saveDataWithGemini(
              messageText,
              sourceId,
              pageUrl,
              paragraphIndex,
            );
            structured.normalized_page = normalizePageUrl(pageUrl);

            // persist
            await new Promise((resolve, reject) => {
              persistentStorage.set({ [structured.source_id]: structured }, () => {
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
            try {
              sendResponse({ ok: false, error: String(err) });
            } catch (_) {}
          }
        })();
        return true;
      }

      case 'GET_CHROME_ACTIVE_COLOR': {
        // Try to return stored preference first. If absent, attempt to derive
        // a color from the active tab's <meta name="theme-color">. This is
        // best-effort and may return null.
        try {
          persistentStorage.get(['panelAccentColor'], (data: any) => {
            try {
              const stored = data && data.panelAccentColor ? String(data.panelAccentColor) : null;
              if (stored) {
                sendResponse({ color: stored });
                return;
              }

              // No stored color; try to query active tab for theme-color
              try {
                chromeApi.tabs.query({ active: true, lastFocusedWindow: true }, (tabs: any[]) => {
                  const tab = tabs && tabs.length ? tabs[0] : null;
                  if (!tab || typeof tab.id !== 'number') {
                    sendResponse({ color: null });
                    return;
                  }

                  // Execute a small function in the page to read meta[name=theme-color]
                  try {
                    chromeApi.scripting.executeScript(
                      {
                        target: { tabId: tab.id },
                        func: () => {
                          try {
                            const m = document.querySelector('meta[name="theme-color"]');
                            if (m && m.getAttribute) return m.getAttribute('content') || null;
                          } catch (e) {}
                          return null;
                        },
                      },
                      (results: any) => {
                        try {
                          const color =
                            Array.isArray(results) && results[0] && results[0].result
                              ? results[0].result
                              : null;
                          sendResponse({ color });
                        } catch (e) {
                          sendResponse({ color: null });
                        }
                      },
                    );
                  } catch (e) {
                    sendResponse({ color: null });
                  }
                });
              } catch (e) {
                sendResponse({ color: null });
              }
            } catch (e) {
              sendResponse({ color: null });
            }
          });
        } catch (e) {
          try {
            sendResponse({ color: null });
          } catch (_) {}
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

          chromeApi.scripting.executeScript(
            {
              target: { tabId },
              func: () => {
                try {
                  const bs = String.fromCharCode(92);
                  const w = window;
                  // To avoid TypeScript window typings when this function is serialized,
                  // treat the page window as any at runtime.
                  const pw: any = window as any;
                  const sanitizeTex = (value: unknown): string => {
                    if (typeof value !== 'string') {
                      return value == null ? '' : String(value);
                    }
                    try {
                      let out = value;
                      const chars = ['€', '£', '¥', '•', '–', '—', '…', '←', '→', '↑', '↓'];
                      for (const ch of chars) {
                        out = out.split(ch).join(bs + 'text{' + ch + '}');
                      }
                      // Wrap runs of non-ASCII while avoiding backslash sequences
                      out = out.replace(/([^\\]|^)([\u0080-\uFFFF]+)/g, function (_, lead, run) {
                        return lead + bs + 'text{' + run + '}';
                      });
                      return out;
                    } catch (e) {
                      return value;
                    }
                  };

                  const patchKatex = () => {
                    try {
                      if (pw.katex && typeof pw.katex.render === 'function') {
                        const orig = pw.katex.render;
                        pw.katex.render = function (tex, el, opts) {
                          try {
                            const safe = sanitizeTex(tex);
                            const merged = Object.assign(
                              { throwOnError: false, strict: 'ignore' },
                              opts || {},
                            );
                            return orig.call(this, safe, el, merged);
                          } catch (e) {
                            try {
                              return orig.call(this, tex, el, opts);
                            } catch (__) {
                              return null;
                            }
                          }
                        };
                      }
                    } catch (e) {}
                  };

                  const patchMathJax = () => {
                    try {
                      if (pw.MathJax) {
                        if (typeof pw.MathJax.typesetPromise === 'function') {
                          const orig = pw.MathJax.typesetPromise;
                          pw.MathJax.typesetPromise = function (elements) {
                            try {
                              const scripts = document.querySelectorAll('script[type^="math/tex"]');
                              scripts.forEach((s) => {
                                if (s.textContent) s.textContent = sanitizeTex(s.textContent);
                              });
                            } catch (e) {}
                            return orig.call(this, elements);
                          };
                        }
                        if (pw.MathJax.Hub && pw.MathJax.Hub.Queue) {
                          const origQ = pw.MathJax.Hub.Queue;
                          pw.MathJax.Hub.Queue = function (...args) {
                            try {
                              const scripts = document.querySelectorAll('script[type^="math/tex"]');
                              scripts.forEach((s) => {
                                if (s.textContent) s.textContent = sanitizeTex(s.textContent);
                              });
                            } catch (e) {}
                            return origQ.apply(this, args);
                          };
                        }
                      }
                    } catch (e) {}
                  };

                  patchKatex();
                  patchMathJax();
                  const iv = setInterval(() => {
                    try {
                      patchKatex();
                      patchMathJax();
                    } catch (e) {}
                  }, 1000);
                  setTimeout(() => clearInterval(iv), 30000);
                } catch (e) {
                  /* ignore */
                }
              },
            },
            (results) => {
              try {
                // If executeScript failed, results may be undefined
                if (!results) sendResponse({ ok: false, error: 'exec_failed' });
                else sendResponse({ ok: true });
              } catch (e) {
                try {
                  sendResponse({ ok: false, error: String(e) });
                } catch (_) {}
              }
            },
          );
        } catch (e) {
          try {
            sendResponse({ ok: false, error: String(e) });
          } catch (_) {}
        }
        return true;
      }

      case 'NAVIGATE_TO_SOURCE': {
        const { pageUrl, sourceId } = message.payload || {};
        if (!pageUrl || !sourceId) return;
        (async () => {
          try {
            const requestingTabId =
              sender?.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
            // Prefer sending SCROLL_TO_SOURCE to any existing tab that already has the target page open
            chromeApi.tabs.query({}, (tabs: any[]) => {
              const normalizedTarget = normalizePageUrl(pageUrl);
              const matching = (tabs || []).find(
                (t: any) =>
                  normalizePageUrl(t?.url) === normalizedTarget && typeof t.id === 'number',
              );
              if (matching) {
                scheduleHighlightForTab(matching.id, sourceId, (ok) => {
                  sendResponse(
                    ok ? { ok: true, inPage: true } : { ok: false, error: 'message_failed' },
                  );
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
            const itemData: Record<string, any> = await new Promise((resolve) =>
              persistentStorage.get([sid], resolve),
            );
            const pageUrl = itemData?.[sid]?.pageUrl as string | undefined;
            const normalized = itemData?.[sid]?.normalized_page as string | undefined;

            await new Promise((resolve, reject) => {
              persistentStorage.remove([sid], () => {
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
            const data: Record<string, any> = await new Promise((resolve) =>
              persistentStorage.get(null, resolve),
            );
            const keysToRemove: string[] = [];
            for (const [k, v] of Object.entries(data)) {
              if (k === 'groupsIndex' || k === 'mindMaps') {
                keysToRemove.push(k);
              } else if (v && typeof v === 'object' && v.source_id) {
                keysToRemove.push(k);
              }
            }

            await new Promise((resolve, reject) => {
              persistentStorage.remove(keysToRemove, () => {
                const err = chromeApi.runtime.lastError;
                if (err) return reject(err);
                resolve(true);
              });
            });

            await new Promise((resolve, reject) => {
              persistentStorage.set({ groupsIndex: {}, mindMaps: {} }, () => {
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
            else
              sendResponse({
                ok: false,
                error: 'No hay datos suficientes o falta la clave de API.',
              });
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
            const data: Record<string, any> = await new Promise((resolve) =>
              persistentStorage.get(null, resolve),
            );
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
            if (!toRemove.length) {
              sendResponse({ ok: true, removed: 0 });
              return;
            }
            await new Promise((resolve, reject) => {
              persistentStorage.remove(toRemove, () => {
                const err = chromeApi.runtime.lastError;
                if (err) return reject(err);
                resolve(true);
              });
            });
            try {
              await rebuildGroupsIndex();
            } catch (e) {
              console.error('rebuildGroupsIndex failed after remove', e);
            }
            // regenerate mind maps for affected pages
            for (const np of Array.from(normalizedPages)) {
              try {
                await generateMindMapForPage(typeof np === 'string' ? np : undefined);
              } catch (e) {
                /* ignore */
              }
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
  },
);

function normalizePageUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    let path = parsed.pathname || '/';
    if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1);

    // Canonicalize search params (sorted order) so SPA routes relying on query
    // segments are stable per conversation.
    const params: Array<[string, string]> = [];
    parsed.searchParams.forEach((value, key) => {
      params.push([key, value]);
    });
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
  const allData: Record<string, any> = await new Promise((resolve) =>
    persistentStorage.get(null, resolve),
  );
  const items: Record<string, any>[] = [];
  for (const value of Object.values(allData)) {
    if (value && typeof value === 'object' && (value as any).source_id) {
      items.push(value as Record<string, any>);
    }
  }
  return items;
}

async function saveDataWithGemini(
  messageText: string,
  sourceId: string,
  pageUrl?: string,
  paragraphIndex?: number,
): Promise<Record<string, any>> {
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
    created_at: new Date().toISOString(),
  };
}

async function rebuildGroupsIndex(): Promise<void> {
  const items = await getAllSavedItems();
  const stopwords = new Set([
    'the',
    'and',
    'or',
    'de',
    'la',
    'el',
    'y',
    'a',
    'en',
    'para',
    'con',
    'que',
    'is',
    'of',
    'to',
    'as',
    'it',
  ]);
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
    persistentStorage.set({ groupsIndex: groups }, () => {
      const err = chromeApi.runtime.lastError;
      if (err) return reject(err);
      resolve(true);
    });
  });
}

async function generateMindMapForPage(
  pageUrl?: string,
  preNormalized?: string | null,
): Promise<MindMapData | null> {
  const normalized = preNormalized ?? normalizePageUrl(pageUrl);
  if (!normalized) return null;

  // Generate a simple local mind map from saved items for the page.
  const items = await getAllSavedItems();
  const relevant = items.filter(
    (item) => (item.normalized_page || normalizePageUrl(item.pageUrl)) === normalized,
  );
  if (!relevant.length) return null;

  // Build a token frequency map from titles, summaries and text
  const stopwords = new Set([
    'the',
    'and',
    'or',
    'de',
    'la',
    'el',
    'y',
    'a',
    'en',
    'para',
    'con',
    'que',
    'is',
    'of',
    'to',
    'as',
    'it',
    'un',
    'una',
    'los',
    'las',
  ]);
  const counts: Record<string, number> = {};
  for (const it of relevant) {
    const text =
      `${String(it.title || '')} ${String(it.summary || '')} ${String(it.original_text || '')}`.toLowerCase();
    const tokens = text.split(/[^a-záéíóúñ0-9]+/).filter(Boolean);
    for (const t of tokens) {
      if (t.length < 3) continue;
      if (stopwords.has(t)) continue;
      counts[t] = (counts[t] || 0) + 1;
    }
  }

  const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const conceptos = sorted.slice(0, 5);
  const titulo_central = conceptos.length
    ? conceptos[0].slice(0, 50)
    : relevant[0].title || 'Resumen';

  // Build a short executive summary by joining the first sentences of saved summaries/texts
  const sentences: string[] = [];
  for (const it of relevant) {
    const s = String(it.summary || it.original_text || '').trim();
    if (!s) continue;
    const first = s.split(/\.|\n/)[0].trim();
    if (first) sentences.push(first);
    if (sentences.length >= 6) break;
  }
  let resumen = sentences.join('. ').trim();
  if (resumen && !resumen.endsWith('.')) resumen += '.';
  // Limit to ~50 words
  const words = resumen.split(/\s+/).filter(Boolean);
  if (words.length > 50) resumen = words.slice(0, 50).join(' ') + '...';

  const map: MindMapData = {
    titulo_central: titulo_central || 'Resumen',
    conceptos_clave: conceptos.length ? conceptos : ['general'],
    resumen_ejecutivo: resumen || 'Resumen de los elementos guardados.',
  };

  try {
    const existing: Record<string, any> = await new Promise((resolve) =>
      persistentStorage.get(['mindMaps'], resolve),
    );
    const maps = existing?.mindMaps || {};
    maps[normalized] = {
      data: map,
      updated_at: new Date().toISOString(),
      pageUrl: pageUrl || relevant[0].pageUrl || null,
    };
    await new Promise((resolve, reject) => {
      persistentStorage.set({ mindMaps: maps }, () => {
        const err = chromeApi.runtime.lastError;
        if (err) return reject(err);
        resolve(true);
      });
    });
    notifyMindMapUpdated(normalized, map);
    return map;
  } catch (e) {
    console.error('Local mind map generation failed', e);
    return null;
  }
}

async function getApiKey(): Promise<string | null> {
  const data: Record<string, any> = await new Promise((resolve) =>
    persistentStorage.get(['geminiApiKey'], resolve),
  );
  const key = data?.geminiApiKey;
  if (typeof key === 'string' && key.trim()) return key.trim();
  return null;
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

function scheduleHighlightForTab(
  tabId: number,
  sourceId: string,
  callback: (ok: boolean) => void,
): void {
  try {
    chromeApi.tabs.sendMessage(tabId, { type: 'SCROLL_TO_SOURCE', payload: { sourceId } }, () => {
      const err = chromeApi.runtime.lastError;
      if (!err) {
        callback(true);
        return;
      }

      try {
        chromeApi.scripting.executeScript(
          {
            target: { tabId },
            func: (sid: string) => {
              try {
                const selector = `[data-source-id="${sid}"]`;
                const altSelector = `[data-message-id="${sid}"]`;
                let el = document.querySelector(selector) as HTMLElement | null;
                if (!el) el = document.querySelector(altSelector) as HTMLElement | null;
                if (!el) {
                  el =
                    Array.from(document.querySelectorAll<HTMLElement>('*')).find((e) => {
                      const ds = e.dataset as any;
                      return ds && (ds.sourceId === sid || ds.messageId === sid);
                    }) || null;
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
              } catch (highlightErr) {
                console.error(highlightErr);
                return false;
              }
            },
            args: [sourceId],
          },
          () => {
            const execErr = chromeApi.runtime.lastError;
            if (execErr) {
              console.error('Failed to execute highlight script', execErr);
              callback(false);
            } else {
              callback(true);
            }
          },
        );
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

function navigateExistingTabToSource(
  tabId: number,
  targetUrl: string,
  sourceId: string,
  callback: (result: { ok: boolean; [key: string]: any }) => void,
): void {
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
            if (!ok)
              console.debug('Highlight after navigation may have failed for source', sourceId);
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
        scheduleHighlightForTab(tabId, sourceId, () => {
          /* ignore result */
        });
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
      `Método para navegación rápida en conversación\nConceptos clave\nMétodo\nFacilitar usuario\nVolver a conversación\nNavegación rápida\nDividir tarea\nTres fases\nResumen ejecutivo\nSe presenta un método para que el usuario pueda regresar rápidamente a secciones previas de una conversación. La tarea se estructura en tres fases para optimizar la navegación y la experiencia del usuario.`,
    ];

    const allData: Record<string, any> = await new Promise((resolve) =>
      persistentStorage.get(null, resolve),
    );
    const toRemove: string[] = [];
    const affectedPages = new Set<string>();

    for (const [k, v] of Object.entries(allData)) {
      if (!v || typeof v !== 'object') continue;
      // Only consider saved-snippet shaped objects
      if (!(v as any).source_id) continue;
      try {
        const combined =
          `${String((v as any).title || '')} ${String((v as any).summary || '')} ${String((v as any).original_text || '')}`.toLowerCase();
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
      persistentStorage.remove(toRemove, () => {
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


