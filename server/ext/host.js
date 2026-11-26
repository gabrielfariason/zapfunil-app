// ZapFunil – vários aparelhos (Mac + servidor 24h). Roda no service worker (background).
//
// 1) Revezamento: só UM aparelho roda o motor (funis automáticos, remarketing, agenda, campanhas,
//    comandos do celular, notificações). O Mac tem prioridade; o servidor assume quando o Mac some
//    e devolve quando o Mac volta, sem cortar envio no meio (ver zf_beat no banco).
//    Sem servidor cadastrado, o Mac funciona exatamente como antes (nunca é bloqueado).
// 2) Sincronização: funis, mensagens, remarketing etc. ficam iguais nos dois aparelhos (tabela zf_kv).
/* global ZFRemote */
const ZFHost = (() => {
  const SYNC_KEYS = ['items', 'funnels', 'triggers', 'schedules', 'campaigns', 'settings', 'triggerLog', 'history', 'remarketing', 'rmktQueue', 'rmktBlock', 'stats', 'gLists', 'gPosts', 'gSchedules', 'gAuto'];
  const VERDICT_MS = 30000;
  const me = { id: null, kind: 'mac', name: 'Mac', multi: false, loaded: false };
  let verdict = { cloud: null, until: 0 };
  let tabId = null; // aba do WhatsApp que é a "líder local" deste navegador
  let lastTab = { waReady: false, busy: false, state: 'loading', qr: null };
  const link = { reqId: null, code: null, err: null, at: 0 };
  let logged = false;
  let loopBusy = false;
  let n = 0;
  let lastOk = true;
  const version = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch (e) {
      return '?';
    }
  })();

  async function ident() {
    if (me.loaded) return;
    const d = await chrome.storage.local.get(['hostId', 'hostKind', 'hostName', 'zfMulti']);
    if (!d.hostId) {
      d.hostId = (self.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
      await chrome.storage.local.set({ hostId: d.hostId });
    }
    me.id = d.hostId;
    me.kind = d.hostKind === 'server' ? 'server' : 'mac';
    me.name = d.hostName || (me.kind === 'server' ? 'Servidor 24h' : 'Mac');
    me.multi = me.kind === 'server' || !!d.zfMulti;
    me.loaded = true;
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.hostKind || ch.hostName) me.loaded = false;
  });

  // ---------------------------------------------------------------- veredito (pode rodar o motor?)
  // until = 0 → sem prazo (modo de um aparelho só, igual a antes)
  let lastBeatOk = 0; // última vez que a nuvem respondeu à batida
  let since = Date.now();
  const OFFLINE_MS = 90000;
  function current() {
    if (!logged || (!me.multi && me.kind === 'mac')) return { ok: true, until: 0 };
    // Mac sem resposta da nuvem há 90 s (Supabase fora do ar, internet instável): não fica travado,
    // volta a rodar sozinho como antes. O servidor nunca assume sem a nuvem (evita envio em dobro).
    if (me.kind === 'mac' && Date.now() - Math.max(lastBeatOk, since) > OFFLINE_MS) return { ok: true, until: 0 };
    const ok = verdict.cloud === true && Date.now() < verdict.until;
    return { ok, until: ok ? verdict.until : 1 };
  }
  async function broadcast() {
    const v = current();
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    } catch (e) {}
    for (const t of tabs) chrome.tabs.sendMessage(t.id, Object.assign({ type: 'zf:cloud' }, v)).catch(() => {});
  }
  function setTab(id, isLocalLeader) {
    if (isLocalLeader) tabId = id;
    else if (tabId === id) tabId = null;
  }

  // ---------------------------------------------------------------- sincronização
  const S = { meta: {}, dirty: {}, hashes: {}, ready: false, loaded: false };
  const applied = {}; // chave -> JSON que nós mesmos gravamos (para não reenviar)
  let gen = 1;
  async function sLoad() {
    if (S.loaded) return;
    const { zfSync } = await chrome.storage.local.get('zfSync');
    Object.assign(S, zfSync || {}, { loaded: true });
  }
  let saveT = null;
  function sSave() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      chrome.storage.local.set({ zfSync: { meta: S.meta, dirty: S.dirty, hashes: S.hashes, ready: S.ready } }).catch(() => {});
    }, 300);
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    for (const k of Object.keys(ch)) {
      if (!SYNC_KEYS.includes(k)) continue;
      const v = ch[k].newValue;
      const str = JSON.stringify(v === undefined ? null : v);
      if (applied[k] !== undefined && applied[k] === str) {
        delete applied[k];
        continue;
      }
      S.dirty[k] = gen++;
      sSave();
    }
  });
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36) + ':' + str.length;
  }
  const inList = (keys) => encodeURIComponent('(' + keys.map((k) => '"' + String(k).replace(/["\\]/g, '') + '"').join(',') + ')');
  async function fetchValues(keys) {
    const out = {};
    for (let i = 0; i < keys.length; i += 8) {
      const part = keys.slice(i, i + 8);
      const rows = (await ZFRemote.rest('zf_kv?select=key,rev,value&key=in.' + inList(part))) || [];
      for (const r of rows) out[r.key] = r;
    }
    return out;
  }
  async function setLocal(k, v) {
    if (k === 'items' && Array.isArray(v)) {
      // mídia vai para a chave própria; a lista fica leve
      const sp = ZF.splitItems(v);
      applied[k] = JSON.stringify(sp.items);
      if (Object.keys(sp.media).length) await chrome.storage.local.set(sp.media);
      await chrome.storage.local.set({ items: sp.items });
      return;
    }
    applied[k] = JSON.stringify(v === undefined ? null : v);
    await chrome.storage.local.set({ [k]: v });
  }

  async function pull(isLeaderNow) {
    const rows = (await ZFRemote.rest('zf_kv?select=key,rev')) || [];
    const remote = {};
    for (const r of rows) remote[r.key] = r.rev;
    const need = rows.filter((r) => (S.meta[r.key] || 0) < r.rev).map((r) => r.key);
    if (need.length) {
      const got = await fetchValues(need);
      const local = await chrome.storage.local.get(SYNC_KEYS);
      // chaves simples
      for (const k of SYNC_KEYS) {
        if (k === 'items' || !got[k]) continue;
        if (S.dirty[k] && isLeaderNow) continue; // quem está no comando vence: o nosso vai subir
        await setLocal(k, got[k].value);
        S.meta[k] = got[k].rev;
        delete S.dirty[k];
      }
      // itens (cada mensagem/áudio numa linha própria, para não reenviar mídia pesada)
      const itemRows = Object.keys(got).filter((k) => k.startsWith('items#'));
      if ((got.items || itemRows.length) && !(S.dirty.items && isLeaderNow)) {
        const cur = Array.isArray(local.items) ? local.items : [];
        const byId = {};
        for (const it of cur) byId[it.id] = it;
        const ids = got.items && got.items.value && Array.isArray(got.items.value.ids) ? got.items.value.ids : cur.map((i) => i.id);
        const fresh = {};
        for (const k of itemRows) fresh[k.slice(6)] = got[k];
        const missing = ids.filter((id) => !fresh[id] && !byId[id] && remote['items#' + id]);
        if (missing.length) Object.assign(fresh, Object.fromEntries(Object.entries(await fetchValues(missing.map((id) => 'items#' + id))).map(([k, r]) => [k.slice(6), r])));
        const next = ids.map((id) => (fresh[id] ? fresh[id].value : byId[id])).filter(Boolean);
        await setLocal('items', next);
        for (const id of Object.keys(fresh)) {
          S.meta['items#' + id] = fresh[id].rev;
          S.hashes[id] = hash(JSON.stringify(fresh[id].value));
        }
        if (got.items) S.meta.items = got.items.rev;
        delete S.dirty.items;
      }
    }
    if (!S.ready) {
      // primeira vez neste aparelho: o que só existe aqui sobe para a nuvem
      const local = await chrome.storage.local.get(SYNC_KEYS);
      for (const k of SYNC_KEYS) {
        const v = local[k];
        const empty = v === undefined || v === null || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
        if (!remote[k] && !empty) S.dirty[k] = gen++;
      }
      S.ready = true;
    }
    sSave();
  }

  async function push() {
    const keys = Object.keys(S.dirty);
    if (!keys.length) return;
    const snap = Object.assign({}, S.dirty);
    const local = await chrome.storage.local.get(keys);
    const rows = [];
    const dels = [];
    const newHashes = {};
    for (const k of keys) {
      const v = local[k];
      if (v === undefined) continue;
      if (k === 'items' && Array.isArray(v)) {
        const ids = v.map((i) => i.id);
        rows.push({ key: 'items', value: { ids }, host: me.id });
        // na nuvem cada item vai completo (com a mídia), no mesmo formato de sempre
        const full = await ZF.fullItems(v);
        for (const it of full) {
          const h = hash(JSON.stringify(it));
          if (S.hashes[it.id] !== h) {
            rows.push({ key: 'items#' + it.id, value: it, host: me.id });
            newHashes[it.id] = h;
          }
        }
        for (const id of Object.keys(S.hashes)) if (!ids.includes(id)) dels.push(id);
      } else {
        rows.push({ key: k, value: v, host: me.id });
      }
    }
    // envia em pacotes de até ~3 MB
    let batch = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      const res = await ZFRemote.rest('zf_kv?on_conflict=user_id,key&select=key,rev', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: batch
      });
      for (const r of res || []) S.meta[r.key] = r.rev;
      batch = [];
      size = 0;
    };
    for (const r of rows) {
      const sz = JSON.stringify(r.value).length;
      if (size + sz > 3e6) await flush();
      batch.push(r);
      size += sz;
    }
    await flush();
    Object.assign(S.hashes, newHashes);
    if (dels.length) {
      await ZFRemote.rest('zf_kv?key=in.' + inList(dels.map((id) => 'items#' + id)), { method: 'DELETE' }).catch(() => {});
      for (const id of dels) {
        delete S.hashes[id];
        delete S.meta['items#' + id];
      }
    }
    for (const k of keys) if (S.dirty[k] === snap[k]) delete S.dirty[k];
    sSave();
  }

  // ---------------------------------------------------------------- batida (a cada 5 s sincroniza, a cada 10 s vota)
  async function tabState() {
    if (!tabId) return null;
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'zf:hoststate' });
      if (r) lastTab = r;
      return r;
    } catch (e) {
      tabId = null;
      return null;
    }
  }
  async function handleRequest(req) {
    if (!req || !req.id || req.id === link.reqId) return false;
    link.reqId = req.id;
    link.code = null;
    link.err = null;
    if (!req.linkPhone) return false;
    if (!tabId) {
      link.err = 'WhatsApp Web não está aberto neste aparelho';
      return true;
    }
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'zf:linkcode', phone: String(req.linkPhone) });
      if (r && r.code) link.code = r.code;
      else link.err = (r && r.error) || 'não consegui gerar o código';
    } catch (e) {
      link.err = e.message;
    }
    link.at = Date.now();
    return true;
  }
  async function beat() {
    const st = await tabState();
    const t = st || { waReady: false, busy: false, state: 'closed', qr: null };
    const want = !!(st && t.waReady && S.ready);
    const info = {
      waReady: !!t.waReady,
      busy: !!t.busy,
      state: t.state,
      qr: t.state === 'qr' ? t.qr : null,
      linkFor: link.reqId,
      linkCode: link.code,
      linkErr: link.err,
      version,
      synced: S.ready
    };
    const was = current().ok;
    let res;
    try {
      res = await ZFRemote.rpc('zf_beat', { p_host: me.id, p_kind: me.kind, p_name: me.name, p_info: info, p_want: want });
    } catch (e) {
      if (current().ok !== was) broadcast();
      throw e;
    }
    lastBeatOk = Date.now();
    verdict = { cloud: !!(res && res.leader), until: Date.now() + VERDICT_MS };
    if (res && res.servers > 0 && !me.multi) {
      me.multi = true;
      chrome.storage.local.set({ zfMulti: true }).catch(() => {});
    }
    if (current().ok !== was || n % 3 === 0) broadcast();
    if (res && (await handleRequest(res.request))) return beat();
  }

  async function loop() {
    if (loopBusy || !ZFRemote.configured()) return;
    loopBusy = true;
    n++;
    try {
      await ident();
      await sLoad();
      const st = await ZFRemote.status();
      const before = logged;
      logged = !!st.logged;
      if (logged && !before) since = Date.now();
      if (!logged) {
        if (before) broadcast();
        return;
      }
      // a batida (quem está no comando) não pode depender da sincronização dar certo
      let syncErr = null;
      try {
        await pull(current().ok);
        await push();
      } catch (e) {
        syncErr = e;
      }
      if (n % 2 === 0 || !before) await beat();
      else if (current().ok !== lastOk) broadcast();
      lastOk = current().ok;
      if (syncErr) throw syncErr;
    } catch (e) {
      console.warn('[ZapFunil] aparelhos', e && e.message);
    } finally {
      loopBusy = false;
    }
  }
  setInterval(loop, 5000);
  setTimeout(loop, 1500);

  return {
    current,
    setTab,
    loop,
    info: () => ({ id: me.id, kind: me.kind, name: me.name }),
    _state: () => ({ me, verdict, S: { meta: S.meta, dirty: S.dirty, ready: S.ready }, tabId, lastTab, link })
  };
})();
