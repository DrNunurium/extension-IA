type SaveChatDataPayload = {
  messageText: string;
  sourceId: string;
  pageUrl?: string;
  paragraphIndex?: number;
};

// Simulate calling Gemini and return a structured object that would be stored.
async function saveDataWithGemini(messageText: string, sourceId: string, pageUrl?: string, paragraphIndex?: number): Promise<Record<string, any>> {
  const requestBody = {
    input: messageText,
    metadata: { sourceId, pageUrl, paragraphIndex }
  };

  // simulate latency
  await new Promise((resolve) => setTimeout(resolve, 250));

  // Simulated structured response (in production replace with real API call)
  const title = messageText.split('\n')[0].split(' ').slice(0, 8).join(' ');
  const summary = messageText.replace(/\s+/g, ' ').slice(0, 200);

  const result = {
    source_id: sourceId,
    title,
    summary,
    key_points: [],
    actions: [],
    entities: [],
    original_text: messageText,
    pageUrl: pageUrl || null,
    paragraphIndex: typeof paragraphIndex === 'number' ? paragraphIndex : null,
    created_at: new Date().toISOString()
  };

  console.debug('Simulated Gemini response', { requestBody, result });
  return result;
}

const chromeApi = (globalThis as typeof globalThis & { chrome?: any }).chrome;

if (!chromeApi?.runtime?.onMessage) {
  console.warn('Chrome runtime API is not available in this context.');
}

chromeApi?.runtime?.onMessage.addListener((message: { type?: string; payload?: SaveChatDataPayload }, _sender: unknown, sendResponse: (response?: unknown) => void) => {
  if (message?.type !== 'SAVE_CHAT_DATA' || !message.payload) {
    return;
  }

  const { messageText, sourceId, pageUrl, paragraphIndex } = message.payload;

  (async () => {
    try {
      const structured = await saveDataWithGemini(messageText, sourceId, pageUrl, paragraphIndex);

      // save result in chrome.storage.local using source_id as key
      try {
        await new Promise((resolve, reject) => {
          chromeApi.storage.local.set({ [structured.source_id]: structured }, () => {
            const err = chromeApi.runtime.lastError;
            if (err) return reject(err);
            resolve(true);
          });
        });
      } catch (storeErr) {
        console.error('Failed to save data in storage', storeErr);
        sendResponse({ ok: false, error: String(storeErr) });
        return;
      }

      try {
        // Rebuild grouping index after storing
        await rebuildGroupsIndex();
      } catch (grpErr) {
        console.error('Failed to rebuild groups index', grpErr);
      }

      sendResponse({ ok: true, item: structured });
    } catch (error) {
      console.error('Failed to simulate Gemini request', error);
      sendResponse({ ok: false, error: String(error) });
    }
  })();

  return true;
});

// Helper: rebuild a simple groups index stored at key 'groupsIndex'.
async function rebuildGroupsIndex(): Promise<void> {
  // Get all items
  const allData: Record<string, any> = await new Promise((resolve) => chromeApi.storage.local.get(null, resolve));
  const items: Record<string, any>[] = [];
  for (const [k, v] of Object.entries(allData)) {
    if (v && typeof v === 'object' && v.source_id) items.push(v as Record<string, any>);
  }

  // Simple keyword-based grouping: extract words from title+summary and group by the most common keyword overlap
  const stopwords = new Set(['the','and','or','de','la','el','y','a','en','para','con','que','is','of','to','as','it']);
  const groups: Record<string, { title: string; items: string[]; updated_at: string } > = {};

  function extractKeywords(text: string) {
    return (text || '').toLowerCase().split(/[^a-záéíóúñ0-9]+/).filter(Boolean).filter(w => !stopwords.has(w)).slice(0, 8);
  }

  for (const item of items) {
    const keywords = extractKeywords((item.title || '') + ' ' + (item.summary || ''));
    // try to find an existing group that shares any keyword
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
      const primary = keywords[0] || 'otros';
      if (!groups[primary]) {
        groups[primary] = { title: primary, items: [], updated_at: new Date().toISOString() };
      }
      groups[primary].items.push(item.source_id);
    }
  }

  // persist groupsIndex
  await new Promise((resolve, reject) => {
    chromeApi.storage.local.set({ groupsIndex: groups }, () => {
      const err = chromeApi.runtime.lastError;
      if (err) return reject(err);
      resolve(true);
    });
  });
}

// Handle navigation requests from sidebar: open tab and scroll to element with source id
chromeApi?.runtime?.onMessage.addListener((msg: any, _sender: any, sendResp: any) => {
  if (msg?.type !== 'NAVIGATE_TO_SOURCE' || !msg.payload) return;
  const { pageUrl, sourceId } = msg.payload;

  (async () => {
    try {
      // open the page in a new tab and navigate to the element
  const tab: any = await new Promise((resolve) => chromeApi.tabs.create({ url: pageUrl, active: true }, resolve));
  const tabId: number = tab.id as number;

      // wait for the tab to finish loading
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
                    // try dataset matching
                    el = Array.from(document.querySelectorAll('*')).find(e => (e as HTMLElement).dataset && (((e as HTMLElement).dataset as any).sourceId === sid || ((e as HTMLElement).dataset as any).messageId === sid)) as HTMLElement | null;
                  }
                  if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    const prev = el.style.outline;
                    el.style.outline = '3px solid #ffb86b';
                    setTimeout(() => { el.style.outline = prev; }, 4000);
                    return true;
                  }
                  return false;
                } catch (e) { return false; }
              },
              args: [sourceId]
            });
          } catch (execErr) {
            console.error('Failed to execute highlight script', execErr);
          }
        }
      };
      chromeApi.tabs.onUpdated.addListener(listener);

      sendResp({ ok: true });
    } catch (e) {
      console.error('NAVIGATE_TO_SOURCE failed', e);
      sendResp({ ok: false, error: String(e) });
    }
  })();
  return true;
});
