// ZapFunil – content script (painel flutuante + motor de envio, gatilhos, agendamentos e campanhas)
(() => {
  'use strict';
  if (window.__zapfunilLoaded) return;
  window.__zapfunilLoaded = true;

  const TAG = 'ZAPFUNIL';
  const TAB_TOKEN = ZF.uid();
  // Relógio: o Chrome deixa os timers lentos em abas escondidas (até 1x por minuto).
  // O background manda um "tick" por segundo e acorda esperas e tarefas atrasadas.
  const sleepers = new Set();
  const sleep = (ms) =>
    new Promise((r) => {
      const sl = { at: Date.now() + ms, r };
      sleepers.add(sl);
      setTimeout(() => {
        if (sleepers.delete(sl)) r();
      }, ms);
    });
  const periodic = [];
  function every(fn, ms) {
    const t = { fn, ms, last: Date.now(), busy: false };
    periodic.push(t);
    setInterval(() => runPeriodic(t), ms);
  }
  function runPeriodic(t) {
    if (t.busy) return;
    t.last = Date.now();
    t.busy = true;
    Promise.resolve()
      .then(t.fn)
      .catch(() => {})
      .finally(() => (t.busy = false));
  }
  function clockTick() {
    const now = Date.now();
    for (const sl of sleepers) {
      if (sl.at <= now) {
        sleepers.delete(sl);
        sl.r();
      }
    }
    for (const t of periodic) if (now - t.last >= t.ms) runPeriodic(t);
  }

  // ---------------------------------------------------------------- ponte com a página
  let reqSeq = 0;
  const pending = new Map();
  let waReady = false;

  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = TAB_TOKEN + '-' + ++reqSeq;
      const timeoutMs = method === 'ready' ? 10 * 60 * 1000 : 180 * 1000;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Tempo esgotado em ' + method));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ __zf: TAG, dir: 'toPage', id, method, args }, '*');
    });
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.__zf !== TAG || d.dir !== 'toContent') return;
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.error) p.reject(new Error(d.error));
      else p.resolve(d.result);
      return;
    }
    if (d.event === 'ready') {
      waReady = true;
      updateStatus();
    }
    if (d.event === 'message') onIncoming(d.data);
    if (d.event === 'logout') notifyPhone('error', '⚠️ WhatsApp Web desconectou', 'Abra o WhatsApp Web no Mac e escaneie o QR code de novo. Enquanto isso nada é enviado.', { tag: 'zf-logout' });
  });

  // ---------------------------------------------------------------- dados
  let DB = null;
  async function reload() {
    DB = await ZF.load();
    renderList();
    if (typeof ensureBar === 'function') ensureBar();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!DB) return;
    let rerender = false;
    for (const k of Object.keys(changes)) {
      if (k === 'engineLock') continue;
      if (k === 'settings') {
        DB.settings = Object.assign({}, ZF.DEFAULT_SETTINGS, changes[k].newValue || {});
        updateStatus();
      }
      else if (ZF.KEYS.includes(k)) DB[k] = changes[k].newValue || (ZF.OBJ_KEYS.includes(k) ? {} : []);
      if (k === 'items' || k === 'funnels' || k === 'remarketing') rerender = true;
      if ((k === 'items' || k === 'funnels') && typeof ensureBar === 'function') setTimeout(ensureBar, 0);
    }
    if (rerender) renderList();
  });

  // Atualização segura de um array no storage (lê o mais recente antes de gravar)
  const locks = {};
  function mutate(key, fn) {
    const job = (locks[key] || Promise.resolve()).catch(() => {}).then(async () => {
      const data = await chrome.storage.local.get(key);
      const cur = data[key] || (ZF.OBJ_KEYS.includes(key) ? {} : []);
      const next = fn(cur) || cur;
      await chrome.storage.local.set({ [key]: next });
      if (DB) DB[key] = next;
      return next;
    });
    locks[key] = job;
    return job;
  }

  async function logHistory(entry) {
    entry.t = Date.now();
    await mutate('history', (h) => {
      h.unshift(entry);
      return h.slice(0, 500);
    });
  }

  // ---------------------------------------------------------------- liderança (só uma aba roda o motor)
  // isLeader = esta aba lidera neste navegador (localLeader) E este aparelho está no comando
  // (Mac x servidor 24h – decidido no background). Sem servidor, cloud fica sempre liberado.
  let isLeader = false;
  let localLeader = false;
  let cloud = { ok: false, until: 1 }; // até o background responder, não assume nada
  let initDone = false;
  function refreshLeader() {
    const was = isLeader;
    const cloudOk = cloud.ok && (cloud.until === 0 || Date.now() < cloud.until);
    isLeader = localLeader && cloudOk;
    if (was !== isLeader) {
      updateStatus();
      // assumiu o comando agora (ex.: o outro aparelho caiu): destrava o que ficou pela metade
      if (isLeader && initDone) {
        recoverSchedules().catch(() => {});
        rmktRecover().catch(() => {});
      }
    }
  }
  function setCloud(v) {
    if (!v || typeof v.ok !== 'boolean') return;
    cloud = { ok: v.ok, until: Number(v.until) || 0 };
    refreshLeader();
  }
  async function heartbeat() {
    try {
      const { engineLock } = await chrome.storage.local.get('engineLock');
      const now = Date.now();
      if (!engineLock || engineLock.token === TAB_TOKEN || now - engineLock.ts > 25000) {
        await chrome.storage.local.set({ engineLock: { token: TAB_TOKEN, ts: now } });
        localLeader = true;
      } else {
        localLeader = false;
      }
    } catch (e) {
      // contexto da extensão invalidado (extensão recarregada) – para tudo
      localLeader = false;
    }
    refreshLeader();
    updateStatus();
    try {
      const res = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 3000);
        chrome.runtime.sendMessage({ type: 'zf:leader', leader: localLeader }, (r) => {
          void chrome.runtime.lastError;
          clearTimeout(t);
          resolve(r || null);
        });
      });
      if (res) setCloud(res);
    } catch (e) {}
  }
  window.addEventListener('beforeunload', async () => {
    try {
      const { engineLock } = await chrome.storage.local.get('engineLock');
      if (engineLock && engineLock.token === TAB_TOKEN) await chrome.storage.local.remove('engineLock');
    } catch (e) {}
  });

  // ---------------------------------------------------------------- envio
  const running = new Map(); // chatId -> { cancelled, label, step, total, name }
  const lastBotSend = new Map(); // chatId -> timestamp do último envio feito pela extensão
  const markBot = (chatId) => lastBotSend.set(chatId, Date.now());
  const isBotEcho = (chatId) => running.has(chatId) || Date.now() - (lastBotSend.get(chatId) || 0) < 6000;
  const replyWaiters = new Map(); // chatId -> [resolve]

  class Cancelled extends Error {}

  async function wait(ms, run) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (run && run.cancelled) throw new Cancelled('Cancelado');
      await sleep(Math.min(500, end - Date.now()));
    }
    if (run && run.cancelled) throw new Cancelled('Cancelado');
  }

  async function waitForReply(chatId, timeoutMs, run) {
    let replied = false;
    const onReply = () => (replied = true);
    const arr = replyWaiters.get(chatId) || [];
    arr.push(onReply);
    replyWaiters.set(chatId, arr);
    const start = Date.now();
    try {
      while (!replied) {
        if (run && run.cancelled) throw new Cancelled('Cancelado');
        if (timeoutMs > 0 && Date.now() - start > timeoutMs) return false;
        await sleep(500);
      }
      return true;
    } finally {
      replyWaiters.set(chatId, (replyWaiters.get(chatId) || []).filter((f) => f !== onReply));
    }
  }

  function getItem(id) {
    return DB.items.find((i) => i.id === id);
  }
  function getFunnel(id) {
    return DB.funnels.find((f) => f.id === id);
  }

  async function sendItem(chatId, item, ctx, run, opts) {
    opts = opts || {};
    const s = DB.settings;
    const simulate = opts.simulate !== false;
    if (item.type === 'text') {
      const text = ZF.applyVars(item.text, ctx);
      if (!text.trim()) return;
      if (simulate) {
        const secs = Math.min(s.typingMax, Math.max(s.typingMin, text.length / Math.max(1, s.typingCps)));
        await call('typing', chatId, Math.round(secs * 1000));
        await wait(secs * 1000, run);
      }
      markBot(chatId);
      await call('sendText', chatId, text);
      markBot(chatId);
    } else if (item.type === 'audio') {
      if (simulate) {
        const secs = Math.min(s.recordingMax, Math.max(2, (item.duration || 5) * s.recordingFactor));
        await call('recording', chatId, Math.round(secs * 1000));
        await wait(secs * 1000, run);
      }
      markBot(chatId);
      await call('sendFile', chatId, item.data, {
        type: 'audio',
        isPtt: item.asFile ? false : true,
        mimetype: item.mime || undefined,
        filename: item.filename || undefined
      });
    } else {
      if (simulate) {
        await call('typing', chatId, 1500);
        await wait(1500, run);
      }
      const o = { type: item.type, caption: ZF.applyVars(item.caption || '', ctx) || undefined };
      if (item.mime) o.mimetype = item.mime;
      if (item.filename) o.filename = item.filename;
      if (item.type === 'image' || item.type === 'video') {
        if (item.viewOnce) o.isViewOnce = true;
      }
      markBot(chatId);
      await call('sendFile', chatId, item.data, o);
    }
    markBot(chatId);
    try { await call('paused', chatId); } catch (e) {}
  }

  // Executa um funil (ou um item solto) num chat. Retorna quando termina.
  // Fila de envios: cada conversa tem sua fila; conversas diferentes rodam ao mesmo tempo.
  const queues = new Map(); // chatId -> [job]
  function runFunnel(chatId, funnel, ctx, source) {
    return new Promise((resolve, reject) => {
      const job = { id: ZF.uid(), chatId, funnel, ctx, source, resolve, reject, name: ctx.name || chatId.replace(/@.*/, '') };
      if (!running.has(chatId)) startJob(job);
      else {
        const q = queues.get(chatId) || [];
        q.push(job);
        queues.set(chatId, q);
        renderRunning();
      }
    });
  }
  async function startJob(job) {
    try {
      job.resolve(await execFunnel(job.chatId, job.funnel, job.ctx, job.source));
    } catch (e) {
      job.reject(e);
    } finally {
      const q = queues.get(job.chatId) || [];
      const next = q.shift();
      if (!q.length) queues.delete(job.chatId);
      renderRunning();
      if (next) startJob(next);
    }
  }
  function removeQueued(chatId, jobId) {
    const q = queues.get(chatId) || [];
    const i = q.findIndex((j) => j.id === jobId);
    if (i >= 0) {
      const [j] = q.splice(i, 1);
      j.resolve(false);
      if (!q.length) queues.delete(chatId);
      renderRunning();
    }
  }
  function stopChat(chatId) {
    const q = queues.get(chatId) || [];
    queues.delete(chatId);
    q.forEach((j) => j.resolve(false));
    const r = running.get(chatId);
    if (r) r.cancelled = true;
    renderRunning();
  }

  async function execFunnel(chatId, funnel, ctx, source) {
    const isRmkt = /^remarketing/.test(source || '');
    if (!isRmkt) rmktOnOtherFunnel(chatId, funnelKey(funnel)).catch(() => {});
    const run = { cancelled: false, label: funnel.name, step: 0, total: funnel.steps.length, name: ctx.name || chatId.replace(/@.*/, '') };
    running.set(chatId, run);
    renderRunning();
    let ok = true;
    let err = '';
    try {
      for (let i = 0; i < funnel.steps.length; i++) {
        const st = funnel.steps[i];
        run.step = i + 1;
        renderRunning();
        if (st.kind === 'wait_reply') {
          const got = await waitForReply(chatId, (st.timeoutMin || 0) * 60000, run);
          if (!got && st.onTimeout === 'stop') break;
          continue;
        }
        const delay = Math.max(0, Number(st.delay) || 0);
        if (delay) await wait(delay * 1000, run);
        const item = getItem(st.itemId);
        if (!item) continue; // item apagado – pula
        await sendItem(chatId, item, ctx, run, { simulate: st.simulate !== false });
      }
    } catch (e) {
      if (e instanceof Cancelled) {
        ok = false;
        err = 'Cancelado';
      } else {
        ok = false;
        err = e.message || String(e);
      }
    } finally {
      markBot(chatId);
      if (running.get(chatId) === run) running.delete(chatId);
      renderRunning();
    }
    if (ok && !isRmkt) rmktEnqueue(chatId, funnelKey(funnel), ctx).catch((e) => console.warn('[ZapFunil] rmkt', e));
    logHistory({ chatId, name: ctx.name || '', what: funnel.name, source: source || 'manual', ok, err });
    if (!ok && err !== 'Cancelado') notifyPhone('error', '❌ Falha ao enviar', funnel.name + ' → ' + (ctx.name || chatId.replace(/@.*/, '')) + ': ' + err, { tag: 'err-' + chatId, url: './#c=' + encodeURIComponent(chatId) });
    if (!ok && err !== 'Cancelado') throw new Error(err);
    return ok;
  }

  function funnelFromItem(item) {
    return { id: 'item-' + item.id, name: item.name, steps: [{ itemId: item.id, delay: 0, simulate: true }] };
  }

  function targetToFunnel(targetType, targetId) {
    if (targetType === 'item') {
      const it = getItem(targetId);
      return it ? funnelFromItem(it) : null;
    }
    return getFunnel(targetId) || null;
  }

  // ---------------------------------------------------------------- gatilhos
  const autoOn = () => DB && !DB.settings.automationsPaused;
  async function onIncoming(m) {
    if (!DB) return;
    if (watched.size) chatChanged(m.chatId);
    // libera funis aguardando resposta
    if (!m.fromMe) {
      const waiters = replyWaiters.get(m.chatId);
      if (waiters && waiters.length) waiters.slice().forEach((f) => f());
    }
    if (isLeader) {
      try {
        // respostas sempre contam para cancelar remarketing, mesmo com automações pausadas
        await rmktOnMessage(m);
      } catch (e) {
        console.warn('[ZapFunil] rmkt msg', e);
      }
    }
    if (isLeader && !m.fromMe && !m.isGroup && m.type !== 'e2e_notification' && m.type !== 'notification_template' && (!m.t || Date.now() / 1000 - m.t < 180)) {
      const who = m.name && /[\p{L}\d]/u.test(m.name) ? m.name : '+' + m.chatId.replace(/@.*/, '');
      call('unreadTotal').catch(() => undefined).then((badge) => {
        notifyPhone('msg', who, m.type === 'chat' ? m.body : m.preview || 'Nova mensagem', { tag: 'chat-' + m.chatId, url: './#c=' + encodeURIComponent(m.chatId), badge });
      });
    }
    if (!isLeader || m.fromMe || !autoOn()) return;
    const triggers = DB.triggers.filter((t) => t.enabled);
    if (!triggers.length) return;
    for (const t of triggers) {
      if (m.isGroup && t.ignoreGroups !== false) continue;
      if (t.onlyText !== false && m.type !== 'chat' && t.match !== 'any') continue;
      if (!ZF.matchTrigger(t, m.body)) continue;
      const key = m.chatId + '|' + t.id;
      const last = DB.triggerLog[key];
      if (t.once && last) continue;
      if (!t.once && t.cooldownHours && last && Date.now() - last < t.cooldownHours * 3600000) continue;
      if (running.has(m.chatId)) continue;
      const funnel = targetToFunnel(t.targetType || 'funnel', t.targetId || t.funnelId);
      if (!funnel) continue;
      await mutate('triggerLog', (log) => {
        log[key] = Date.now();
        return log;
      });
      const delay = Math.max(0, Number(t.delay) || 0);
      (async () => {
        try {
          if (delay) await sleep(delay * 1000);
          await runFunnel(m.chatId, funnel, { name: m.name, number: m.chatId }, 'gatilho: ' + (t.name || t.keywords.join(', ')));
        } catch (e) {
          console.warn('[ZapFunil] gatilho falhou', e);
        }
      })();
      break; // só um gatilho por mensagem
    }
  }

  // ---------------------------------------------------------------- agendamentos
  let schedulerBusy = false;
  async function schedulerTick() {
    if (!isLeader || !waReady || schedulerBusy || !autoOn()) return;
    schedulerBusy = true;
    try {
      const now = Date.now();
      const due = DB.schedules.filter((s) => s.status === 'pending' && s.at <= now);
      for (const s of due) {
        await mutate('schedules', (arr) => arr.map((x) => (x.id === s.id ? Object.assign({}, x, { status: 'running' }) : x)));
        const funnel = targetToFunnel(s.targetType, s.targetId);
        const errors = [];
        if (!funnel) errors.push('Funil/item não encontrado');
        else {
          // envia em sequência para não sobrecarregar
          for (const num of s.numbers || []) {
            try {
              const r = await call('resolve', num);
              await runFunnel(r.id, funnel, { name: s.useName || r.name, number: r.id }, 'agendamento');
            } catch (e) {
              errors.push(num + ': ' + e.message);
            }
            if ((s.numbers || []).length > 1) await sleep(rand(4, 9) * 1000);
          }
        }
        if (errors.length) notifyPhone('error', '❌ Agendamento com erro', errors.join(' | ').slice(0, 200), { tag: 'sch-' + s.id });
        await mutate('schedules', (arr) =>
          arr.map((x) => {
            if (x.id !== s.id) return x;
            const n = Object.assign({}, x, { lastRun: Date.now(), lastError: errors.join(' | ') });
            if (x.repeat === 'daily' || x.repeat === 'weekly') {
              const step = x.repeat === 'daily' ? 86400000 : 7 * 86400000;
              let next = x.at;
              while (next <= Date.now()) next += step;
              n.at = next;
              n.status = 'pending';
            } else {
              n.status = errors.length ? 'error' : 'done';
            }
            return n;
          })
        );
      }
    } catch (e) {
      console.warn('[ZapFunil] agendador', e);
    } finally {
      schedulerBusy = false;
    }
  }

  // Ao abrir, agendamentos que ficaram "running" (aba fechada no meio) voltam para pendente
  async function recoverSchedules() {
    await mutate('schedules', (arr) => arr.map((x) => (x.status === 'running' ? Object.assign({}, x, { status: 'pending' }) : x)));
  }

  // ---------------------------------------------------------------- campanhas (disparo em massa)
  let campaignBusy = false;
  function rand(min, max) {
    min = Number(min) || 0;
    max = Math.max(min, Number(max) || min);
    return min + Math.random() * (max - min);
  }
  async function campaignTick() {
    if (!isLeader || !waReady || campaignBusy || !autoOn()) return;
    const camp = DB.campaigns.find((c) => c.status === 'running');
    if (!camp) return;
    campaignBusy = true;
    try {
      await processCampaign(camp.id);
    } catch (e) {
      console.warn('[ZapFunil] campanha', e);
    } finally {
      campaignBusy = false;
    }
  }

  async function getCampaign(id) {
    const { campaigns } = await chrome.storage.local.get('campaigns');
    return (campaigns || []).find((c) => c.id === id);
  }

  async function processCampaign(id) {
    let camp = await getCampaign(id);
    if (!camp) return;
    const funnel = targetToFunnel(camp.targetType || 'funnel', camp.targetId || camp.funnelId);
    if (!funnel) {
      await mutate('campaigns', (arr) => arr.map((c) => (c.id === id ? Object.assign({}, c, { status: 'error', lastError: 'Funil/item não encontrado' }) : c)));
      return;
    }
    let sentSincePause = 0;
    while (true) {
      camp = await getCampaign(id);
      if (!camp || camp.status !== 'running' || !isLeader || !autoOn()) return;
      const idx = camp.progress || 0;
      if (idx >= camp.contacts.length) {
        await mutate('campaigns', (arr) => arr.map((c) => (c.id === id ? Object.assign({}, c, { status: 'done', finishedAt: Date.now() }) : c)));
        notifyPhone('info', '🚀 Campanha concluída', camp.name + ': ' + (camp.sent || 0) + ' enviados, ' + (camp.failed || 0) + ' falhas', { tag: 'camp-' + id });
        return;
      }
      const contact = camp.contacts[idx];
      const result = { number: contact.number, name: contact.name || '', ok: false, err: '', t: Date.now() };
      try {
        const r = await call('resolve', contact.number);
        await runFunnel(r.id, funnel, { name: contact.name || r.name, number: r.id }, 'campanha: ' + camp.name);
        result.ok = true;
      } catch (e) {
        result.err = e.message || String(e);
      }
      await mutate('campaigns', (arr) =>
        arr.map((c) => {
          if (c.id !== id) return c;
          const results = (c.results || []).concat([result]);
          return Object.assign({}, c, {
            progress: idx + 1,
            results,
            sent: results.filter((x) => x.ok).length,
            failed: results.filter((x) => !x.ok).length
          });
        })
      );
      sentSincePause++;
      const left = camp.contacts.length - (idx + 1);
      if (!left) continue;
      // pausa longa a cada N envios
      let ms;
      if (camp.pauseEvery && sentSincePause >= camp.pauseEvery) {
        sentSincePause = 0;
        ms = (Number(camp.pauseMinutes) || 5) * 60000;
      } else {
        ms = rand(camp.minDelay, camp.maxDelay) * 1000;
      }
      await mutate('campaigns', (arr) => arr.map((c) => (c.id === id ? Object.assign({}, c, { nextAt: Date.now() + ms }) : c)));
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await sleep(1000);
        const c = await getCampaign(id);
        if (!c || c.status !== 'running' || !autoOn()) return;
      }
    }
  }


  // ---------------------------------------------------------------- NOTIFICAÇÕES NO IPHONE
  function notifyPhone(kind, title, body, extra) {
    if (!isLeader) return;
    try {
      chrome.runtime.sendMessage({ type: 'remote:notify', payload: Object.assign({ kind, title, body }, extra || {}) }, () => void chrome.runtime.lastError);
    } catch (e) {}
  }

  // ---------------------------------------------------------------- REMARKETING
  // Fila salva em storage (rmktQueue). Cada entrada = 1 contato numa regra de remarketing.
  // status: waiting | sending | done | replied | cancelled | error | expired
  function funnelKey(funnel) {
    return String(funnel.id).startsWith('item-') ? 'item:' + funnel.id.slice(5) : 'funnel:' + funnel.id;
  }
  function getRule(id) {
    return (DB.remarketing || []).find((r) => r.id === id);
  }
  function stageDueAt(rule, entry) {
    const st = rule.stages[entry.stageIdx];
    if (!st) return null;
    if (entry.mode === 'inactive' && !entry.lastFromMe) return null; // aguardando você responder
    return entry.baseAt + (Number(st.delay) || 0) * 1000;
  }
  const ACTIVE = (e) => e.status === 'waiting' || e.status === 'sending';

  async function rmktEnqueue(chatId, key, ctx, onlyRuleId) {
    const rules = (DB.remarketing || []).filter((r) => (onlyRuleId ? r.id === onlyRuleId : r.enabled && (r.triggers || []).includes(key)) && r.stages && r.stages.length);
    if (!rules.length) return 0;
    if (/@g\.us$/.test(chatId)) return 0;
    if ((DB.rmktBlock || {})[chatId]) return 0;
    const now = Date.now();
    await mutate('rmktQueue', (q) => {
      for (const rule of rules) {
        q.forEach((e) => {
          if (e.chatId === chatId && e.ruleId === rule.id && ACTIVE(e)) {
            e.status = 'cancelled';
            e.reason = 'reiniciado';
            e.endedAt = now;
          }
        });
        const entry = { id: ZF.uid(), chatId, name: ctx.name || '', ruleId: rule.id, mode: rule.mode || 'no_reply', stageIdx: 0, baseAt: now, lastFromMe: true, status: 'waiting', attempts: 0, createdAt: now, sent: [] };
        entry.dueAt = stageDueAt(rule, entry);
        q.push(entry);
      }
      // limpeza: remove finalizados com +30 dias e limita tamanho
      const cutoff = now - 30 * 86400000;
      q = q.filter((e) => ACTIVE(e) || (e.endedAt || e.createdAt) > cutoff);
      if (q.length > 5000) q = q.filter(ACTIVE).concat(q.filter((e) => !ACTIVE(e)).slice(-3000));
      return q;
    });
    return rules.length;
  }

  async function rmktOnOtherFunnel(chatId, key) {
    if (!(DB.rmktQueue || []).some((e) => e.chatId === chatId && ACTIVE(e))) return;
    await mutate('rmktQueue', (q) =>
      q.map((e) => {
        if (e.chatId !== chatId || e.status !== 'waiting') return e;
        const rule = getRule(e.ruleId);
        if (!rule || rule.stopOnOtherFunnel === false) return e;
        if ((rule.triggers || []).includes(key)) return e; // mesmo funil -> o enqueue reinicia
        return Object.assign({}, e, { status: 'cancelled', reason: 'outro funil enviado', endedAt: Date.now() });
      })
    );
  }

  async function rmktOnMessage(m) {
    if (m.isGroup) return;
    const now = Date.now();
    // descadastro: lead pediu para parar
    if (!m.fromMe && ZF.isOptOut(m.body, DB.settings.optOutWords)) {
      await mutate('rmktBlock', (b) => {
        b[m.chatId] = now;
        return b;
      });
      await mutate('rmktQueue', (q) => q.map((e) => (e.chatId === m.chatId && ACTIVE(e) ? Object.assign({}, e, { status: 'cancelled', reason: 'lead pediu para parar', endedAt: now }) : e)));
      return;
    }
    if (!(DB.rmktQueue || []).some((e) => e.chatId === m.chatId && ACTIVE(e))) return;
    const ownEcho = m.fromMe && isBotEcho(m.chatId);
    if (ownEcho) return; // mensagem enviada pela própria extensão
    await mutate('rmktQueue', (q) =>
      q.map((e) => {
        if (e.chatId !== m.chatId || !ACTIVE(e)) return e;
        const rule = getRule(e.ruleId);
        if (!rule) return e;
        // chegou mensagem enquanto uma etapa estava sendo enviada: guarda para aplicar logo depois
        if (e.status === 'sending') return Object.assign({}, e, { midMsgs: (e.midMsgs || []).concat([{ fromMe: !!m.fromMe, t: now }]) });
        return applyMsg(rule, e, !!m.fromMe, now);
      })
    );
  }

  function applyMsg(rule, e, fromMe, now) {
        const n = Object.assign({}, e);
        if (e.mode === 'inactive') {
          // conversa parada: qualquer mensagem reinicia o relógio
          n.baseAt = now;
          n.lastFromMe = fromMe;
          if (!fromMe && rule.restartOnReply !== false) n.stageIdx = 0;
          n.dueAt = stageDueAt(rule, n);
          return n;
        }
        // não respondeu
        if (!fromMe) return Object.assign(n, { status: 'replied', reason: 'lead respondeu', endedAt: now, dueAt: null });
        if (rule.stopOnManual !== false) return Object.assign(n, { status: 'cancelled', reason: 'você respondeu manualmente', endedAt: now, dueAt: null });
        return e;
  }

  let rmktBusy = false;
  async function rmktTick() {
    if (!isLeader || !waReady || rmktBusy || !autoOn()) return;
    const now = Date.now();
    const due = (DB.rmktQueue || []).filter((e) => e.status === 'waiting' && e.dueAt && e.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
    if (!due.length) return;
    rmktBusy = true;
    try {
      let sentCount = 0;
      for (const e0 of due) {
        if (!isLeader) break;
        const fresh = (DB.rmktQueue || []).find((x) => x.id === e0.id);
        if (!fresh || fresh.status !== 'waiting' || !fresh.dueAt || fresh.dueAt > Date.now()) continue;
        const rule = getRule(fresh.ruleId);
        // só altera se o status ainda for o esperado (uma resposta pode ter chegado no meio)
        const patch = (fn, expect) => mutate('rmktQueue', (q) => q.map((x) => (x.id === fresh.id && x.status === (expect || 'waiting') ? Object.assign({}, x, fn(x)) : x)));
        if (!rule) {
          await patch(() => ({ status: 'cancelled', reason: 'regra apagada', endedAt: Date.now() }));
          continue;
        }
        if (!rule.enabled) continue; // regra pausada: segura até reativar
        if ((DB.rmktBlock || {})[fresh.chatId]) {
          await patch(() => ({ status: 'cancelled', reason: 'contato bloqueado', endedAt: Date.now() }));
          continue;
        }
        const allowed = ZF.nextAllowed(Date.now(), rule.window);
        if (allowed > Date.now() + 1000) {
          await patch(() => ({ dueAt: allowed }));
          continue;
        }
        if (rule.maxLateHours > 0 && Date.now() - fresh.dueAt > rule.maxLateHours * 3600000 && fresh.dueAt >= ZF.nextAllowed(fresh.dueAt, rule.window)) {
          await patch(() => ({ status: 'expired', reason: 'atrasou mais de ' + rule.maxLateHours + 'h (WhatsApp fechado)', endedAt: Date.now() }));
          continue;
        }
        if (running.has(fresh.chatId)) continue; // tem funil rodando nesse chat, tenta no próximo ciclo
        const st = rule.stages[fresh.stageIdx];
        const funnel = st && targetToFunnel(st.targetType, st.targetId);
        if (!funnel) {
          // etapa sem conteúdo (apagado): pula para a próxima
          await patch((x) => advance(rule, x, Date.now(), 'conteúdo apagado'));
          continue;
        }
        if (sentCount > 0) await sleep(4000 + Math.random() * 6000); // espaça envios entre contatos
        const q2 = await patch(() => ({ status: 'sending' }));
        const claimed = q2.find((x) => x.id === fresh.id);
        if (!claimed || claimed.status !== 'sending') continue; // respondeu/cancelou durante a espera
        try {
          await runFunnel(fresh.chatId, funnel, { name: fresh.name, number: fresh.chatId }, 'remarketing: ' + rule.name + ' (' + (fresh.stageIdx + 1) + '/' + rule.stages.length + ')');
          sentCount++;
          await patch((x) => advance(rule, x, Date.now()), 'sending');
        } catch (err) {
          const attempts = (fresh.attempts || 0) + 1;
          await patch(() =>
            attempts < 3
              ? { status: 'waiting', attempts, dueAt: Date.now() + 5 * 60000, lastError: err.message }
              : { status: 'error', attempts, lastError: err.message, reason: 'falhou 3x: ' + err.message, endedAt: Date.now() },
            'sending'
          );
          if (attempts >= 3) notifyPhone('error', '❌ Remarketing falhou', rule.name + ' → ' + (fresh.name || fresh.chatId.replace(/@.*/, '')) + ': ' + err.message, { tag: 'rmkt-' + fresh.id });
        }
      }
    } finally {
      rmktBusy = false;
    }
  }

  function advance(rule, x, now, note) {
    const sent = (x.sent || []).concat([{ stage: x.stageIdx, t: now, note: note || '' }]);
    let out = Object.assign({}, x, { sent, attempts: 0, lastError: '', stageIdx: x.stageIdx + 1, baseAt: now, lastFromMe: true, status: 'waiting', midMsgs: [] });
    // mensagens que chegaram enquanto a etapa era enviada contam como "depois do envio"
    for (const mm of x.midMsgs || []) {
      if (out.status !== 'waiting') break;
      out = applyMsg(rule, out, mm.fromMe, Math.max(mm.t, now));
    }
    if (out.status !== 'waiting') return out;
    if (out.stageIdx >= rule.stages.length) return Object.assign(out, { status: 'done', reason: 'sequência concluída', dueAt: null, endedAt: now });
    out.dueAt = stageDueAt(rule, out);
    return out;
  }

  async function rmktRecover() {
    await mutate('rmktQueue', (q) => q.map((e) => (e.status === 'sending' ? Object.assign({}, e, { status: 'waiting' }) : e)));
  }

  async function rmktStopChat(chatId) {
    let n = 0;
    await mutate('rmktQueue', (q) =>
      q.map((e) => {
        if (e.chatId !== chatId || !ACTIVE(e)) return e;
        n++;
        return Object.assign({}, e, { status: 'cancelled', reason: 'parado manualmente', endedAt: Date.now() });
      })
    );
    return n;
  }

  // ---------------------------------------------------------------- UI: painel flutuante
  let root, listEl, runEl, statusDot, searchEl;
  let activeTab = 'all';

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
      }
    }
    (children || []).forEach((c) => c && e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return e;
  }

  function toast(msg, kind) {
    const t = el('div', { class: 'zf-toast zf-toast-' + (kind || 'info'), text: msg });
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('zf-show'), 10);
    setTimeout(() => {
      t.classList.remove('zf-show');
      setTimeout(() => t.remove(), 300);
    }, 3200);
  }

  function buildUI() {
    root = el('div', { class: 'zf-root', id: 'zapfunil-root' });
    const fab = el('button', { class: 'zf-fab', title: 'ZapFunil', onclick: togglePanel }, ['⚡']);
    statusDot = el('span', { class: 'zf-dot' });
    fab.appendChild(statusDot);

    const tabs = [
      ['all', 'Tudo'],
      ['text', '💬'],
      ['audio', '🎤'],
      ['media', '🖼️'],
      ['document', '📄'],
      ['funnel', '🔁 Funis'],
      ['rmkt', '🔔 Rmkt']
    ];
    const tabBar = el('div', { class: 'zf-tabs' });
    tabs.forEach(([k, label]) => {
      const b = el('button', { class: 'zf-tab' + (k === activeTab ? ' zf-on' : ''), 'data-k': k, onclick: () => {
        activeTab = k;
        tabBar.querySelectorAll('.zf-tab').forEach((x) => x.classList.toggle('zf-on', x.dataset.k === k));
        renderList();
      } }, [label]);
      tabBar.appendChild(b);
    });

    searchEl = el('input', { class: 'zf-search', placeholder: 'Buscar ou /atalho…', oninput: renderList });
    listEl = el('div', { class: 'zf-list' });
    runEl = el('div', { class: 'zf-running' });

    const panel = el('div', { class: 'zf-panel' }, [
      el('div', { class: 'zf-head' }, [
        el('strong', { text: '⚡ ZapFunil' }),
        el('span', { class: 'zf-status', id: 'zf-status-text', text: 'carregando…' }),
        el('button', { class: 'zf-auto', id: 'zf-auto', title: 'Ligar/pausar todas as automações (gatilhos, remarketing, agendamentos e campanhas)', onclick: async () => {
          const st = Object.assign({}, DB.settings, { automationsPaused: !DB.settings.automationsPaused });
          await chrome.storage.local.set({ settings: st });
          DB.settings = Object.assign({}, ZF.DEFAULT_SETTINGS, st);
          updateStatus();
          toast(st.automationsPaused ? '⏸ Automações pausadas (envio manual continua)' : '▶ Automações ligadas');
        } }, ['Auto']),
        el('button', { class: 'zf-icon-btn', title: 'Painel de controle', onclick: () => chrome.runtime.sendMessage({ type: 'openDashboard' }) }, ['⚙️']),
        el('button', { class: 'zf-icon-btn', title: 'Fechar', onclick: togglePanel }, ['✕'])
      ]),
      searchEl,
      tabBar,
      runEl,
      listEl,
      el('div', { class: 'zf-foot' }, [
        el('span', { text: 'Clique para enviar no chat aberto' }),
        el('button', { class: 'zf-link', id: 'zf-showbar', onclick: () => window.__zfShowBar && window.__zfShowBar() }, ['Mostrar barra no chat'])
      ])
    ]);
    root.appendChild(panel);
    root.appendChild(fab);
    document.body.appendChild(root);
    chrome.storage.local.get('panelOpen').then((d) => {
      if (d.panelOpen) root.classList.add('zf-open');
    });
  }

  function togglePanel() {
    root.classList.toggle('zf-open');
    chrome.storage.local.set({ panelOpen: root.classList.contains('zf-open') });
    if (root.classList.contains('zf-open')) searchEl.focus();
  }

  function updateStatus() {
    if (!statusDot) return;
    statusDot.className = 'zf-dot ' + (waReady ? 'zf-dot-ok' : 'zf-dot-wait');
    const st = document.getElementById('zf-status-text');
    const ab = document.getElementById('zf-auto');
    if (ab && DB) {
      ab.textContent = DB.settings.automationsPaused ? '⏸ Auto OFF' : '▶ Auto ON';
      ab.classList.toggle('zf-auto-off', !!DB.settings.automationsPaused);
    }
    if (st) st.textContent = waReady ? (isLeader ? 'conectado' : localLeader ? 'conectado (servidor 24h no comando)' : 'conectado (outra aba roda os gatilhos)') : 'aguardando WhatsApp…';
  }

  function renderList() {
    if (!listEl || !DB) return;
    const q = ZF.normalizeText(searchEl.value).replace(/^\//, '');
    listEl.innerHTML = '';
    if (activeTab === 'rmkt') return renderRmktTab(q);
    const rows = [];
    if (activeTab === 'all' || activeTab === 'funnel') {
      DB.funnels.forEach((f) => rows.push({ kind: 'funnel', obj: f }));
    }
    if (activeTab !== 'funnel') {
      DB.items.forEach((i) => {
        if (activeTab === 'all' || activeTab === i.type || (activeTab === 'media' && (i.type === 'image' || i.type === 'video'))) rows.push({ kind: 'item', obj: i });
      });
    }
    const GROUP = { funnel: 0, text: 1, audio: 2, image: 3, video: 3, document: 4 };
    const GROUP_TITLE = ['🔁 Funis', '💬 Mensagens', '🎤 Áudios', '🖼️ Mídias', '📄 Documentos'];
    const filtered = rows
      .map((r, i) => Object.assign(r, { g: GROUP[r.kind === 'funnel' ? 'funnel' : r.obj.type], i }))
      .filter((r) => {
        if (!q) return true;
        const o = r.obj;
        return ZF.normalizeText([o.name, o.shortcut, o.text, o.caption].join(' ')).includes(q);
      })
      .sort((a, b) => a.g - b.g || a.i - b.i);
    if (!filtered.length) {
      listEl.appendChild(el('div', { class: 'zf-empty' }, [
        DB.items.length || DB.funnels.length ? 'Nada encontrado.' : 'Nenhum item ainda. ',
        DB.items.length || DB.funnels.length ? '' : el('a', { href: '#', onclick: (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: 'openDashboard' }); } }, ['Criar no painel de controle'])
      ]));
      return;
    }
    let lastG = -1;
    filtered.forEach((r) => {
      if (activeTab === 'all' && r.g !== lastG) {
        lastG = r.g;
        listEl.appendChild(el('div', { class: 'zf-group', text: GROUP_TITLE[r.g] }));
      }
      const o = r.obj;
      let icon, sub;
      if (r.kind === 'funnel') {
        icon = '🔁';
        sub = o.steps.length + ' etapa(s)';
      } else {
        icon = ZF.typeIcon(o.type);
        if (o.type === 'text') sub = (o.text || '').slice(0, 70);
        else if (o.type === 'audio') sub = 'Áudio ' + ZF.fmtDuration(o.duration);
        else sub = o.caption ? o.caption.slice(0, 60) : ZF.typeLabel(o.type);
      }
      const row = el('button', { class: 'zf-row', title: r.kind === 'item' && o.type === 'text' ? o.text : o.name, onclick: () => sendFromPanel(r) }, [
        el('span', { class: 'zf-row-icon', text: icon }),
        el('span', { class: 'zf-row-main' }, [
          el('span', { class: 'zf-row-name' }, [o.name || '(sem nome)', o.shortcut ? el('em', { text: ' /' + o.shortcut }) : null]),
          el('span', { class: 'zf-row-sub', text: sub })
        ])
      ]);
      listEl.appendChild(row);
    });
  }

  function renderRmktTab(q) {
    listEl.appendChild(el('div', { class: 'zf-rmkt-actions' }, [
      el('button', { class: 'zf-btn-stop', onclick: async () => {
        const chat = await call('activeChat').catch(() => null);
        if (!chat) return toast('Abra uma conversa primeiro', 'warn');
        const n = await rmktStopChat(chat.id);
        toast(n ? 'Remarketing parado para ' + (chat.name || 'este contato') : 'Este contato não está em nenhum remarketing');
      } }, ['⛔ Parar remarketing deste chat'])
    ]));
    const rules = (DB.remarketing || []).filter((r) => !q || ZF.normalizeText(r.name).includes(q));
    if (!rules.length) {
      listEl.appendChild(el('div', { class: 'zf-empty' }, ['Nenhuma regra de remarketing. ', el('a', { href: '#', onclick: (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: 'openDashboard', hash: '#remarketing' }); } }, ['Criar no painel'])]));
      return;
    }
    rules.forEach((r) => {
      listEl.appendChild(el('button', { class: 'zf-row', title: 'Colocar o chat aberto nesta sequência agora', onclick: async () => {
        const chat = await call('activeChat').catch(() => null);
        if (!chat) return toast('Abra uma conversa primeiro', 'warn');
        if (chat.isGroup) return toast('Remarketing não funciona em grupos', 'warn');
        if ((DB.rmktBlock || {})[chat.id]) return toast('Esse contato pediu para não receber mais mensagens', 'warn');
        await rmktEnqueue(chat.id, '', { name: chat.name }, r.id);
        toast('🔔 ' + (chat.name || 'Contato') + ' entrou no remarketing "' + r.name + '"');
      } }, [
        el('span', { class: 'zf-row-icon', text: '🔔' }),
        el('span', { class: 'zf-row-main' }, [
          el('span', { class: 'zf-row-name', text: r.name + (r.enabled ? '' : ' (pausada)') }),
          el('span', { class: 'zf-row-sub', text: r.stages.length + ' etapa(s) · ' + (r.mode === 'inactive' ? 'conversa parada' : 'se não responder') })
        ])
      ]));
    });
  }

  function renderRunning() {
    if (!runEl) return;
    runEl.innerHTML = '';
    let total = 0;
    for (const [chatId, run] of running.entries()) {
      total++;
      runEl.appendChild(el('div', { class: 'zf-run' }, [
        el('span', { text: '▶ ' + run.label + ' → ' + run.name + ' (' + run.step + '/' + run.total + ')' }),
        el('button', { class: 'zf-cancel', title: 'Parar este envio', onclick: () => { run.cancelled = true; toast('Envio cancelado'); } }, ['■']),
        (queues.get(chatId) || []).length ? el('button', { class: 'zf-cancel', title: 'Parar e limpar a fila desta conversa', onclick: () => { stopChat(chatId); toast('Conversa parada e fila limpa'); } }, ['✕ tudo']) : null
      ]));
      (queues.get(chatId) || []).forEach((j, i) => {
        runEl.appendChild(el('div', { class: 'zf-run zf-queued' }, [
          el('span', { text: '⏳ ' + (i + 1) + 'º na fila: ' + j.funnel.name + ' → ' + j.name }),
          el('button', { class: 'zf-cancel', title: 'Tirar da fila', onclick: () => removeQueued(chatId, j.id) }, ['✕'])
        ]));
      });
    }
    if (total) runEl.prepend(el('div', { class: 'zf-run-title', text: 'Enviando agora (' + total + ' conversa' + (total > 1 ? 's' : '') + ')' }));
  }

  async function sendFromPanel(r) {
    if (!waReady) return toast('WhatsApp ainda carregando…', 'warn');
    let chat;
    try {
      chat = await call('activeChat');
    } catch (e) {
      return toast(e.message, 'err');
    }
    if (!chat) return toast('Abra uma conversa primeiro', 'warn');
    const funnel = r.kind === 'funnel' ? r.obj : funnelFromItem(r.obj);
    const queued = running.has(chat.id);
    toast(queued ? '⏳ Na fila: ' + funnel.name : (r.kind === 'funnel' ? 'Funil iniciado: ' : 'Enviando: ') + funnel.name);
    try {
      await runFunnel(chat.id, funnel, { name: chat.name, number: chat.id }, 'manual');
    } catch (e) {
      if (e.message !== 'Cancelado') toast('Erro: ' + e.message, 'err');
    }
  }

  // Limpa a caixa de mensagem. O editor do WhatsApp (Lexical) só aceita apagar pelo evento
  // "beforeinput"; execCommand fica como reserva para outros editores.
  function clearCompose(box) {
    const selectAll = () => {
      const sel = window.getSelection();
      const rg = document.createRange();
      rg.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(rg);
    };
    box.focus();
    selectAll();
    box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
    if ((box.innerText || '').trim()) {
      selectAll();
      document.execCommand('delete', false, null);
    }
  }

  // ---------------------------------------------------------------- BARRA NO CHAT + BUSCA AO DIGITAR
  // Barra com funis/mensagens logo abaixo da caixa de mensagem do WhatsApp e sugestões ao digitar.
  const GROUP_ORDER = { funnel: 0, text: 1, audio: 2, image: 3, video: 3, document: 4 };
  function allEntries() {
    if (!DB) return [];
    const rows = DB.funnels.map((f, i) => ({ kind: 'funnel', obj: f, g: 0, i }))
      .concat(DB.items.map((it, i) => ({ kind: 'item', obj: it, g: GROUP_ORDER[it.type] || 9, i })));
    return rows.sort((a, b) => a.g - b.g || a.i - b.i);
  }
  const entryIcon = (r) => (r.kind === 'funnel' ? '🔁' : ZF.typeIcon(r.obj.type));
  const composeBox = () => document.querySelector('#main footer [contenteditable="true"]');

  // ---- confirmação
  let confirmEl = null;
  function closeConfirm() {
    if (confirmEl) confirmEl.remove();
    confirmEl = null;
  }
  async function confirmAndSend(r, afterBox) {
    if (!waReady) return toast('WhatsApp ainda carregando…', 'warn');
    const chat = await call('activeChat').catch(() => null);
    if (!chat) return toast('Abra uma conversa primeiro', 'warn');
    const go = () => {
      closeConfirm();
      if (afterBox) clearCompose(afterBox);
      sendFromPanel(r);
    };
    if (DB.settings.confirmSend === false) return go();
    closeConfirm();
    const footer = document.querySelector('#main footer');
    const rect = (footer || document.body).getBoundingClientRect();
    const btnOk = el('button', { class: 'zf-c-ok', onclick: go }, ['Enviar ↵']);
    confirmEl = el('div', { class: 'zf-confirm', role: 'dialog' }, [
      el('div', { class: 'zf-c-title' }, [entryIcon(r) + ' ', el('b', { text: r.obj.name })]),
      el('div', { class: 'zf-c-sub', text: 'para ' + (chat.name || chat.id.replace(/@.*/, '')) + (running.has(chat.id) ? ' · entra na fila' : '') }),
      el('div', { class: 'zf-c-btns' }, [el('button', { class: 'zf-c-no', onclick: closeConfirm }, ['Cancelar']), btnOk])
    ]);
    confirmEl.style.left = Math.max(12, rect.left + 16) + 'px';
    confirmEl.style.bottom = Math.max(12, window.innerHeight - rect.top + 8) + 'px';
    confirmEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeConfirm();
      }
    });
    document.body.appendChild(confirmEl);
    btnOk.focus();
  }
  document.addEventListener('mousedown', (e) => {
    if (confirmEl && !confirmEl.contains(e.target) && !e.target.closest('.zf-chip,.zf-sug-row')) closeConfirm();
  }, true);

  // ---- barra abaixo da caixa de mensagem
  let barHidden = false;
  chrome.storage.local.get('barHidden').then((d) => {
    barHidden = !!d.barHidden;
    ensureBar();
  });
  function buildBar() {
    const bar = el('div', { class: 'zf-bar', id: 'zf-bar' });
    const scroller = el('div', { class: 'zf-bar-scroll' });
    const entries = allEntries();
    let lastG = -1;
    entries.forEach((r) => {
      if (r.g !== lastG && lastG !== -1) scroller.appendChild(el('span', { class: 'zf-bar-sep' }));
      lastG = r.g;
      scroller.appendChild(el('button', { class: 'zf-chip zf-chip-' + (r.kind === 'funnel' ? 'funnel' : r.obj.type), title: (r.obj.type === 'text' ? r.obj.text : r.obj.name) || '', onclick: () => confirmAndSend(r) }, [
        el('span', { class: 'zf-chip-ic', text: entryIcon(r) }),
        el('span', { text: r.obj.name || '(sem nome)' })
      ]));
    });
    if (!entries.length) scroller.appendChild(el('span', { class: 'zf-bar-empty', text: 'Crie mensagens e funis no painel ⚙️ para aparecerem aqui' }));
    scroller.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        scroller.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
    bar.appendChild(el('button', { class: 'zf-bar-logo', title: 'Abrir painel ZapFunil', onclick: () => { if (!root.classList.contains('zf-open')) togglePanel(); } }, ['⚡']));
    bar.appendChild(scroller);
    bar.appendChild(el('button', { class: 'zf-bar-hide', title: 'Esconder barra (reabre pelo ⚡ no canto)', onclick: () => {
      barHidden = true;
      chrome.storage.local.set({ barHidden: true });
      ensureBar();
    } }, ['▾']));
    return bar;
  }
  let barSig = '';
  function ensureBar() {
    const main = document.getElementById('main');
    const footer = main && main.querySelector(':scope > footer');
    const cur = document.getElementById('zf-bar');
    if (!footer || barHidden || !DB) {
      if (cur) cur.remove();
      return;
    }
    const sig = JSON.stringify([DB.funnels.map((f) => [f.id, f.name]), DB.items.map((i) => [i.id, i.name, i.type])]);
    if (cur && cur.previousElementSibling === footer && sig === barSig) return;
    if (cur) cur.remove();
    barSig = sig;
    footer.after(buildBar());
  }
  let barTimer = null;
  new MutationObserver(() => {
    if (barTimer) return;
    barTimer = setTimeout(() => {
      barTimer = null;
      ensureBar();
      positionFab();
    }, 150);
  }).observe(document.body, { childList: true, subtree: true });
  window.__zfShowBar = () => {
    barHidden = false;
    chrome.storage.local.set({ barHidden: false });
    ensureBar();
  };

  // ---- sugestões ao digitar
  let sugEl = null;
  let sugRows = [];
  let sugIdx = 0;
  function closeSug() {
    if (sugEl) sugEl.remove();
    sugEl = null;
    sugRows = [];
  }
  function matchEntries(text) {
    const raw = text.trim();
    if (!raw || raw.length > 60 || raw.includes('\n')) return [];
    const isCode = raw.startsWith('/');
    const q = ZF.normalizeText(raw.replace(/^\//, ''));
    if (!q || (!isCode && q.length < 3)) return [];
    const scored = [];
    for (const r of allEntries()) {
      const name = ZF.normalizeText(r.obj.name);
      const code = ZF.normalizeText(r.obj.shortcut || '');
      let sc = -1;
      if (code && code === q) sc = 0;
      else if (name.startsWith(q)) sc = 1;
      else if (code && code.startsWith(q)) sc = 2;
      else if (name.includes(q)) sc = 3;
      else if (!isCode && q.length >= 4 && r.obj.type === 'text' && ZF.normalizeText(r.obj.text).includes(q)) sc = 5;
      if (sc >= 0) scored.push({ r, sc });
    }
    return scored.sort((a, b) => a.sc - b.sc || a.r.g - b.r.g || a.r.i - b.r.i).slice(0, 6).map((x) => x.r);
  }
  function renderSug(box) {
    const footer = document.querySelector('#main footer');
    if (!sugRows.length || !footer) return closeSug();
    if (!sugEl) {
      sugEl = el('div', { class: 'zf-sug' });
      document.body.appendChild(sugEl);
    }
    const rect = footer.getBoundingClientRect();
    sugEl.style.left = rect.left + 12 + 'px';
    sugEl.style.width = Math.min(460, rect.width - 24) + 'px';
    sugEl.style.bottom = window.innerHeight - rect.top + 6 + 'px';
    sugEl.innerHTML = '';
    sugEl.appendChild(el('div', { class: 'zf-sug-head', text: '⚡ ZapFunil · Tab ou clique para enviar · Esc fecha' }));
    sugRows.forEach((r, i) => {
      const sub = r.kind === 'funnel' ? r.obj.steps.length + ' etapa(s)' : r.obj.type === 'text' ? (r.obj.text || '').slice(0, 70) : r.obj.type === 'audio' ? 'Áudio ' + ZF.fmtDuration(r.obj.duration) : ZF.typeLabel(r.obj.type);
      sugEl.appendChild(el('button', { class: 'zf-sug-row' + (i === sugIdx ? ' zf-on' : ''), onmousedown: (e) => e.preventDefault(), onclick: () => pickSug(i, box) }, [
        el('span', { class: 'zf-sug-ic', text: entryIcon(r) }),
        el('span', { class: 'zf-sug-main' }, [el('span', { class: 'zf-sug-name' }, [r.obj.name, r.obj.shortcut ? el('em', { text: ' /' + r.obj.shortcut }) : null]), el('span', { class: 'zf-sug-sub', text: sub })])
      ]));
    });
  }
  function pickSug(i, box) {
    const r = sugRows[i];
    closeSug();
    if (r) confirmAndSend(r, box || composeBox());
  }
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!DB || !t || !t.isContentEditable || !t.closest('#main footer')) return;
    if (DB.settings.suggestOnType === false) return closeSug();
    sugRows = matchEntries(t.innerText || '');
    sugIdx = 0;
    renderSug(t);
  }, true);
  document.addEventListener('focusout', (e) => {
    if (sugEl && e.target && e.target.closest && e.target.closest('#main footer')) setTimeout(() => {
      const a = document.activeElement;
      if (!a || !a.closest || !a.closest('#main footer')) closeSug();
    }, 150);
  }, true);

  // Tab escolhe a sugestão; setas navegam; Esc fecha. Enter continua sendo do WhatsApp.
  document.addEventListener('keydown', (e) => {
    if (!DB) return;
    const target = e.target;
    if (!target || !target.isContentEditable || !target.closest('footer')) return;
    if (sugEl && sugRows.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : sugRows.length - 1)) % sugRows.length;
        renderSug(target);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSug();
        return;
      }
    }
    if (e.key === 'Enter') {
      closeSug();
      return;
    }
    if (e.key !== 'Tab') return;
    // atalho exato /codigo + Tab: envia direto (sem confirmação), como antes
    const txt = (target.innerText || '').trim();
    const m = txt.match(/^\/([\w\-çãõáéíóúâêô]+)$/i);
    if (m) {
      const code = ZF.normalizeText(m[1]);
      const item = DB.items.find((i) => i.shortcut && ZF.normalizeText(i.shortcut) === code);
      const funnel = !item && DB.funnels.find((f) => f.shortcut && ZF.normalizeText(f.shortcut) === code);
      if (item || funnel) {
        e.preventDefault();
        e.stopPropagation();
        closeSug();
        clearCompose(target);
        sendFromPanel(item ? { kind: 'item', obj: item } : { kind: 'funnel', obj: funnel });
        return;
      }
    }
    if (sugEl && sugRows.length) {
      e.preventDefault();
      e.stopPropagation();
      pickSug(sugIdx, target);
    }
  }, true);

  // ---------------------------------------------------------------- SALVAR MENSAGEM NA FERRAMENTA
  // Botão ⚡+ ao lado do emoji "Reagir" que o WhatsApp mostra ao passar o mouse numa mensagem.
  const REACT_SEL = ['Reagir', 'React', 'Reaccionar', 'Reagire', 'Réagir', 'Reagieren'].map((t) => '#main [aria-label="' + t + '"]').join(',');
  function reactionContainer(reactEl) {
    // sobe até o bloco flexível (posição absoluta) que segura o emoji
    let n = reactEl;
    for (let i = 0; i < 6 && n && n.parentElement; i++) {
      const p = n.parentElement;
      const cs = getComputedStyle(p);
      if (cs.position === 'absolute' && cs.display.includes('flex')) return { box: p, slot: n };
      n = p;
    }
    return null;
  }
  function ensureSaveButtons() {
    if (!DB) return;
    document.querySelectorAll(REACT_SEL).forEach((reactEl) => {
      const rc = reactionContainer(reactEl);
      if (!rc || rc.box.querySelector('.zf-save')) return;
      const row = reactEl.closest('[data-id]');
      if (!row) return;
      const btn = el('button', { class: 'zf-save', title: 'Salvar no ZapFunil', 'aria-label': 'Salvar no ZapFunil' }, [el('span', { text: '⚡' }), el('b', { text: '+' })]);
      btn.addEventListener('mousedown', (e) => e.stopPropagation(), true);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSaveModal(row.getAttribute('data-id'));
      }, true);
      // mensagem sua: o emoji fica à esquerda do balão -> botão vai antes; do lead: depois
      const bubble = rc.box.parentElement;
      const outgoing = bubble && rc.box.getBoundingClientRect().left < bubble.getBoundingClientRect().left;
      if (outgoing) rc.box.insertBefore(btn, rc.slot);
      else rc.box.insertBefore(btn, rc.slot.nextSibling);
    });
  }
  let saveRaf = 0;
  new MutationObserver(() => {
    if (saveRaf) return;
    saveRaf = requestAnimationFrame(() => {
      saveRaf = 0;
      ensureSaveButtons();
    });
  }).observe(document.body, { childList: true, subtree: true });

  let saveEl = null;
  document.addEventListener('keydown', (e) => {
    if (saveEl && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSave();
    }
  }, true);
  function closeSave() {
    if (saveEl) saveEl.remove();
    saveEl = null;
  }
  async function openSaveModal(key) {
    closeSave();
    const body = el('div', { class: 'zf-sv-body' }, [el('div', { class: 'zf-sv-load', text: 'Carregando a mensagem…' })]);
    const box = el('div', { class: 'zf-sv-box', role: 'dialog' }, [
      el('div', { class: 'zf-sv-head' }, [el('span', { class: 'zf-sv-eyebrow', text: 'ZapFunil' }), el('h3', { text: 'Salvar na ferramenta' })]),
      body
    ]);
    saveEl = el('div', { class: 'zf-sv', onmousedown: (e) => { if (e.target === saveEl) closeSave(); } }, [box]);
    saveEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSave();
      e.stopPropagation();
    });
    document.body.appendChild(saveEl);
    let m;
    try {
      m = await call('msgForSave', key);
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'zf-sv-err', text: e.message }));
      const fechar = el('button', { class: 'zf-c-no', onclick: closeSave }, ['Fechar']);
      body.appendChild(el('div', { class: 'zf-c-btns' }, [fechar]));
      fechar.focus();
      return;
    }
    if (!saveEl) return;
    const map = { chat: 'text', ptt: 'audio', audio: 'audio', image: 'image', sticker: 'image', video: 'video', document: 'document' };
    const type = map[m.type];
    const dur = m.duration ? ' ' + ZF.fmtDuration(m.duration) : '';
    const suggested = type === 'text' ? m.text.replace(/\s+/g, ' ').slice(0, 32) : type === 'audio' ? 'Áudio' + dur : type === 'document' ? (m.filename || 'Documento').replace(/\.\w+$/, '') : (m.caption || ZF.typeLabel(type)).slice(0, 32);
    body.innerHTML = '';
    const prev = el('div', { class: 'zf-sv-prev' });
    let textArea = null;
    let capArea = null;
    if (type === 'text') {
      textArea = el('textarea', { class: 'zf-sv-in', rows: '4' });
      textArea.value = m.text;
      prev.appendChild(el('label', { class: 'zf-sv-lab', text: 'Mensagem (pode editar, aceita {nome}, {Saudacao}…)' }));
      prev.appendChild(textArea);
    } else {
      const kb = Math.round((m.size || 0) / 1024);
      const lab = { audio: '🎤 ' + (m.type === 'ptt' ? 'Áudio de voz' : 'Arquivo de áudio') + dur, image: '🖼️ Imagem', video: '🎬 Vídeo' + dur, document: '📄 ' + (m.filename || 'Documento') }[type];
      const row = el('div', { class: 'zf-sv-media' }, [el('span', { text: lab }), el('em', { text: kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB' })]);
      if (type === 'image' && /^data:image\//.test(m.data)) prev.appendChild(el('img', { class: 'zf-sv-img', src: m.data, alt: '' }));
      prev.appendChild(row);
      if (type === 'audio' && m.type === 'ptt') prev.appendChild(el('div', { class: 'zf-sv-hint', text: 'Vai sair como áudio "gravado na hora", com "gravando áudio…" antes.' }));
      if (type !== 'audio') {
        capArea = el('textarea', { class: 'zf-sv-in', rows: '2', placeholder: 'Legenda (opcional)' });
        capArea.value = m.caption || '';
        prev.appendChild(el('label', { class: 'zf-sv-lab', text: 'Legenda' }));
        prev.appendChild(capArea);
      }
    }
    const nameIn = el('input', { class: 'zf-sv-in', type: 'text', placeholder: 'Ex: Boas-vindas' });
    nameIn.value = suggested;
    const shortIn = el('input', { class: 'zf-sv-in', type: 'text', placeholder: 'ex: oi (opcional)' });
    const funSel = el('select', { class: 'zf-sv-in' }, [el('option', { value: '', text: 'Não adicionar a funil' })].concat(DB.funnels.map((f) => el('option', { value: f.id, text: 'Adicionar ao final de: ' + f.name }))));
    const err = el('div', { class: 'zf-sv-err' });
    const doSave = async () => {
      err.textContent = '';
      const name = nameIn.value.trim();
      const shortcut = shortIn.value.trim().replace(/^\//, '').replace(/\s+/g, '');
      if (!name) return (err.textContent = 'Dê um nome');
      if (shortcut && DB.items.concat(DB.funnels).some((x) => x.shortcut && ZF.normalizeText(x.shortcut) === ZF.normalizeText(shortcut))) return (err.textContent = 'Esse atalho já existe');
      const item = { id: ZF.uid(), type, name, shortcut };
      if (type === 'text') {
        item.text = textArea.value;
        if (!item.text.trim()) return (err.textContent = 'Mensagem vazia');
      } else {
        item.data = m.data;
        item.mime = type === 'audio' && m.type === 'ptt' ? 'audio/ogg; codecs=opus' : m.mime || undefined;
        item.filename = m.filename || (type === 'audio' ? 'audio.ogg' : undefined);
        if (m.duration) item.duration = m.duration;
        if (type === 'audio' && m.type === 'audio') item.asFile = true;
        if (capArea) item.caption = capArea.value;
      }
      try {
        await mutate('items', (arr) => arr.concat([item]));
        if (funSel.value) {
          await mutate('funnels', (arr) => arr.map((f) => (f.id === funSel.value ? Object.assign({}, f, { steps: f.steps.concat([{ kind: 'send', itemId: item.id, delay: f.steps.length ? 3 : 0, delayUnit: 's', simulate: true }]) }) : f)));
        }
      } catch (e) {
        return (err.textContent = 'Erro ao salvar: ' + e.message);
      }
      closeSave();
      toast('⚡ Salvo no ZapFunil: ' + name + (funSel.value ? ' (adicionado ao funil)' : ''));
    };
    [nameIn, shortIn].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } }));
    body.appendChild(prev);
    body.appendChild(el('div', { class: 'zf-sv-grid' }, [
      el('div', {}, [el('label', { class: 'zf-sv-lab', text: 'Nome na ferramenta' }), nameIn]),
      el('div', {}, [el('label', { class: 'zf-sv-lab', text: 'Atalho' }), shortIn])
    ]));
    body.appendChild(el('div', {}, [el('label', { class: 'zf-sv-lab', text: 'Funil' }), funSel]));
    body.appendChild(err);
    body.appendChild(el('div', { class: 'zf-c-btns' }, [el('button', { class: 'zf-c-no', onclick: closeSave }, ['Cancelar']), el('button', { class: 'zf-c-ok', onclick: doSave }, ['Salvar'])]));
    nameIn.focus();
    nameIn.select();
  }

  // ---------------------------------------------------------------- posição do ⚡ (topo, embaixo dos "⋮" do WhatsApp)
  function positionFab() {
    if (!root) return;
    const hdr = document.querySelector('#main header');
    let top = 76;
    let right = 20;
    if (hdr) {
      const hr = hdr.getBoundingClientRect();
      const btns = [...hdr.querySelectorAll('[role="button"], button')].filter((b) => b.getBoundingClientRect().width > 0);
      const kebab = btns[btns.length - 1];
      top = Math.round(hr.bottom + 10);
      if (kebab) {
        const kr = kebab.getBoundingClientRect();
        right = Math.max(8, Math.round(window.innerWidth - kr.right + (kr.width - 42) / 2));
      }
    }
    root.style.top = top + 'px';
    root.style.right = right + 'px';
  }
  window.addEventListener('resize', positionFab);

  // ---------------------------------------------------------------- CONTROLE REMOTO (celular)
  // Só a aba líder conversa com o celular. A rede fica no background (remote.js).
  function bg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: chrome.runtime.lastError && chrome.runtime.lastError.message }));
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }
  // Conversas abertas no celular: o Mac envia as mensagens novas enquanto a tela estiver aberta.
  const watched = new Map(); // chatId -> expira em
  const chatPubPending = new Set();
  async function publishChat(chatId) {
    const msgs = await call('chatMessages', chatId, 50);
    const name = await call('contactName', chatId).catch(() => '');
    await bg({ type: 'remote:chat', chatId, data: { name, msgs, at: Date.now() } });
  }
  function chatChanged(chatId) {
    const exp = watched.get(chatId);
    if (!exp) return;
    if (exp < Date.now()) {
      watched.delete(chatId);
      return;
    }
    if (chatPubPending.has(chatId)) return;
    chatPubPending.add(chatId);
    sleep(700).then(() => {
      chatPubPending.delete(chatId);
      return publishChat(chatId);
    }).catch(() => {});
  }

  const CMD_MAX_AGE = 15 * 60000; // comando com +15 min (Mac estava desligado) não é executado

  async function execCommands(cmds) {
    const out = [];
    for (const cmd of cmds) {
      let ok = true;
      let result = '';
      try {
        if (Date.now() - new Date(cmd.created_at).getTime() > CMD_MAX_AGE) throw new Error('Expirou: o Mac/WhatsApp Web estava offline quando você mandou');
        result = await runCommand(cmd);
      } catch (e) {
        ok = false;
        result = e.message || String(e);
      }
      out.push({ id: cmd.id, ok, result });
    }
    return out;
  }

  async function resolveTarget(target) {
    if (!target) throw new Error('Contato vazio');
    if (/@/.test(target)) return { id: target, name: await call('contactName', target).catch(() => '') };
    const num = ZF.normalizeNumber(target);
    if (num.length < 10) throw new Error('Número inválido');
    return call('resolve', num);
  }

  async function runCommand(cmd) {
    const p = cmd.payload || {};
    switch (cmd.kind) {
      case 'send': {
        const funnel = targetToFunnel(p.targetType, p.targetId);
        if (!funnel) throw new Error('Funil/item não existe mais');
        const c = await resolveTarget(p.target);
        const queued = running.has(c.id);
        // não espera terminar: o celular acompanha pelo histórico
        runFunnel(c.id, funnel, { name: p.name || c.name, number: c.id }, 'celular').catch(() => {});
        return (queued ? 'Na fila: ' : 'Enviando: ') + funnel.name + ' → ' + (p.name || c.name || c.id.replace(/@.*/, ''));
      }
      case 'automations': {
        const st = Object.assign({}, DB.settings, { automationsPaused: !!p.paused });
        await chrome.storage.local.set({ settings: st });
        DB.settings = Object.assign({}, ZF.DEFAULT_SETTINGS, st);
        updateStatus();
        return p.paused ? 'Automações pausadas' : 'Automações ligadas';
      }
      case 'rmkt_enqueue': {
        const c = await resolveTarget(p.target);
        if ((DB.rmktBlock || {})[c.id]) throw new Error('Esse contato pediu para não receber mais');
        const n = await rmktEnqueue(c.id, '', { name: p.name || c.name }, p.ruleId);
        if (!n) throw new Error('Regra de remarketing não encontrada');
        return 'Entrou no remarketing';
      }
      case 'rmkt_stop_chat': {
        const n = await rmktStopChat(p.chatId);
        return n ? 'Remarketing parado' : 'Não estava em remarketing';
      }
      case 'rmkt_cancel': {
        let found = false;
        await mutate('rmktQueue', (q) => q.map((e) => {
          if (e.id !== p.entryId || !ACTIVE(e)) return e;
          found = true;
          return Object.assign({}, e, { status: 'cancelled', reason: 'parado pelo celular', endedAt: Date.now() });
        }));
        return found ? 'Parado' : 'Já tinha terminado';
      }
      case 'campaign': {
        let msg = '';
        await mutate('campaigns', (arr) => arr.map((c) => {
          if (c.id !== p.id) return c;
          if (p.action === 'pause' && c.status === 'running') { msg = 'Campanha pausada'; return Object.assign({}, c, { status: 'paused' }); }
          if (p.action === 'resume' && c.status !== 'running' && c.status !== 'done') {
            if (arr.some((x) => x.status === 'running' && x.id !== c.id)) { msg = 'Outra campanha já está rodando'; return c; }
            msg = 'Campanha retomada';
            return Object.assign({}, c, { status: 'running', lastError: '' });
          }
          msg = 'Nada a fazer';
          return c;
        }));
        return msg || 'Campanha não encontrada';
      }
      case 'schedule': {
        const nums = (p.numbers || []).map(ZF.normalizeNumber).filter((n) => n.length >= 10);
        if (!nums.length) throw new Error('Número inválido');
        if (!targetToFunnel(p.targetType, p.targetId)) throw new Error('Funil/item não existe mais');
        const at = new Date(p.at).getTime();
        if (!at) throw new Error('Data inválida');
        await mutate('schedules', (arr) => arr.concat([{ id: ZF.uid(), numbers: nums, at, repeat: 'none', targetType: p.targetType, targetId: p.targetId, status: 'pending', useName: p.name || '' }]));
        return 'Agendado para ' + new Date(at).toLocaleString('pt-BR');
      }
      case 'schedule_cancel': {
        await mutate('schedules', (arr) => arr.filter((x) => x.id !== p.id));
        return 'Agendamento removido';
      }
      case 'ping':
        return 'Mac online ✓';
      case 'watch_chat': {
        if (!p.chatId) throw new Error('Conversa inválida');
        watched.set(p.chatId, Date.now() + 3 * 60000);
        await publishChat(p.chatId);
        return 'ok';
      }
      case 'send_audio': {
        if (!p.path) throw new Error('Áudio não encontrado');
        const c = await resolveTarget(p.chatId || p.target);
        const r = await bg({ type: 'remote:audio', path: p.path });
        if (!r.ok) throw new Error(r.error || 'Falha ao baixar o áudio');
        // resposta manual do celular: conta como "você respondeu"
        await call('sendFile', c.id, r.data, { type: 'audio', isPtt: true, mimetype: p.mime || 'audio/mpeg' });
        bg({ type: 'remote:audioDel', path: p.path });
        logHistory({ chatId: c.id, name: c.name || '', what: '🎤 Áudio ' + ZF.fmtDuration(p.duration || 0), source: 'celular (áudio)', ok: true, err: '' });
        if (watched.has(c.id)) sleep(800).then(() => publishChat(c.id)).catch(() => {});
        return 'Áudio enviado';
      }
      case 'send_text': {
        const text = String(p.text || '').trim();
        if (!text) throw new Error('Mensagem vazia');
        if (text.length > 4000) throw new Error('Mensagem muito longa');
        const c = await resolveTarget(p.chatId || p.target);
        if (p.typing !== false) {
          const secs = Math.min(4, Math.max(1, text.length / 25));
          await call('typing', c.id, Math.round(secs * 1000)).catch(() => {});
          await sleep(secs * 1000);
        }
        // resposta manual do celular: conta como "você respondeu" para o remarketing
        await call('sendText', c.id, text);
        logHistory({ chatId: c.id, name: c.name || '', what: '✍️ ' + text.slice(0, 40), source: 'celular (texto)', ok: true, err: '' });
        if (watched.has(c.id)) sleep(800).then(() => publishChat(c.id)).catch(() => {});
        return 'Mensagem enviada';
      }
      default:
        throw new Error('Comando desconhecido: ' + cmd.kind);
    }
  }

  async function buildSnapshot() {
    let chats = [];
    try {
      chats = await call('recentChats', 80);
      call('loadPics', chats.slice(0, 60).map((c) => c.id)).catch(() => {});
    } catch (e) {}
    const ruleName = (id) => ((DB.remarketing || []).find((r) => r.id === id) || {}).name || '';
    const data = {
      v: 1,
      at: Date.now(),
      waReady,
      unread: chats.reduce((s, c) => s + (c.unread > 0 ? c.unread : c.unread < 0 ? 1 : 0), 0),
      paused: !!DB.settings.automationsPaused,
      items: DB.items.map((i) => ({ id: i.id, type: i.type, name: i.name, shortcut: i.shortcut || '', text: i.type === 'text' ? (i.text || '').slice(0, 160) : (i.caption || '').slice(0, 100), duration: i.duration || 0 })),
      funnels: DB.funnels.map((f) => ({ id: f.id, name: f.name, steps: f.steps.length })),
      rules: (DB.remarketing || []).map((r) => ({ id: r.id, name: r.name, enabled: !!r.enabled, stages: r.stages.length, mode: r.mode })),
      queue: (DB.rmktQueue || []).filter(ACTIVE).slice(-200).map((e) => ({ id: e.id, chatId: e.chatId, name: e.name, rule: ruleName(e.ruleId), stage: e.stageIdx + 1, total: ((DB.remarketing || []).find((r) => r.id === e.ruleId) || { stages: [] }).stages.length, dueAt: e.dueAt, status: e.status })),
      campaigns: DB.campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, total: c.contacts.length, progress: c.progress || 0, sent: c.sent || 0, failed: c.failed || 0 })),
      schedules: DB.schedules.filter((x) => x.status === 'pending' || x.status === 'paused').map((x) => ({ id: x.id, at: x.at, numbers: x.numbers.slice(0, 5), n: x.numbers.length, target: (targetToFunnel(x.targetType, x.targetId) || {}).name || '?', status: x.status })),
      history: (DB.history || []).slice(0, 40).map((h) => ({ t: h.t, name: h.name, chatId: h.chatId, what: h.what, source: h.source, ok: h.ok, err: h.err })),
      running: Array.from(running.entries()).map(([id, r]) => ({ chatId: id, name: r.name, label: r.label, step: r.step, total: r.total, queued: (queues.get(id) || []).length })),
      chats
    };
    return data;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'zf:tick') {
      refreshLeader();
      clockTick();
      return;
    }
    if (msg.type === 'zf:cloud') {
      setCloud(msg);
      return;
    }
    if (msg.type === 'zf:hoststate') {
      const qrEl = document.querySelector('div[data-ref] canvas, canvas[aria-label*="QR" i], canvas[aria-label*="scan" i]');
      const state = waReady ? 'ready' : qrEl ? 'qr' : 'loading';
      let qr = null;
      if (state === 'qr') {
        try {
          qr = qrEl.toDataURL('image/png');
        } catch (e) {}
      }
      const busy = running.size > 0 || Array.from(queues.values()).some((q) => q && q.length) || !!(rmktBusy || campaignBusy || schedulerBusy);
      sendResponse({ waReady, busy, state, qr, local: localLeader });
      return;
    }
    if (msg.type === 'zf:linkcode') {
      call('linkCode', msg.phone)
        .then((code) => sendResponse({ code }), (e) => sendResponse({ error: e.message || String(e) }));
      return true;
    }
    if (msg.type === 'zf:exec') {
      if (!isLeader || !waReady || !DB) {
        sendResponse({ notReady: true });
        return;
      }
      execCommands(msg.cmds || []).then((results) => sendResponse({ results }), (e) => sendResponse({ notReady: true, error: e.message }));
      return true;
    }
    if (msg.type === 'zf:snapshot') {
      if (!isLeader || !DB) {
        sendResponse(null);
        return;
      }
      buildSnapshot().then(sendResponse, () => sendResponse(null));
      return true;
    }
  });

  // ---------------------------------------------------------------- inicialização
  async function init() {
    buildUI();
    positionFab();
    await reload();
    await heartbeat();
    if (isLeader) {
      await recoverSchedules();
      await rmktRecover();
    }
    initDone = true;
    every(heartbeat, 10000);
    every(schedulerTick, 15000);
    every(campaignTick, 5000);
    every(rmktTick, 10000);
    try {
      await call('ready');
      waReady = true;
      updateStatus();
      schedulerTick();
      campaignTick();
      rmktTick();
    } catch (e) {
      console.warn('[ZapFunil]', e);
    }
  }

  init();
})();
