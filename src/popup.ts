// Open the sidebar.html in a new tab. This is a fallback for when the browser side panel isn't available.

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('open') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      const url = chrome.runtime.getURL('src/sidebar.html');
      chrome.tabs.create({ url });
      window.close();
    } catch (e) {
      console.error('Failed to open sidebar page', e);
    }
  });

  // Optionally open immediately when popup shows. Comment out if undesired.
  // btn.click();
});
