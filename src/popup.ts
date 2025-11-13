// Open the sidebar.html in a new tab. This is a fallback for when the browser side panel isn't available.

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('open') as HTMLButtonElement | null;

  if (!btn) return;
  btn.addEventListener('click', async () => {
    const statusDiv = document.getElementById('status') as HTMLElement | null;
    const actionsDiv = document.getElementById('actions') as HTMLElement | null;
    if (statusDiv) statusDiv.textContent = 'Intentando abrir panel en esta pestaña...';
    try {
      // request the active tab to toggle the in-page side panel
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const t = tabs && tabs[0];
        if (t && typeof t.id === 'number') {
          // use a callback to detect runtime.lastError instead of letting the error be uncaught
          chrome.tabs.sendMessage(t.id, { type: 'TOGGLE_SIDE_PANEL' }, (resp) => {
            const lastErr = chrome.runtime.lastError;
            if (lastErr) {
              console.debug('No content script listener in active tab or error:', lastErr.message);
              // Try to inject the content script into the active tab so the panel
              // can open in the same tab (user requested same-tab behavior).
              try {
                chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['src/contentScript.js'] }, () => {
                  const execErr = chrome.runtime.lastError;
                  if (execErr) {
                    console.debug('Failed to inject content script:', execErr.message);
                    if (statusDiv) statusDiv.textContent = 'No se puede mostrar el panel en esta pestaña.';
                    if (actionsDiv) actionsDiv.innerHTML = '<button id="closePopup">Cerrar</button>';
                    const closeBtn = document.getElementById('closePopup') as HTMLButtonElement | null;
                    if (closeBtn) closeBtn.addEventListener('click', () => window.close());
                    return;
                  }
                  // After injecting, give the page a tick to initialize listeners,
                  // then attempt to send the message again. This avoids a race
                  // where the injected script hasn't yet registered its onMessage
                  // handler and would ignore the first toggle.
                  setTimeout(() => {
                    chrome.tabs.sendMessage(t.id, { type: 'TOGGLE_SIDE_PANEL' }, (resp2) => {
                    const err2 = chrome.runtime.lastError;
                    if (err2) {
                      console.debug('Message failed after injection:', err2.message);
                      if (statusDiv) statusDiv.textContent = 'No se pudo abrir el panel en esta pestaña.';
                      return;
                    }
                    if (statusDiv) statusDiv.textContent = 'Panel abierto en esta pestaña.';
                    if (actionsDiv) {
                      actionsDiv.innerHTML = '<button id="closePopup">Cerrar</button>';
                      const closeBtn2 = document.getElementById('closePopup') as HTMLButtonElement | null;
                      if (closeBtn2) closeBtn2.addEventListener('click', () => window.close());
                    }
                    });
                  }, 120);
                });
              } catch (injectErr) {
                console.error('Injection attempt failed', injectErr);
                if (statusDiv) statusDiv.textContent = 'No se puede mostrar el panel en esta pestaña.';
              }
              return;
            }
            // success: panel toggled in-page
            if (statusDiv) statusDiv.textContent = 'Panel abierto en esta pestaña.';
            if (actionsDiv) {
              actionsDiv.innerHTML = '<button id="closePopup">Cerrar</button>';
              const closeBtn = document.getElementById('closePopup') as HTMLButtonElement | null;
              if (closeBtn) closeBtn.addEventListener('click', () => window.close());
            }
          });
        } else {
          // fallback: open in new tab
          const url = chrome.runtime.getURL('src/sidebar.html');
          chrome.tabs.create({ url }, () => {
            if (statusDiv) statusDiv.textContent = 'Se abrió el panel en una nueva pestaña.';
            if (actionsDiv) {
              actionsDiv.innerHTML = '<button id="closePopup">Cerrar</button>';
              const closeBtn = document.getElementById('closePopup') as HTMLButtonElement | null;
              if (closeBtn) closeBtn.addEventListener('click', () => window.close());
            }
          });
        }
      });
    } catch (e) {
      console.error('Failed to toggle or open sidebar page', e);
      if (statusDiv) statusDiv.textContent = 'Error al abrir el panel.';
    }
  });

  // Optionally open immediately when popup shows. Comment out if undesired.
  // btn.click();
});
