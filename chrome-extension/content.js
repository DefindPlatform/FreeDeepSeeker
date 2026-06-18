// DeepSeek Auth Exporter — Content Script
// Runs on chat.deepseek.com to read localStorage values.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'readLocalStorage') {
    const data = {};
    for (const key of request.keys) {
      try {
        data[key] = localStorage.getItem(key) || '';
      } catch {
        data[key] = '';
      }
    }
    sendResponse({ data });
  }
});
