// ZapFunil – monta o arquivo do backup automático (o service worker não consegue criar arquivos grandes sozinho)
const parts = {};
const urls = {};
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'zf-offscreen') return;
  if (msg.type === 'chunk') {
    (parts[msg.id] = parts[msg.id] || []).push(msg.data);
    sendResponse({ ok: true });
  } else if (msg.type === 'finish') {
    const blob = new Blob(parts[msg.id] || [], { type: 'application/json' });
    delete parts[msg.id];
    urls[msg.id] = URL.createObjectURL(blob);
    sendResponse({ ok: true, url: urls[msg.id], size: blob.size });
  } else if (msg.type === 'revoke') {
    if (urls[msg.id]) URL.revokeObjectURL(urls[msg.id]);
    delete urls[msg.id];
    sendResponse({ ok: true });
  }
});
