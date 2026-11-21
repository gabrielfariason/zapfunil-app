// ZapFunil – controle remoto (celular) via Supabase. Roda no service worker (background).
// Usa só a API REST do Supabase (sem bibliotecas). Os dados ficam no SEU projeto, protegidos por login (RLS).
/* global ZF_CONFIG */
const ZFRemote = (() => {
  const cfg = () => (typeof ZF_CONFIG !== 'undefined' ? ZF_CONFIG : { url: '', anonKey: '' });
  const configured = () => !!(cfg().url && cfg().anonKey);

  async function getSession() {
    const { remoteSession } = await chrome.storage.local.get('remoteSession');
    return remoteSession || null;
  }
  async function setSession(s) {
    if (s) await chrome.storage.local.set({ remoteSession: s });
    else await chrome.storage.local.remove('remoteSession');
  }
  function sessionFrom(json, email) {
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + (json.expires_in || 3600) * 1000,
      user_id: json.user && json.user.id,
      email: (json.user && json.user.email) || email
    };
  }

  async function auth(path, body) {
    const r = await fetch(cfg().url + '/auth/v1/' + path, {
      method: 'POST',
      headers: { apikey: cfg().anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.msg || j.error_description || j.message || 'Erro de login (' + r.status + ')');
    return j;
  }

  async function login(email, password) {
    const j = await auth('token?grant_type=password', { email, password });
    const s = sessionFrom(j, email);
    await setSession(s);
    return { email: s.email };
  }
  async function signup(email, password) {
    const j = await auth('signup', { email, password });
    if (j.access_token) {
      await setSession(sessionFrom(j, email));
      return { email, confirmed: true };
    }
    return { email, confirmed: false };
  }
  async function logout() {
    await setSession(null);
  }

  let refreshing = null;
  async function token() {
    let s = await getSession();
    if (!s) throw new Error('not_logged');
    if (Date.now() < s.expires_at - 60000) return s.access_token;
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const j = await auth('token?grant_type=refresh_token', { refresh_token: s.refresh_token });
          const n = sessionFrom(j, s.email);
          await setSession(n);
          return n.access_token;
        } catch (e) {
          if (/invalid|not found|revoked/i.test(e.message)) await setSession(null);
          throw e;
        } finally {
          setTimeout(() => (refreshing = null), 0);
        }
      })();
    }
    return refreshing;
  }

  async function rest(path, opts) {
    opts = opts || {};
    const t = await token();
    const r = await fetch(cfg().url + '/rest/v1/' + path, {
      method: opts.method || 'GET',
      headers: Object.assign({ apikey: cfg().anonKey, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error('Supabase ' + r.status + ': ' + txt.slice(0, 200));
    }
    if (r.status === 204) return null;
    const txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  }

  // Pega comandos pendentes e marca como "running" (só quem marcou executa)
  async function claim() {
    const pend = await rest('zf_commands?status=eq.pending&order=id.asc&limit=10&select=id');
    if (!pend || !pend.length) return [];
    const ids = pend.map((p) => p.id).join(',');
    const rows = await rest('zf_commands?id=in.(' + ids + ')&status=eq.pending', {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: { status: 'running', started_at: new Date().toISOString() }
    });
    return rows || [];
  }
  async function finish(id, ok, result) {
    await rest('zf_commands?id=eq.' + Number(id), {
      method: 'PATCH',
      body: { status: ok ? 'done' : 'error', result: String(result || '').slice(0, 500), done_at: new Date().toISOString() }
    });
  }
  // devolve para a fila (a aba não pôde executar agora)
  async function release(id) {
    await rest('zf_commands?id=eq.' + Number(id) + '&status=eq.running', { method: 'PATCH', body: { status: 'pending', started_at: null } });
  }
  async function publish(data) {
    const s = await getSession();
    if (!s) return;
    await rest('zf_state?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { user_id: s.user_id, data, updated_at: new Date().toISOString() }
    });
  }

  async function publishChat(chatId, data) {
    const s = await getSession();
    if (!s) return;
    await rest('zf_chats?on_conflict=user_id,chat_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { user_id: s.user_id, chat_id: chatId, data, updated_at: new Date().toISOString() }
    });
  }

  // Áudio gravado no celular (pasta privada zf-audio/<usuario>/...)
  async function audioGet(path) {
    const t = await token();
    const r = await fetch(cfg().url + '/storage/v1/object/authenticated/zf-audio/' + path.split('/').map(encodeURIComponent).join('/'), { headers: { apikey: cfg().anonKey, Authorization: 'Bearer ' + t } });
    if (!r.ok) throw new Error('Não consegui baixar o áudio do celular (' + r.status + ')');
    const blob = await r.blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return 'data:' + (blob.type || 'audio/mpeg') + ';base64,' + btoa(bin);
  }
  async function audioDel(path) {
    const t = await token();
    await fetch(cfg().url + '/storage/v1/object/zf-audio', {
      method: 'DELETE',
      headers: { apikey: cfg().anonKey, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [path] })
    }).catch(() => {});
  }
  // Notificação no iPhone (função zf-push no Supabase)
  async function notify(payload) {
    const s = await getSession();
    if (!s) return { sent: 0 };
    const t = await token();
    const r = await fetch(cfg().url + '/functions/v1/zf-push', {
      method: 'POST',
      headers: { apikey: cfg().anonKey, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: 'notify' }, payload))
    });
    return r.json().catch(() => ({}));
  }

  async function status() {
    const s = await getSession();
    return { configured: configured(), logged: !!s, email: s && s.email, appUrl: cfg().appUrl || '' };
  }

  // Chama uma função do banco (rpc)
  async function rpc(name, args) {
    return rest('rpc/' + name, { method: 'POST', body: args || {} });
  }
  // Sessão vinda do pareamento do servidor (sem senha)
  async function adopt(json) {
    await setSession(sessionFrom(json, json.user && json.user.email));
  }
  return { configured, login, signup, logout, claim, finish, release, publish, publishChat, audioGet, audioDel, notify, status, rest, rpc, adopt, getSession };
})();
