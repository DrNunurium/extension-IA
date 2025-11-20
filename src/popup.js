// Open the sidebar.html in a new tab. This is a fallback for when the browser side panel isn't available.
document.addEventListener('DOMContentLoaded', () => {
    // i18n helper
    function __(key, fallback) {
        try {
            if (window.chrome &&
                chrome.i18n &&
                typeof chrome.i18n.getMessage === 'function') {
                const m = chrome.i18n.getMessage(key);
                if (m)
                    return m;
            }
        }
        catch (e) { }
        return fallback || '';
    }
    const btn = document.getElementById('open');
    if (!btn)
        return;
    btn.addEventListener('click', async () => {
        const statusDiv = document.getElementById('status');
        const actionsDiv = document.getElementById('actions');
        if (statusDiv)
            statusDiv.textContent = __('trying_opening', 'Intentando abrir panel en esta pestaña...');
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
                                        if (statusDiv)
                                            statusDiv.textContent = __('cannot_show_tab', 'No se puede mostrar el panel en esta pestaña.');
                                        if (actionsDiv)
                                            actionsDiv.innerHTML =
                                                '<button id="closePopup">' + __('close', 'Cerrar') + '</button>';
                                        const closeBtn = document.getElementById('closePopup');
                                        if (closeBtn)
                                            closeBtn.addEventListener('click', () => window.close());
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
                                                if (statusDiv)
                                                    statusDiv.textContent = __('could_not_open_tab', 'No se pudo abrir el panel en esta pestaña.');
                                                return;
                                            }
                                            if (statusDiv)
                                                statusDiv.textContent = __('panel_opened', 'Panel abierto en esta pestaña.');
                                            if (actionsDiv) {
                                                actionsDiv.innerHTML =
                                                    '<button id="closePopup">' + __('close', 'Cerrar') + '</button>';
                                                const closeBtn2 = document.getElementById('closePopup');
                                                if (closeBtn2)
                                                    closeBtn2.addEventListener('click', () => window.close());
                                            }
                                        });
                                    }, 120);
                                });
                            }
                            catch (injectErr) {
                                console.error('Injection attempt failed', injectErr);
                                if (statusDiv)
                                    statusDiv.textContent = __('cannot_show_tab', 'No se puede mostrar el panel en esta pestaña.');
                            }
                            return;
                        }
                        // success: panel toggled in-page
                        if (statusDiv)
                            statusDiv.textContent = __('panel_opened', 'Panel abierto en esta pestaña.');
                        if (actionsDiv) {
                            actionsDiv.innerHTML =
                                '<button id="closePopup">' + __('close', 'Cerrar') + '</button>';
                            const closeBtn = document.getElementById('closePopup');
                            if (closeBtn)
                                closeBtn.addEventListener('click', () => window.close());
                        }
                    });
                }
                else {
                    // fallback: open in new tab
                    const url = chrome.runtime.getURL('src/sidebar.html');
                    chrome.tabs.create({ url }, () => {
                        if (statusDiv)
                            statusDiv.textContent = __('opened_in_new_tab', 'Se abrió el panel en una nueva pestaña.');
                        if (actionsDiv) {
                            actionsDiv.innerHTML =
                                '<button id="closePopup">' + __('close', 'Cerrar') + '</button>';
                            const closeBtn = document.getElementById('closePopup');
                            if (closeBtn)
                                closeBtn.addEventListener('click', () => window.close());
                        }
                    });
                }
            });
        }
        catch (e) {
            console.error('Failed to toggle or open sidebar page', e);
            if (statusDiv)
                statusDiv.textContent = __('error_opening', 'Error al abrir el panel.');
        }
    });
    // Optionally open immediately when popup shows. Comment out if undesired.
    // btn.click();
});
