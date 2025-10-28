// Open the sidebar.html in a new tab. This is a fallback for when the browser side panel isn't available.
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('open');
    const optionsBtn = document.getElementById('openOptions');
    if (optionsBtn) {
        optionsBtn.addEventListener('click', () => {
            if (chrome.runtime.openOptionsPage) {
                chrome.runtime.openOptionsPage();
            }
            else {
                const url = chrome.runtime.getURL('src/options.html');
                chrome.tabs.create({ url });
            }
        });
    }
    if (!btn)
        return;
    btn.addEventListener('click', async () => {
        const statusDiv = document.getElementById('status');
        const actionsDiv = document.getElementById('actions');
        if (statusDiv)
            statusDiv.textContent = 'Intentando abrir panel en esta pestaña...';
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
                            // fallback: open sidebar page in a new tab and inform the user
                            const url = chrome.runtime.getURL('src/sidebar.html');
                            chrome.tabs.create({ url }, () => {
                                if (statusDiv)
                                    statusDiv.textContent = 'La página no admite el panel en esta pestaña. Se abrió en una nueva pestaña.';
                                if (actionsDiv) {
                                    actionsDiv.innerHTML = '<button id="closePopup">Cerrar</button>';
                                    const closeBtn = document.getElementById('closePopup');
                                    if (closeBtn)
                                        closeBtn.addEventListener('click', () => window.close());
                                }
                            });
                            return;
                        }
                        // success: panel toggled in-page
                        if (statusDiv)
                            statusDiv.textContent = 'Panel abierto en esta pestaña.';
                        if (actionsDiv) {
                            actionsDiv.innerHTML = '<button id="closePopup">Cerrar</button>';
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
                            statusDiv.textContent = 'Se abrió el panel en una nueva pestaña.';
                        if (actionsDiv) {
                            actionsDiv.innerHTML = '<button id="closePopup">Cerrar</button>';
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
                statusDiv.textContent = 'Error al abrir el panel.';
        }
    });
    // Optionally open immediately when popup shows. Comment out if undesired.
    // btn.click();
});
