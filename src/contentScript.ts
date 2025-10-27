declare const chrome: any;

const MESSAGE_SELECTOR = '[data-message-id]';
const BUTTON_CLASS = 'ai-chat-knowledge-organizer-save';
const BUTTON_LABEL = 'Guardar Datos';

type ChatMessageElement = HTMLElement & { dataset: { messageId?: string } };

function injectSaveButton(messageEl: ChatMessageElement): void {
  if (messageEl.querySelector(`.${BUTTON_CLASS}`)) {
    return;
  }

  const button = document.createElement('button');
  button.className = BUTTON_CLASS;
  button.textContent = BUTTON_LABEL;
  button.type = 'button';

  const sourceId = messageEl.dataset.messageId ?? crypto.randomUUID();
  button.addEventListener('click', () => {
    const messageText = messageEl.textContent ?? '';
    chrome.runtime.sendMessage({
      type: 'SAVE_CHAT_DATA',
      payload: {
        sourceId,
        messageText
      }
    });
  });

  messageEl.appendChild(button);
}

function processExistingMessages(root: ParentNode): void {
  root.querySelectorAll<ChatMessageElement>(MESSAGE_SELECTOR).forEach((messageEl) => {
    injectSaveButton(messageEl);
  });
}

function beginObserving(): void {
  processExistingMessages(document);

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) {
          return;
        }
        if (node.matches?.(MESSAGE_SELECTOR)) {
          injectSaveButton(node as ChatMessageElement);
        }
        node.querySelectorAll?.(MESSAGE_SELECTOR).forEach((child) => {
          injectSaveButton(child as ChatMessageElement);
        });
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', beginObserving, { once: true });
} else {
  beginObserving();
}
