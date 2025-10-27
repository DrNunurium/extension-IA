type SaveChatDataPayload = {
  messageText: string;
  sourceId: string;
};

async function saveDataWithGemini(messageText: string, sourceId: string): Promise<void> {
  const requestBody = {
    input: messageText,
    metadata: {
      sourceId
    }
  };

  await new Promise((resolve) => setTimeout(resolve, 250));
  console.debug('Simulated Gemini request', requestBody);
}

const chromeApi = (globalThis as typeof globalThis & { chrome?: any }).chrome;

if (!chromeApi?.runtime?.onMessage) {
  console.warn('Chrome runtime API is not available in this context.');
}

chromeApi?.runtime?.onMessage.addListener((message: { type?: string; payload?: SaveChatDataPayload }, _sender: unknown, sendResponse: (response?: unknown) => void) => {
  if (message?.type !== 'SAVE_CHAT_DATA' || !message.payload) {
    return;
  }

  const { messageText, sourceId } = message.payload;
  saveDataWithGemini(messageText, sourceId)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error('Failed to simulate Gemini request', error);
      sendResponse({ ok: false, error: String(error) });
    });

  return true;
});
