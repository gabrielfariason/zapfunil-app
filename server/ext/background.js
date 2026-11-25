importScripts('common.js', 'config.js', 'remote.js', 'host.js');

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
  // painel pede a lista de grupos: pergunta para a aba do WhatsApp
  if (msg && msg.type === 'wa:groups') {
    chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }).then(async (tabs) => {
      let last = 'Abra o WhatsApp Web neste Chrome para carregar os grupos';
      for (const t of tabs) {
        try {
          const r = await chrome.tabs.sendMessage(t.id, { type: 'zf:groups' });
          if (r && r.list) return sendResponse(r);
          if (r && r.error) last = r.error;
        } catch (e) {}
      }
      sendResponse({ error: last });
    });
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

// ------------------------------------------------------------ backup automático (vai para Downloads/ZapFunil-backups)
const BK_KEYS = ['items', 'funnels', 'triggers', 'schedules', 'campaigns', 'settings', 'remarketing', 'rmktBlock', 'stats'];
const BK_DEF = { enabled: true, everyDays: 7, includeMedia: true, keep: 4 };
let bkBusy = false;
async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  try {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Gerar o arquivo do backup automático' });
  } catch (e) {
    if (!/single offscreen|already/i.test(e.message || '')) throw e;
  }
}
function waitDownload(id) {
  return new Promise((resolve) => {
    const done = (ok, err) => { chrome.downloads.onChanged.removeListener(fn); clearTimeout(t); resolve({ ok, err }); };
    const fn = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') done(true);
      else if (d.state.current === 'interrupted') done(false, (d.error && d.error.current) || 'interrompido');
    };
    const t = setTimeout(() => done(false, 'demorou demais'), 120000);
    chrome.downloads.onChanged.addListener(fn);
    chrome.downloads.search({ id }).then((r) => { if (r[0] && r[0].state === 'complete') done(true); }).catch(() => {});
  });
}
async function autoBackup(force) {
  if (bkBusy) return { ok: false, error: 'já está fazendo um backup' };
  const d = await chrome.storage.local.get(['settings', 'hostKind', 'autoBackupLast', 'autoBackupIds']);
  if (d.hostKind === 'server') return { ok: false, error: 'o servidor 24h não faz backup local' };
  const cfg = Object.assign({}, BK_DEF, (d.settings && d.settings.autoBackup) || {});
  if (!force) {
    if (!cfg.enabled) return { ok: false, skipped: true };
    if (Date.now() - (d.autoBackupLast || 0) < Math.max(1, Number(cfg.everyDays) || 7) * 86400000) return { ok: false, skipped: true };
  }
  bkBusy = true;
  const id = Date.now().toString(36);
  try {
    const data = await chrome.storage.local.get(BK_KEYS);
    data.items = await ZF.fullItems(data.items || []); // backup no formato de sempre (mídia dentro do item)
    if (!force && !(data.items || []).length && !(data.funnels || []).length) return { ok: false, skipped: true };
    if (!cfg.includeMedia) {
      data.items = (data.items || []).map((i) => {
        if (!i.data) return i;
        const c = Object.assign({}, i);
        delete c.data;
        c.noMedia = true;
        return c;
      });
      data.noMedia = true;
    }
    data.__zapfunil = 1;
    data.auto = true;
    data.exportedAt = new Date().toISOString();
    const json = JSON.stringify(data);
    data.items = null; // libera memória
    await ensureOffscreen();
    const CH = 4 * 1024 * 1024;
    for (let i = 0; i < json.length; i += CH) {
      const r = await chrome.runtime.sendMessage({ target: 'zf-offscreen', type: 'chunk', id, data: json.slice(i, i + CH) });
      if (!r || !r.ok) throw new Error('falha ao montar o arquivo');
    }
    const fin = await chrome.runtime.sendMessage({ target: 'zf-offscreen', type: 'finish', id });
    if (!fin || !fin.url) throw new Error('falha ao montar o arquivo');
    const now = new Date();
    const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + '_' + String(now.getHours()).padStart(2, '0') + 'h' + String(now.getMinutes()).padStart(2, '0');
    const dlId = await chrome.downloads.download({ url: fin.url, filename: 'ZapFunil-backups/zapfunil-auto-' + stamp + (cfg.includeMedia ? '' : '-sem-midias') + '.json', conflictAction: 'uniquify', saveAs: false });
    const res = await waitDownload(dlId);
    chrome.runtime.sendMessage({ target: 'zf-offscreen', type: 'revoke', id }).catch(() => {});
    if (!res.ok) throw new Error('download ' + res.err);
    // guarda só os N mais recentes (apaga os antigos que a própria extensão criou)
    const ids = (d.autoBackupIds || []).concat([dlId]);
    const keep = Math.max(1, Number(cfg.keep) || 4);
    while (ids.length > keep) {
      const old = ids.shift();
      await chrome.downloads.removeFile(old).catch(() => {});
      await chrome.downloads.erase({ id: old }).catch(() => {});
    }
    const [item] = await chrome.downloads.search({ id: dlId });
    await chrome.storage.local.set({ autoBackupLast: Date.now(), autoBackupIds: ids, autoBackupInfo: { at: Date.now(), size: fin.size, file: item ? item.filename : '', error: '' } });
    return { ok: true, size: fin.size, file: item ? item.filename : '' };
  } catch (e) {
    await chrome.storage.local.set({ autoBackupInfo: Object.assign({}, (await chrome.storage.local.get('autoBackupInfo')).autoBackupInfo || {}, { error: e.message || String(e), errorAt: Date.now() }) });
    return { ok: false, error: e.message || String(e) };
  } finally {
    bkBusy = false;
    try { if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument(); } catch (e) {}
  }
}
chrome.alarms.get('zfBackup').then((a) => { if (!a) chrome.alarms.create('zfBackup', { delayInMinutes: 3, periodInMinutes: 60 }); }).catch(() => {});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'zfBackup') autoBackup(false).catch(() => {}); });
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'backup:now') {
    autoBackup(true).then(sendResponse);
    return true;
  }
});

