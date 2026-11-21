importScripts('config.js', 'remote.js', 'host.js');

// Clique no ícone abre o painel de controle
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// Mensagens do content script / painel
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && typeof msg.type === 'string' && msg.type.startsWith('remote:')) {
    const fn = {
      'remote:status': () => ZFRemote.status(),
      'remote:login': () => ZFRemote.login(msg.email, msg.password),
      'remote:signup': () => ZFRemote.signup(msg.email, msg.password),
      'remote:logout': () => ZFRemote.logout(),
      'remote:claim': () => ZFRemote.claim(),
      'remote:finish': () => ZFRemote.finish(msg.id, msg.ok, msg.result),
      'remote:publish': () => ZFRemote.publish(msg.data),
      'remote:chat': () => ZFRemote.publishChat(msg.chatId, msg.data),
      'remote:audio': () => ZFRemote.audioGet(msg.path),
      'remote:audioDel': () => ZFRemote.audioDel(msg.path),
      'remote:notify': () => ZFRemote.notify(msg.payload)
    }[msg.type];
    if (!fn) return;
    Promise.resolve()
      .then(fn)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg && msg.type === 'openDashboard') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html' + (msg.hash || '')) });
  }
  if (msg && msg.type === 'focusWhatsApp') {
    chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (tabs) => {
      if (tabs.length) {
        chrome.tabs.update(tabs[0].id, { active: true });
        chrome.windows.update(tabs[0].windowId, { focused: true });
        sendResponse({ ok: true });
      } else {
        chrome.tabs.create({ url: 'https://web.whatsapp.com/' });
        sendResponse({ ok: false });
      }
    });
    return true;
  }
});

// Primeira instalação: se existir seed.json na pasta e ainda não houver dados, carrega como ponto de partida.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;
  try {
    const cur = await chrome.storage.local.get(['items', 'funnels']);
    if ((cur.items && cur.items.length) || (cur.funnels && cur.funnels.length)) return;
    const res = await fetch(chrome.runtime.getURL('seed.json'));
    if (!res.ok) return;
    const seed = await res.json();
    const out = {};
    for (const k of ['items', 'funnels', 'remarketing', 'triggers', 'schedules', 'campaigns', 'settings']) if (seed[k]) out[k] = seed[k];
    await chrome.storage.local.set(out);
  } catch (e) {
    // sem seed.json: começa vazio
  }
});

// ---------------------------------------------------------------- relógio + celular
// O Chrome desacelera timers de abas escondidas. Daqui (service worker) mandamos um "tick" por
// segundo para as abas do WhatsApp; cada chamada de API da extensão mantém este worker acordado.
let leaderTabId = null;
try {
  chrome.storage.session.get('leaderTabId').then((d) => {
    if (d && d.leaderTabId && !leaderTabId) leaderTabId = d.leaderTabId;
  });
} catch (e) {}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'zf:leader' || !sender.tab) return;
  if (msg.leader) leaderTabId = sender.tab.id;
  else if (leaderTabId === sender.tab.id) leaderTabId = null;
  ZFHost.setTab(sender.tab.id, !!msg.leader);
  try {
    chrome.storage.session.set({ leaderTabId });
  } catch (e) {}
  // responde se este aparelho pode rodar o motor (Mac x servidor 24h)
  sendResponse(ZFHost.current());
});

let clockN = 0;
let remoteBusy = false;
let lastPublish = 0;
async function clock() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  } catch (e) {
    return;
  }
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'zf:tick' }).catch(() => {});
  clockN++;
  if (clockN % 3 === 0) remoteCycle(tabs);
}
setInterval(clock, 1000);

async function remoteCycle(tabs) {
  if (remoteBusy || !ZFRemote.configured()) return;
  if (!leaderTabId || !tabs.some((t) => t.id === leaderTabId)) return;
  if (!ZFHost.current().ok) return; // outro aparelho está no comando
  remoteBusy = true;
  try {
    const st = await ZFRemote.status();
    if (!st.logged) return;
    let did = false;
    const cmds = await ZFRemote.claim();
    if (cmds.length) {
      let res = null;
      try {
        res = await chrome.tabs.sendMessage(leaderTabId, { type: 'zf:exec', cmds });
      } catch (e) {
        res = null;
      }
      if (!res || res.notReady || !Array.isArray(res.results)) {
        for (const c of cmds) await ZFRemote.release(c.id).catch(() => {});
      } else {
        for (const r of res.results) await ZFRemote.finish(r.id, r.ok, r.result).catch(() => {});
        did = true;
      }
    }
    if (did || Date.now() - lastPublish > 10000) {
      let snap = null;
      try {
        snap = await chrome.tabs.sendMessage(leaderTabId, { type: 'zf:snapshot' });
      } catch (e) {}
      if (snap) {
        snap.host = ZFHost.info();
        await ZFRemote.publish(snap);
        lastPublish = Date.now();
      }
    }
  } catch (e) {
    console.warn('[ZapFunil] remoto', e && e.message);
  } finally {
    remoteBusy = false;
  }
}
