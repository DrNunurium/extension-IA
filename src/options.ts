function showStatus(message: string, isError = false) {
  const status = document.getElementById('status');
  if (!status) return;
  status.textContent = message;
  status.className = isError ? 'error' : '';
}

const syncStorageArea = chrome?.storage?.sync ?? chrome?.storage?.local;

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('apiKey') as HTMLInputElement | null;
  const form = document.getElementById('apiKeyForm') as HTMLFormElement | null;
  const clearBtn = document.getElementById('clearKey') as HTMLButtonElement | null;
  if (!input || !form || !clearBtn) return;

  syncStorageArea?.get(['geminiApiKey'], (data: Record<string, any>) => {
    const key = data?.geminiApiKey || '';
    input.value = key;
    if (key) showStatus('Clave cargada.');
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) {
      showStatus('Introduce una clave válida.', true);
      return;
    }
    syncStorageArea?.set({ geminiApiKey: value }, () => {
      if (chrome.runtime.lastError) {
        showStatus(`Error al guardar: ${chrome.runtime.lastError.message}`, true);
        return;
      }
      showStatus('Clave guardada correctamente.');
    });
  });

  clearBtn.addEventListener('click', () => {
    syncStorageArea?.remove(['geminiApiKey'], () => {
      if (chrome.runtime.lastError) {
        showStatus(`Error al borrar: ${chrome.runtime.lastError.message}`, true);
        return;
      }
      input.value = '';
      showStatus('Clave eliminada.');
    });
  });
});
