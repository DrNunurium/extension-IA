function showStatus(message, isError = false) {
    const status = document.getElementById('status');
    if (!status)
        return;
    status.textContent = message;
    status.className = isError ? 'error' : '';
}
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('apiKey');
    const form = document.getElementById('apiKeyForm');
    const clearBtn = document.getElementById('clearKey');
    if (!input || !form || !clearBtn)
        return;
    chrome.storage.local.get(['geminiApiKey'], (data) => {
        const key = data?.geminiApiKey || '';
        input.value = key;
        if (key)
            showStatus('Clave cargada.');
    });
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = input.value.trim();
        if (!value) {
            showStatus('Introduce una clave válida.', true);
            return;
        }
        chrome.storage.local.set({ geminiApiKey: value }, () => {
            if (chrome.runtime.lastError) {
                showStatus(`Error al guardar: ${chrome.runtime.lastError.message}`, true);
                return;
            }
            showStatus('Clave guardada correctamente.');
        });
    });
    clearBtn.addEventListener('click', () => {
        chrome.storage.local.remove(['geminiApiKey'], () => {
            if (chrome.runtime.lastError) {
                showStatus(`Error al borrar: ${chrome.runtime.lastError.message}`, true);
                return;
            }
            input.value = '';
            showStatus('Clave eliminada.');
        });
    });
});