// ------------------------------------------------------------ mídias separadas: migração e limpeza
// 1) itens antigos com a mídia dentro → backup automático primeiro, depois separa (nada é apagado)
// 2) mídia sem item (item excluído) só é apagada se continuar órfã em duas verificações seguidas (1h+ de intervalo)
let migBusy = false;
async function migrateMedia() {
  if (migBusy) return;
  migBusy = true;
  try {
    const { items, mediaMigratedAt } = await chrome.storage.local.get(['items', 'mediaMigratedAt']);
    if (!Array.isArray(items) || !items.some((i) => i && i.data)) return;
    const d = await chrome.storage.local.get(['hostKind']);
    if (!mediaMigratedAt && d.hostKind !== 'server') {
      const r = await autoBackup(true).catch((e) => ({ ok: false, error: e.message }));
      await chrome.storage.local.set({ mediaMigrationBackup: r && r.ok ? (r.file || 'ok') : 'falhou: ' + ((r && r.error) || '?') });
    }
    // relê (pode ter mudado durante o backup) e separa
    const cur = (await chrome.storage.local.get('items')).items || [];
    const sp = ZF.splitItems(cur);
    if (!Object.keys(sp.media).length) return;
    await chrome.storage.local.set(sp.media);
    // confere antes de tirar a mídia da lista
    const back = await chrome.storage.local.get(Object.keys(sp.media));
    for (const [k, v] of Object.entries(sp.media)) if (back[k] !== v) throw new Error('conferência falhou em ' + k);
    const again = (await chrome.storage.local.get('items')).items || [];
    if (JSON.stringify(again) !== JSON.stringify(cur)) return; // mudou no meio: tenta na próxima
    await chrome.storage.local.set({ items: sp.items, mediaMigratedAt: Date.now() });
  } catch (e) {
    chrome.storage.local.set({ mediaMigrationError: String(e.message || e) }).catch(() => {});
  } finally {
    migBusy = false;
  }
}
async function mediaGc() {
  try {
    const keys = chrome.storage.local.getKeys ? await chrome.storage.local.getKeys() : Object.keys(await chrome.storage.local.get(null));
    const { items, mediaOrphans } = await chrome.storage.local.get(['items', 'mediaOrphans']);
    const used = new Set((items || []).map((i) => ZF.mediaKey(i.id)));
    const orphans = keys.filter((k) => k.startsWith(ZF.MEDIA) && !used.has(k));
    const prev = (mediaOrphans && mediaOrphans.keys) || [];
    const ripe = Date.now() - ((mediaOrphans && mediaOrphans.at) || 0) > 50 * 60000;
    const del = ripe ? orphans.filter((k) => prev.includes(k)) : [];
    if (del.length) await chrome.storage.local.remove(del);
    if (ripe || !mediaOrphans) await chrome.storage.local.set({ mediaOrphans: { at: Date.now(), keys: orphans.filter((k) => !del.includes(k)) } });
  } catch (e) {}
}
setTimeout(() => migrateMedia().then(mediaGc), 4000);
// se alguém gravar a lista com mídia dentro (versão antiga aberta, importação…), separa logo depois
let migT = null;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !ch.items || !Array.isArray(ch.items.newValue)) return;
  if (!ch.items.newValue.some((i) => i && i.data)) return;
  clearTimeout(migT);
  migT = setTimeout(() => migrateMedia(), 3000);
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'zfBackup') migrateMedia().then(mediaGc); });
