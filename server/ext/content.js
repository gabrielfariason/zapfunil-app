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
      // prazos: enfeites (digitando/gravando) desistem rápido; envio de mídia grande pode demorar mais
      const timeoutMs = method === 'ready' ? 10 * 60 * 1000 : /^(typing|recording|paused)$/.test(method) ? 15 * 1000 : method === 'sendFile' ? 300 * 1000 : method === 'sendText' ? 120 * 1000 : 180 * 1000;
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
    if (d.event === 'groupJoin') gOnJoin(d.data);
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
        ZF.setVariations(DB.settings.variations);
        updateStatus();
      }
      else if (ZF.KEYS.includes(k)) DB[k] = changes[k].newValue || (ZF.OBJ_KEYS.includes(k) ? {} : []);
      if (k === 'items' || k === 'funnels' || k === 'remarketing') rerender = true;
      if (k === 'campaigns' && typeof renderCampBox === 'function') setTimeout(() => { try { renderCampBox(); } catch (e) {} }, 0);
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
      let next = fn(cur) || cur;
      if (key === 'items') {
        await ZF.save({ items: next }); // separa áudios/vídeos/imagens em chaves próprias
        next = ZF.splitItems(next).items;
      } else await chrome.storage.local.set({ [key]: next });
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
    statRun(entry);
  }

  // ---------------------------------------------------------------- relatório (contadores por dia)
  function statCat(source) {
    return String(source || 'manual').split(':')[0].replace(/\s*\(.*$/, '').trim().toLowerCase() || 'manual';
  }
  function bumpStats(fn, t) {
    return mutate('stats', (s) => {
      const k = ZF.dayKey(t);
      const d = s[k] || (s[k] = {});
      fn(d);
      const keep = Math.max(7, Number(DB && DB.settings && DB.settings.statsDays) || 120);
      const days = Object.keys(s).filter((x) => /^\d{4}-/.test(x)).sort();
      while (days.length > keep) delete s[days.shift()];
      return s;
    }).catch(() => {});
  }
  const inc = (o, k, n) => (o[k] = (o[k] || 0) + (n || 1));
  function statRun(entry, t) {
    return bumpStats((d) => {
      if (entry.err === 'Cancelado') return inc(d, 'cancel');
      inc(d, entry.ok ? 'ok' : 'fail');
      if (!entry.ok) return;
      d.src = d.src || {};
      inc(d.src, statCat(entry.source));
      d.top = d.top || {};
      if (Object.keys(d.top).length < 80 || d.top[entry.what]) inc(d.top, String(entry.what || '?').slice(0, 60));
      const num = String(entry.chatId || '').replace(/@.*/, '');
      d.chats = d.chats || [];
      if (num && d.chats.length < 3000 && !d.chats.includes(num)) d.chats.push(num);
    }, t);
  }
  // primeira vez: monta o relatório a partir do histórico que já existe
  async function seedStats() {
    const cur = (await chrome.storage.local.get('stats')).stats || {};
    if (cur.__seeded) return;
    const hist = ((await chrome.storage.local.get('history')).history || []).slice().reverse();
    await mutate('stats', (s) => {
      if (s.__seeded) return s;
      for (const e of hist) {
        const k = ZF.dayKey(e.t);
        const d = s[k] || (s[k] = {});
        if (e.err === 'Cancelado') { inc(d, 'cancel'); continue; }
        inc(d, e.ok ? 'ok' : 'fail');
        if (!e.ok) continue;
        d.src = d.src || {}; inc(d.src, statCat(e.source));
        d.top = d.top || {}; inc(d.top, String(e.what || '?').slice(0, 60));
        const num = String(e.chatId || '').replace(/@.*/, '');
        d.chats = d.chats || [];
        if (num && !d.chats.includes(num)) d.chats.push(num);
      }
      s.__seeded = Date.now();
      return s;
    }).catch(() => {});
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

  // Acompanhamento do envio (painel "Enviando agora" e contador abaixo do ⚡)
  // phase: aguardando | digitando | gravando | enviando | resposta ; nextAt = quando a próxima mensagem sai
  function setPhase(run, phase, secs) {
    if (!run) return;
    run.phase = phase;
    if (phase === 'enviando') run.nextAt = Date.now();
    else if (phase === 'digitando' || phase === 'gravando') run.nextAt = Date.now() + secs * 1000;
    updateCountdowns();
  }
  // Tempo de "digitando…/gravando…" de um item (segundos)
  function simSeconds(item, ctx) {
    const s = DB.settings;
    if (item.type === 'text') {
      const text = ZF.applyVars(item.text || '', ctx);
      return Math.min(s.typingMax, Math.max(s.typingMin, text.length / Math.max(1, s.typingCps)));
    }
    if (item.type === 'audio') return Math.min(s.recordingMax, Math.max(2, (item.duration || 5) * s.recordingFactor));
    return 1.5;
  }
  // mantém o "digitando…/gravando…" visível durante toda a simulação (o WhatsApp apaga sozinho depois de uns segundos)
  async function simWait(chatId, method, secs, run) {
    const end = Date.now() + secs * 1000;
    call(method, chatId, Math.round(secs * 1000)).catch(() => {});
    while (Date.now() < end) {
      await wait(Math.min(8000, end - Date.now()), run);
      if (Date.now() < end - 1500) call(method, chatId, Math.round(end - Date.now())).catch(() => {});
    }
  }
  // opts.simSecs: quanto tempo simular
  async function sendItem(chatId, item, ctx, run, opts) {
    opts = opts || {};
    if (item && item.type !== 'text') {
      item = await ZF.withMedia(item);
      if (!item.data) throw new Error('arquivo de "' + item.name + '" não encontrado — abra o item no painel e envie o arquivo de novo');
    }
    const simulate = opts.simulate !== false;
    const secs = simulate ? (opts.simSecs != null ? opts.simSecs : simSeconds(item, ctx)) : 0;
    if (item.type === 'text') {
      const text = ZF.applyVars(item.text, ctx);
      if (!text.trim()) return;
      if (secs > 0.2) {
        setPhase(run, 'digitando', secs);
        await simWait(chatId, 'typing', secs, run);
      }
      setPhase(run, 'enviando', 0);
      markBot(chatId);
      await call('sendText', chatId, text, opts.mentionAll || opts.mentionIds ? { mentionAll: !!opts.mentionAll, mentionIds: opts.mentionIds } : undefined);
      markBot(chatId);
    } else if (item.type === 'audio') {
      if (secs > 0.2) {
        setPhase(run, 'gravando', secs);
        await simWait(chatId, 'recording', secs, run);
      }
      setPhase(run, 'enviando', 0);
      markBot(chatId);
      await call('sendFile', chatId, item.data, {
        type: 'audio',
        isPtt: item.asFile ? false : true,
        mimetype: item.mime || undefined,
        filename: item.filename || undefined,
        mentionAll: opts.mentionAll || undefined,
        mentionIds: opts.mentionIds || undefined
      });
    } else {
      if (secs > 0.2) {
        setPhase(run, 'digitando', secs);
        await simWait(chatId, 'typing', secs, run);
      }
      setPhase(run, 'enviando', 0);
      const o = { type: item.type, caption: ZF.applyVars(item.caption || '', ctx) || undefined };
      if (item.mime) o.mimetype = item.mime;
      if (item.filename) o.filename = item.filename;
      if (opts.mentionAll) o.mentionAll = true;
      else if (opts.mentionIds) o.mentionIds = opts.mentionIds;
      if (item.type === 'image' || item.type === 'video') {
        if (item.viewOnce) o.isViewOnce = true;
      }
      markBot(chatId);
      await call('sendFile', chatId, item.data, o);
    }
    bumpStats((d) => { inc(d, 'msgs'); d.types = d.types || {}; inc(d.types, item.type); });
    markBot(chatId);
    call('paused', chatId).catch(() => {}); // enfeite: não segura o próximo envio
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
    const run = { cancelled: false, label: funnel.name, step: 0, total: funnel.steps.length, name: ctx.name || chatId.replace(/@.*/, ''), msgN: 0 };
    // marcar todos (oculto) em grupo: em quais mensagens (1ª, última, todas ou números escolhidos)
    const mention = /@g\.us$/.test(chatId) && ctx.mention && ctx.mention.at && ctx.mention.at !== 'none' ? ctx.mention : null;
    const lastIdx = funnel.steps.map((x) => !!(x.itemId && x.kind !== 'wait_reply')).lastIndexOf(true);
    running.set(chatId, run);
    renderRunning();
    let ok = true;
    let err = '';
    // ramificação: manda outro funil/mensagem no lugar do resto deste funil
    const runBranch = async (target, depth) => {
      const [tt, ...rest] = String(target).split(':');
      const br = targetToFunnel(tt, rest.join(':'));
      if (!br || depth > 3) return;
      run.total += br.steps.length;
      run.label = funnel.name + ' → ' + br.name;
      run.branchKey = funnelKey(br);
      if (br.stage) run.branchStage = br.stage;
      renderRunning();
      await runSteps(br.steps, depth + 1);
    };
    const runSteps = async (steps, depth) => {
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        run.step++;
        renderRunning();
        if (st.kind === 'wait_reply') {
          run.phase = 'resposta';
          run.nextAt = st.timeoutMin ? Date.now() + st.timeoutMin * 60000 : null;
          run.nextLabel = '';
          updateCountdowns();
          const got = await waitForReply(chatId, (st.timeoutMin || 0) * 60000, run);
          const action = got ? st.onReply || 'continue' : st.onTimeout || 'continue';
          if (action === 'stop') return 'stop';
          if (action !== 'continue') {
            await runBranch(action, depth);
            return 'stop';
          }
          continue;
        }
        const delay = Math.max(0, Number(st.delay) || 0);
        const item = st.inline || getItem(st.itemId); // posts de grupo podem ter texto escrito direto no post
        if (!item) {
          if (delay) await wait(delay * 1000, run);
          continue; // item apagado – pula
        }
        // Ritmo natural: primeiro a pausa ("Esperar"), depois o "digitando…/gravando…" pelo tempo do texto/áudio,
        // e só então a mensagem sai. Sem "Esperar" definido, a pausa é do mesmo tamanho da digitação/gravação
        // (era assim que funcionava na prática e ficava natural).
        const simulate = st.simulate !== false;
        const sim = simulate ? simSeconds(item, ctx) : 0;
        const pause = delay > 0 ? delay : sim;
        run.nextLabel = (item.type === 'audio' ? '🎤 ' : item.type === 'text' ? '💬 ' : item.type === 'document' ? '📄 ' : '🖼️ ') + (item.name || '');
        run.phase = 'aguardando';
        run.nextAt = Date.now() + (pause + sim) * 1000;
        updateCountdowns();
        if (pause > 0) await wait(pause * 1000, run);
        run.msgN++;
        let mentionAll = false;
        if (mention) {
          if (mention.at === 'all') mentionAll = true;
          else if (mention.at === 'first') mentionAll = run.msgN === 1;
          else if (mention.at === 'last') mentionAll = depth === 0 && i === lastIdx;
          else if (mention.at === 'custom') mentionAll = (mention.list || []).map(Number).includes(run.msgN);
        }
        if (st.mention && /@g\.us$/.test(chatId)) mentionAll = true; // "@ todos" marcado nesta mensagem do post
        // boas-vindas / palavra-chave: marca só quem entrou / quem perguntou, na 1ª mensagem
        const mentionIds = !mentionAll && run.msgN === 1 && ctx.mentionIds && ctx.mentionIds.length ? ctx.mentionIds : undefined;
        await sendItem(chatId, item, ctx, run, { simulate, simSecs: sim, mentionAll, mentionIds });
      }
      return 'done';
    };
    try {
      await runSteps(funnel.steps, 0);
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
    // etiqueta da jornada (WhatsApp Business): o funil enviado define a etapa do lead
    if (ok && !isRmkt && !/@g\.us$/.test(chatId)) {
      const stages = [funnel.stage, run.branchStage].filter(Boolean);
      for (const stg of stages) await applyStage(chatId, stg, ctx, funnel.name).catch((e) => console.warn('[ZapFunil] etiqueta', e));
    }
    if (ok && !isRmkt) rmktEnqueue(chatId, funnelKey(funnel), ctx).catch((e) => console.warn('[ZapFunil] rmkt', e));
    // o funil/mensagem enviado pelo caminho "se responder / se não responder" também dispara o remarketing dele
    if (ok && !isRmkt && run.branchKey) rmktEnqueue(chatId, run.branchKey, ctx).catch((e) => console.warn('[ZapFunil] rmkt', e));
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
    if (isLeader && m.isGroup && !m.fromMe) gOnMessage(m);
    if (isLeader) leadOnMessage(m);
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

  // ---------------------------------------------------------------- GRUPOS (aba própria)
  // Posts = sequência de mensagens só para grupo (texto escrito no post, itens/funis do acervo, "@ todos" por mensagem).
  // Programação semanal com vários horários, listas de grupos, boas-vindas e resposta por palavra-chave.
  const WEEK = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  function gTargets(t) {
    const map = new Map();
    t = t || {};
    (t.groups || []).forEach((g) => g && g.id && map.set(g.id, g));
    (t.lists || []).forEach((lid) => {
      const l = (DB.gLists || []).find((x) => x.id === lid);
      (l ? l.groups || [] : []).forEach((g) => g && g.id && map.set(g.id, g));
    });
    return Array.from(map.values());
  }
  function gTargetHas(t, groupId) {
    if (!t) return false;
    if (t.all) return true;
    return gTargets(t).some((g) => g.id === groupId);
  }
  function postToFunnel(post) {
    const steps = [];
    for (const p of post.parts || []) {
      const delay = Math.max(0, Number(p.delay) || 0);
      if (p.kind === 'text') {
        if (!String(p.text || '').trim()) continue;
        steps.push({ inline: { id: 'inline', type: 'text', name: 'texto do post', text: p.text }, delay, simulate: p.simulate !== false, mention: !!p.mention });
      } else if (p.kind === 'item') {
        steps.push({ itemId: p.itemId, delay, simulate: p.simulate !== false, mention: !!p.mention });
      } else if (p.kind === 'funnel') {
        const f = getFunnel(p.funnelId);
        if (!f) continue;
        let first = true;
        f.steps.forEach((st, i) => {
          if (st.kind === 'wait_reply' || !st.itemId) return;
          // o intervalo do post vale antes da 1ª mensagem do funil; depois seguem os intervalos do próprio funil
          steps.push(Object.assign({}, st, { delay: first ? delay : st.delay, mention: first && !!p.mention }));
          first = false;
        });
      }
    }
    return { id: 'post-' + post.id, name: '👥 ' + post.name, steps };
  }
  function getPost(id) {
    return (DB.gPosts || []).find((p) => p.id === id) || null;
  }
  async function sendPostToGroups(post, groups, source, extra) {
    const fn = postToFunnel(post);
    const errors = [];
    if (!fn.steps.length) throw new Error('o post "' + post.name + '" está vazio');
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      try {
        await runFunnel(g.id, fn, Object.assign({ name: g.name || '', group: g.name || '', number: g.id }, extra || {}), source);
      } catch (e) {
        errors.push((g.name || 'grupo') + ': ' + e.message);
      }
      if (i < groups.length - 1) await sleep(rand(5, 12) * 1000);
    }
    return errors;
  }
  // horários vencidos de uma programação
  function gDue(s, now) {
    const out = [];
    if (s.mode === 'once') {
      if (s.at && s.at <= now && !s.doneAt) out.push({ key: 'once', late: false });
      return out;
    }
    const lateMs = Math.max(5, Number(s.lateMin) || 120) * 60000;
    for (const back of [0, 1]) {
      const d = new Date(now - back * 86400000);
      if (!(s.days || []).includes(d.getDay())) continue;
      for (const hm of s.times || []) {
        const [h, m] = String(hm).split(':').map(Number);
        if (!Number.isFinite(h)) continue;
        const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m || 0).getTime();
        if (at > now) continue;
        if (s.createdAt && at < s.createdAt) continue;
        const key = ZF.dayKey(at) + ' ' + hm;
        if ((s.done || {})[key]) continue;
        out.push({ key, late: now - at > lateMs });
      }
    }
    return out;
  }
  let gBusy = false;
  async function gTick() {
    if (!isLeader || !waReady || gBusy || !DB) return;
    gBusy = true;
    try {
      const now = Date.now();
      for (const s of (DB.gSchedules || []).slice()) {
        if (!s.enabled) continue;
        if (!s.now && !autoOn()) continue; // "Enviar agora" sai mesmo com as automações pausadas
        const due = gDue(s, now);
        if (!due.length) continue;
        // marca antes de enviar (nunca duplica, mesmo se a aba fechar no meio)
        await mutate('gSchedules', (list) => list.map((x) => {
          if (x.id !== s.id) return x;
          const y = Object.assign({}, x, { done: Object.assign({}, x.done || {}) });
          due.forEach((d) => (y.done[d.key] = d.late ? -1 : now));
          if (s.mode === 'once') y.doneAt = now;
          const cut = ZF.dayKey(now - 9 * 86400000);
          Object.keys(y.done).forEach((k) => { if (k !== 'once' && k < cut) delete y.done[k]; });
          return y;
        }));
        if (!due.some((d) => !d.late)) {
          await mutate('gSchedules', (list) => list.map((x) => (x.id === s.id ? Object.assign({}, x, { last: { at: now, ok: false, err: 'WhatsApp estava fechado no horário (passou do atraso máximo) — pulado' } }) : x)));
          continue;
        }
        const post = getPost(s.postId);
        const groups = gTargets(s.targets);
        let errs = [];
        if (!post) errs = ['post apagado'];
        else if (!groups.length) errs = ['nenhum grupo escolhido'];
        else errs = await sendPostToGroups(post, groups, 'grupo: programação');
        await mutate('gSchedules', (list) => list.map((x) => (x.id === s.id ? Object.assign({}, x, { last: { at: Date.now(), ok: !errs.length, err: errs.join(' · ') } }) : x)));
        if (errs.length) notifyPhone('error', '❌ Post de grupo falhou', (post ? post.name : 'post') + ': ' + errs.join(' · '), { tag: 'gsch-' + s.id });
      }
    } catch (e) {
      console.warn('[ZapFunil] grupos', e);
    } finally {
      gBusy = false;
    }
  }
  // boas-vindas: junta quem entrou num intervalo curto e manda uma vez só
  const gJoinBuf = new Map();
  function gOnJoin(e) {
    if (!isLeader || !DB || !autoOn()) return;
    const w = (DB.gAuto || {}).welcome;
    if (!w || !w.enabled || !w.postId || !gTargetHas(w.targets, e.groupId)) return;
    const b = gJoinBuf.get(e.groupId) || { ids: [], names: [], t: null };
    e.participants.forEach((p, i) => { if (!b.ids.includes(p)) { b.ids.push(p); b.names.push(e.names[i] || ''); } });
    clearTimeout(b.t);
    b.t = setTimeout(async () => {
      gJoinBuf.delete(e.groupId);
      const post = getPost(w.postId);
      if (!post) return;
      const g = await call('listGroups').then((l) => l.find((x) => x.id === e.groupId)).catch(() => null);
      const names = b.names.filter(Boolean);
      sendPostToGroups(post, [{ id: e.groupId, name: (g && g.name) || '' }], 'grupo: boas-vindas', {
        member: names.length ? names.join(', ') : '',
        mentionIds: w.mentionNew !== false ? b.ids : undefined
      }).catch(() => {});
    }, Math.max(3, Number(w.waitSec) || 20) * 1000);
    gJoinBuf.set(e.groupId, b);
  }
  // palavra-chave dentro do grupo
  const gKwLast = new Map();
  function gOnMessage(m) {
    if (!isLeader || !DB || !autoOn() || m.fromMe || !m.isGroup || m.type !== 'chat') return;
    if (m.t && Date.now() / 1000 - m.t > 180) return;
    const text = ZF.normalizeText(m.body || '');
    if (!text) return;
    for (const r of (DB.gAuto || {}).keywords || []) {
      if (!r.enabled || !r.postId || !gTargetHas(r.targets, m.chatId)) continue;
      const words = String(r.words || '').split(',').map((w) => ZF.normalizeText(w).trim()).filter(Boolean);
      const hit = words.some((w) => (r.match === 'exact' ? text === w : r.match === 'starts' ? text.startsWith(w) : (' ' + text + ' ').includes(w)));
      if (!hit) continue;
      const k = r.id + '|' + m.chatId;
      const cd = Math.max(0, Number(r.cooldownMin) || 10) * 60000;
      if (Date.now() - (gKwLast.get(k) || 0) < cd) continue;
      gKwLast.set(k, Date.now());
      const post = getPost(r.postId);
      if (!post) continue;
      sendPostToGroups(post, [{ id: m.chatId, name: m.name || '' }], 'grupo: palavra-chave', {
        member: m.authorName || '',
        mentionIds: r.mentionSender !== false && m.author ? [m.author] : undefined
      }).catch(() => {});
      break;
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
          const targets = (s.numbers || []).map((n) => ({ num: n })).concat((s.groups || []).map((g) => ({ group: g })));
          for (const t of targets) {
            try {
              if (t.group) {
                // grupo: manda direto no id do grupo; {nome} vira o nome do grupo
                await runFunnel(t.group.id, funnel, { name: s.useName || t.group.name || '', number: t.group.id, mention: s.mention && s.mention.on ? s.mention : null }, 'agendamento');
              } else {
                const r = await call('resolve', t.num);
                await runFunnel(r.id, funnel, { name: s.useName || r.name, number: r.id }, 'agendamento');
              }
            } catch (e) {
              errors.push((t.group ? '👥 ' + (t.group.name || 'grupo') : t.num) + ': ' + e.message);
            }
            if (targets.length > 1) await sleep(rand(4, 9) * 1000);
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
  // por que a campanha "rodando" não anda agora (vazio = está andando)
  function campWhy() {
    if (!DB) return 'carregando…';
    if (!waReady) return 'aguardando o WhatsApp carregar';
    if (DB.settings.automationsPaused) return 'automações pausadas — ligue o botão Auto';
    if (!isLeader) return localLeader ? 'o servidor 24h está no comando' : 'outra aba do WhatsApp está no comando — feche as outras abas';
    return '';
  }
  let campBusyAt = 0;
  const campContactMax = () => (Number(DB.settings.campContactMaxSec) || 360) * 1000;
  async function campaignTick() {
    try { renderCampBox(); } catch (e) {}
    if (!isLeader || !waReady || campaignBusy || !autoOn()) return;
    const camp = DB.campaigns.find((c) => c.status === 'running' && Array.isArray(c.contacts));
    if (!camp) return;
    campaignBusy = true;
    campBusyAt = Date.now();
    try {
      await processCampaign(camp.id);
    } catch (e) {
      console.warn('[ZapFunil] campanha', e);
      const err = (e && e.message) || String(e);
      await mutate('campaigns', (arr) => arr.map((c) => (c.id === camp.id ? Object.assign({}, c, { lastError: 'Erro: ' + err }) : c))).catch(() => {});
    } finally {
      campaignBusy = false;
      try { renderCampBox(); } catch (e) {}
    }
  }

  // cartão do disparo em massa dentro do painel ⚡ (ver progresso, pausar e retomar sem abrir o painel de controle)
  let campEl = null;
  async function campSet(id, status) {
    let msg = '';
    await mutate('campaigns', (arr) => arr.map((c) => {
      if (c.id !== id) return c;
      if (status === 'running') {
        if (arr.some((x) => x.status === 'running' && x.id !== id)) { msg = 'Outra campanha já está rodando'; return c; }
        msg = '▶ Campanha retomada';
        return Object.assign({}, c, { status: 'running', lastError: '' });
      }
      msg = '⏸ Campanha pausada';
      return Object.assign({}, c, { status: 'paused' });
    }));
    if (msg) toast(msg);
    renderCampBox();
    if (status === 'running') setTimeout(campaignTick, 300);
  }
  // reenviar só quem falhou: volta esses contatos para a fila (logo depois dos que já receberam)
  async function campRetry(id) {
    let n = 0;
    await mutate('campaigns', (arr) => arr.map((c) => {
      if (c.id !== id) return c;
      const r = ZF.campRetryFailed(c);
      n = r.n;
      return r.camp;
    }));
    toast(n ? '↻ ' + n + ' contato(s) voltaram para a fila' : 'Nenhuma falha para reenviar');
    renderCampBox();
  }
  function renderCampBox() {
    if (!campEl || !DB) return;
    const list = (DB.campaigns || []).filter((c) => Array.isArray(c.contacts) && (['running', 'paused', 'error'].includes(c.status) || (c.status === 'done' && c.failed && Date.now() - (c.finishedAt || 0) < 3 * 86400000)));
    const show = list.filter((c) => c.status === 'running').concat(list.filter((c) => c.status !== 'running').slice(-2).reverse());
    const sig = JSON.stringify(show.map((c) => [c.id, c.status, c.progress, c.sent, c.failed, c.nextAt, c.lastError])) + campWhy();
    if (campEl.dataset.sig === sig) return;
    campEl.dataset.sig = sig;
    campEl.innerHTML = '';
    campEl.style.display = show.length ? '' : 'none';
    for (const c of show) {
      const total = c.contacts.length;
      const done = c.progress || 0;
      const why = c.status === 'running' ? campWhy() : '';
      let line = done + '/' + total + ' · ✅ ' + (c.sent || 0) + ' · ❌ ' + (c.failed || 0);
      if (c.status === 'running' && !why && c.nextAt > Date.now()) line += ' · próximo ' + new Date(c.nextAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const tag = c.status === 'running' ? (why ? '· esperando' : '· rodando') : c.status === 'paused' ? '· pausada' : c.status === 'done' ? '· concluída' : '· erro';
      campEl.appendChild(el('div', { class: 'zf-camp-row', 'data-camp': c.id, 'data-status': c.status }, [
        el('span', { class: 'zf-run-txt' }, [
          el('span', { text: '🚀 ' + c.name + ' ' + tag }),
          el('span', { class: 'zf-camp-sub', text: line }),
          why || c.lastError ? el('span', { class: 'zf-camp-err', text: why || c.lastError }) : null
        ]),
        c.status !== 'running' && c.failed ? el('button', { class: 'zf-camp-re', title: 'Reenviar para quem falhou', onclick: () => campRetry(c.id) }, ['↻ Falhas']) : null,
        c.status === 'done'
          ? null
          : c.status === 'running'
          ? el('button', { class: 'zf-cancel', title: 'Pausar campanha', onclick: () => campSet(c.id, 'paused') }, ['Pausar'])
          : el('button', { class: 'zf-camp-go', title: 'Retomar campanha', onclick: () => campSet(c.id, 'running') }, ['▶ Retomar'])
      ]));
    }
  }

  async function getCampaign(id) {
    const { campaigns } = await chrome.storage.local.get('campaigns');
    return (campaigns || []).find((c) => c.id === id);
  }

  // variações do disparo: cada contato recebe uma, na ordem (A, B, C, A, B…)
  const VLETTER = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
  function campVariants(camp) {
    return (camp.variants || []).filter((v) => (v.kind === 'text' ? String(v.text || '').trim() : v.itemId || v.funnelId));
  }
  function variantFunnel(camp, v, i) {
    if (v.kind === 'text') return { id: 'camp-' + camp.id + '-' + i, name: camp.name + ' · variação ' + VLETTER(i), steps: [{ inline: { id: 'inline', type: 'text', name: 'variação ' + VLETTER(i), text: v.text }, delay: 0, simulate: true }] };
    if (v.kind === 'funnel') return getFunnel(v.funnelId);
    const it = getItem(v.itemId);
    return it ? funnelFromItem(it) : null;
  }
  async function processCampaign(id) {
    let camp = await getCampaign(id);
    if (!camp) return;
    const base = targetToFunnel(camp.targetType || 'funnel', camp.targetId || camp.funnelId);
    if (!campVariants(camp).length && !base) {
      await mutate('campaigns', (arr) => arr.map((c) => (c.id === id ? Object.assign({}, c, { status: 'error', lastError: 'Nenhuma mensagem para enviar (crie uma variação)' }) : c)));
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
      const vars = campVariants(camp);
      let funnel = base;
      if (vars.length) {
        const vi = idx % vars.length;
        result.v = VLETTER(vi);
        funnel = variantFunnel(camp, vars[vi], vi);
      }
      try {
        if (!funnel) throw new Error('mensagem da variação ' + (result.v || '') + ' foi apagada');
        const r = await call('resolve', contact.number);
        // um funil com "aguardar resposta" (ou travado) não pode segurar a campanha inteira:
        // depois de 6 min a campanha segue para o próximo e o funil continua em 2º plano
        let slow = null;
        const ok = await Promise.race([
          runFunnel(r.id, funnel, { name: contact.name || r.name, number: r.id }, 'campanha: ' + camp.name),
          new Promise((res) => { slow = setTimeout(() => res('slow'), campContactMax()); })
        ]).finally(() => clearTimeout(slow));
        if (ok === false) throw new Error('envio cancelado');
        if (ok === 'slow') result.err = 'funil ainda rodando (segue em 2º plano)';
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

  // ---------------------------------------------------------------- JORNADA / ETIQUETAS
  // leads: { chatId: { name, stages: { jornada(:etapa p/ multi): { stage, since } }, path: [{ s, t }], lastOut, lastIn, lastFunnel, updatedAt } }
  async function applyStage(chatId, stage, ctx, why) {
    if (!stage) return;
    const plan = ZF.stagePlan(DB.settings, stage);
    let labelErr = '';
    if (DB.settings.labelsOn !== false) {
      try {
        await call('applyLabels', chatId, plan.add, plan.remove);
      } catch (e) {
        labelErr = (e && e.message) || String(e);
        console.warn('[ZapFunil] etiqueta', labelErr);
      }
    }
    const now = Date.now();
    const js = ZF.journeys(DB.settings);
    let changed = false;
    await mutate('leads', (L) => {
      const l = Object.assign({ stages: {}, path: [] }, L[chatId] || {});
      l.stages = Object.assign({}, l.stages);
      // tira as etapas que esta entrada limpa
      for (const k of Object.keys(l.stages)) if (plan.remove.includes(l.stages[k].stage)) delete l.stages[k];
      const j = js.find((x) => x.id === plan.journey);
      const key = j ? (j.multi ? j.id + ':' + stage : j.id) : 'outros:' + stage;
      if (!l.stages[key] || l.stages[key].stage !== stage) {
        l.stages[key] = { stage, since: now };
        l.path = (l.path || []).concat([{ s: stage, t: now }]).slice(-40);
        changed = true;
      }
      if (ctx && ctx.name) l.name = ctx.name;
      l.lastOut = now;
      l.lastFunnel = why || l.lastFunnel || '';
      l.updatedAt = now;
      if (labelErr) l.labelErr = labelErr;
      else delete l.labelErr;
      L[chatId] = l;
      // limite de tamanho: mantém os 4000 mais recentes
      const ids = Object.keys(L);
      if (ids.length > 4000) ids.sort((a, b) => (L[a].updatedAt || 0) - (L[b].updatedAt || 0)).slice(0, ids.length - 4000).forEach((id) => delete L[id]);
      return L;
    });
    // remarketing por etiqueta: entrou nesta etapa → começa o dela e para o das outras
    if (changed) {
      await rmktOnOtherFunnel(chatId, 'label:' + stage).catch(() => {});
      await rmktEnqueue(chatId, 'label:' + stage, ctx || {}).catch(() => {});
    }
  }
  const leadSeen = new Map();
  function leadOnMessage(m) {
    if (m.isGroup || !DB.leads || !DB.leads[m.chatId]) return;
    if (m.fromMe && isBotEcho(m.chatId)) return;
    const k = m.chatId + (m.fromMe ? ':o' : ':i');
    if (Date.now() - (leadSeen.get(k) || 0) < 15000) return;
    leadSeen.set(k, Date.now());
    mutate('leads', (L) => {
      if (!L[m.chatId]) return L;
      L[m.chatId] = Object.assign({}, L[m.chatId], m.fromMe ? { lastOut: Date.now() } : { lastIn: Date.now() }, { updatedAt: Date.now() });
      return L;
    }).catch(() => {});
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
    if (entry.mode === 'on_reply' && !entry.gotReply) return null; // aguardando o lead responder
    return entry.baseAt + (Number(st.delay) || 0) * 1000;
  }
  const ACTIVE = (e) => e.status === 'waiting' || e.status === 'sending';
  // "Se responder": prazo para o lead responder (0 = sem prazo)
  function replyExpire(rule, now) {
    const h = rule.replyWindowHours == null ? 72 : Number(rule.replyWindowHours) || 0;
    return h > 0 ? now + h * 3600000 : null;
  }

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
        if (entry.mode === 'on_reply') {
          entry.gotReply = false;
          entry.expireAt = replyExpire(rule, now);
        }
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
      bumpStats((d) => inc(d, 'optout'));
      return;
    }
    if (!(DB.rmktQueue || []).some((e) => e.chatId === m.chatId && ACTIVE(e))) return;
    const ownEcho = m.fromMe && isBotEcho(m.chatId);
    if (ownEcho) return; // mensagem enviada pela própria extensão
    let replies = 0;
    await mutate('rmktQueue', (q) =>
      q.map((e) => {
        if (e.chatId !== m.chatId || !ACTIVE(e)) return e;
        const rule = getRule(e.ruleId);
        if (!rule) return e;
        // chegou mensagem enquanto uma etapa estava sendo enviada: guarda para aplicar logo depois
        if (e.status === 'sending') return Object.assign({}, e, { midMsgs: (e.midMsgs || []).concat([{ fromMe: !!m.fromMe, t: now }]) });
        const n = applyMsg(rule, e, !!m.fromMe, now);
        if (!m.fromMe && ((n.status === 'replied' && e.status !== 'replied') || (e.mode === 'on_reply' && !e.gotReply && n.gotReply))) replies++;
        return n;
      })
    );
    if (replies) bumpStats((d) => inc(d, 'replied'));
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
        if (e.mode === 'on_reply') {
          // se responder: a resposta do lead agenda a próxima etapa (conta da última mensagem dele)
          if (!fromMe) {
            n.gotReply = true;
            n.baseAt = now;
            n.lastFromMe = false;
            n.dueAt = stageDueAt(rule, n);
            return n;
          }
          // você respondeu na mão depois que o lead respondeu: não atropela sua conversa
          if (e.gotReply && rule.stopOnManual !== false) return Object.assign(n, { status: 'cancelled', reason: 'você respondeu manualmente', endedAt: now, dueAt: null });
          return e;
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
    // "Se responder": lead não respondeu dentro do prazo → encerra
    if ((DB.rmktQueue || []).some((e) => e.status === 'waiting' && e.mode === 'on_reply' && !e.gotReply && e.expireAt && e.expireAt <= now)) {
      await mutate('rmktQueue', (q) => q.map((e) => (e.status === 'waiting' && e.mode === 'on_reply' && !e.gotReply && e.expireAt && e.expireAt <= Date.now() ? Object.assign({}, e, { status: 'expired', reason: e.stageIdx ? 'lead não respondeu mais' : 'lead não respondeu no prazo', endedAt: Date.now(), dueAt: null }) : e)));
    }
    // fim do remarketing sem resposta → etiqueta Frio
    const cold = (DB.rmktQueue || []).filter((e) => e.coldAt && !e.coldDone && e.coldAt <= now);
    for (const e of cold) {
      const lead = (DB.leads || {})[e.chatId];
      const replied = lead && lead.lastIn && lead.lastIn > (e.endedAt || e.createdAt);
      await mutate('rmktQueue', (q) => q.map((x) => (x.id === e.id ? Object.assign({}, x, { coldDone: true }) : x)));
      if (!replied) await applyStage(e.chatId, ZF.coldStage(DB.settings), { name: e.name }, 'sem resposta no remarketing').catch(() => {});
    }
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
    if (out.mode === 'on_reply') {
      out.gotReply = false; // próxima etapa só depois de uma nova resposta
      out.expireAt = replyExpire(rule, now);
    }
    // mensagens que chegaram enquanto a etapa era enviada contam como "depois do envio"
    for (const mm of x.midMsgs || []) {
      if (out.status !== 'waiting') break;
      out = applyMsg(rule, out, mm.fromMe, Math.max(mm.t, now));
    }
    if (out.status !== 'waiting') return out;
    if (out.stageIdx >= rule.stages.length) {
      const done = Object.assign(out, { status: 'done', reason: 'sequência concluída', dueAt: null, endedAt: now });
      // "se não responder até o fim, marcar Frio" depois de X horas
      if (rule.coldOnEnd) done.coldAt = now + (Number(rule.coldHours) || 24) * 3600000;
      return done;
    }
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
  let root, listEl, runEl, statusDot, searchEl, fabCd, folderEl;
  let panelFolder = '';
  let mentionEl = null;
  let panelMention = { at: 'none', list: [] };
  let activeGroup = null; // grupo aberto agora (para mostrar os posts de grupo no ⚡)
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

  // Depois de atualizar a extensão (↻), esta aba fica com o código antigo "desligado" até dar F5
  function extAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }
  let reloadBanner = null;
  function showReloadBanner() {
    if (reloadBanner) return;
    reloadBanner = el('div', { class: 'zf-reload' }, [
      el('span', { text: '⚡ A ZapFunil foi atualizada. Aperte F5 para continuar usando (o WhatsApp não desconecta).' }),
      el('button', { text: 'Recarregar agora', onclick: () => location.reload() })
    ]);
    document.body.appendChild(reloadBanner);
  }
  setInterval(() => {
    if (!extAlive()) showReloadBanner();
  }, 5000);
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
    // contador abaixo do ⚡ quando tem envio rodando
    fabCd = el('div', { class: 'zf-fabcd', onclick: () => togglePanel() });

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
    folderEl = el('select', { class: 'zf-folder', title: 'Pasta', onchange: () => {
      panelFolder = folderEl.value;
      chrome.storage.local.set({ panelFolder });
      renderList();
    } });
    chrome.storage.local.get('panelFolder').then((d) => { panelFolder = d.panelFolder || ''; renderList(); });
    // grupo aberto: marcar todos (oculto) nos envios manuais
    const mSel = el('select', { class: 'zf-m-sel', onchange: () => saveMention() }, [['none', 'Não marcar'], ['first', 'Na 1ª mensagem'], ['last', 'Na última'], ['all', 'Em todas'], ['custom', 'Escolher…']].map(([v, t]) => el('option', { value: v, text: t })));
    const mList = el('input', { class: 'zf-m-list', placeholder: 'ex: 2', oninput: () => saveMention() });
    const saveMention = () => {
      panelMention = { at: mSel.value, list: String(mList.value || '').split(/[^\d]+/).map(Number).filter((x) => x > 0) };
      mList.style.display = mSel.value === 'custom' ? '' : 'none';
      mentionEl.classList.toggle('zf-m-on', mSel.value !== 'none');
      chrome.storage.local.set({ panelMention });
    };
    mentionEl = el('div', { class: 'zf-mention', title: 'Notifica todos os membros sem aparecer @ no texto' }, [el('span', { text: '👥 Marcar todos:' }), mSel, mList]);
    mentionEl.style.display = 'none';
    chrome.storage.local.get('panelMention').then((d) => {
      if (d.panelMention) panelMention = d.panelMention;
      mSel.value = panelMention.at || 'none';
      mList.value = (panelMention.list || []).join(', ');
      mList.style.display = mSel.value === 'custom' ? '' : 'none';
      mentionEl.classList.toggle('zf-m-on', mSel.value !== 'none');
    });
    setInterval(async () => {
      if (!root || !root.classList.contains('zf-open') || !waReady) return;
      const chat = await call('activeChat').catch(() => null);
      mentionEl.style.display = chat && chat.isGroup ? '' : 'none';
      const g = chat && chat.isGroup ? chat.id : null;
      if (g !== (activeGroup && activeGroup.id)) {
        activeGroup = g ? chat : null;
        renderList();
      }
    }, 1500);
    listEl = el('div', { class: 'zf-list' });
    runEl = el('div', { class: 'zf-running' });
    campEl = el('div', { class: 'zf-camp' });
    campEl.style.display = 'none';

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
      folderEl,
      mentionEl,
      tabBar,
      campEl,
      runEl,
      listEl,
      el('div', { class: 'zf-foot' }, [
        el('span', { text: 'Clique para enviar no chat aberto' }),
        el('button', { class: 'zf-link', id: 'zf-showbar', onclick: () => window.__zfShowBar && window.__zfShowBar() }, ['Mostrar barra no chat'])
      ])
    ]);
    root.appendChild(panel);
    root.appendChild(fab);
    root.appendChild(fabCd);
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

  var panelOpen = new Set(); // itens/funis abertos (▸) no painel
  function renderList() {
    if (!listEl || !DB) return;
    const q = ZF.normalizeText(searchEl.value).replace(/^\//, '');
    listEl.innerHTML = '';
    // pastas: o seletor só aparece se você criou alguma pasta no painel de controle
    const fl = ZF.folders((DB.items || []).concat(DB.funnels || []));
    if (folderEl) {
      if (panelFolder && panelFolder !== '__none' && !fl.includes(panelFolder)) panelFolder = '';
      folderEl.style.display = fl.length ? '' : 'none';
      const opts = [['', '📁 Todas as pastas']].concat(fl.map((f) => [f, '📁 ' + f]), [['__none', 'Sem pasta']]);
      const sig = opts.map((o) => o[0]).join('|');
      if (folderEl.dataset.sig !== sig) {
        folderEl.innerHTML = '';
        opts.forEach(([v, t]) => folderEl.appendChild(el('option', { value: v }, [t])));
        folderEl.dataset.sig = sig;
      }
      folderEl.value = panelFolder;
    }
    const inFolder = (o) => !fl.length || !panelFolder || (panelFolder === '__none' ? !String(o.folder || '').trim() : String(o.folder || '').trim() === panelFolder);
    if (activeTab === 'rmkt') return renderRmktTab(q);
    // grupo aberto: posts de grupo primeiro
    let shownPosts = 0;
    if (activeGroup && activeTab === 'all') {
      const posts = (DB.gPosts || []).filter((p) => !q || ZF.normalizeText(p.name).includes(q));
      if (posts.length) {
        listEl.appendChild(el('div', { class: 'zf-group', text: '👥 Envios de grupo salvos' }));
        shownPosts = posts.length;
        posts.forEach((p) => {
          const parts = p.parts || [];
          const sub = parts.length + ' mensagem(ns)' + (parts.some((x) => x.mention) ? ' · @ todos' : '');
          listEl.appendChild(el('button', { class: 'zf-row zf-row-post', title: 'Enviar este post no grupo aberto', onclick: async () => {
            const chat = await call('activeChat').catch(() => null);
            if (!chat || !chat.isGroup) return toast('Abra o grupo primeiro', 'warn');
            toast('👥 Enviando "' + p.name + '" em ' + (chat.name || 'grupo') + '…');
            sendPostToGroups(p, [{ id: chat.id, name: chat.name || '' }], 'grupo: manual').then((errs) => errs.length && toast('❌ ' + errs.join(' · '), 'warn')).catch((e) => toast('❌ ' + e.message, 'warn'));
          } }, [
            el('span', { class: 'zf-row-icon', text: '👥' }),
            el('span', { class: 'zf-row-main' }, [el('span', { class: 'zf-row-name', text: p.name }), el('span', { class: 'zf-row-sub', text: sub })])
          ]));
        });
      }
    }
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
        const o = r.obj;
        if (!inFolder(o)) return false;
        if (!q) return true;
        return ZF.normalizeText([o.name, o.shortcut, o.text, o.caption, o.folder].join(' ')).includes(q);
      })
      .sort((a, b) => a.g - b.g || a.i - b.i);
    if (!filtered.length && shownPosts) return;
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
      const key = r.kind + ':' + o.id;
      const open = panelOpen.has(key);
      const row = el('div', { class: 'zf-rowwrap' + (open ? ' zf-open-row' : '') }, [
        el('button', { class: 'zf-row', title: 'Enviar (pede confirmação)', onclick: () => confirmAndSend({ kind: r.kind, obj: o }) }, [
          el('span', { class: 'zf-row-icon', text: icon }),
          el('span', { class: 'zf-row-main' }, [
            el('span', { class: 'zf-row-name' }, [o.name || '(sem nome)', o.shortcut ? el('em', { text: ' /' + o.shortcut }) : null]),
            el('span', { class: 'zf-row-sub', text: sub })
          ])
        ]),
        el('button', { class: 'zf-row-exp', title: open ? 'Fechar' : r.kind === 'funnel' ? 'Ver mensagens do funil' : 'Ver conteúdo', onclick: () => {
          if (open) panelOpen.delete(key);
          else panelOpen.add(key);
          renderList();
        } }, [open ? '▾' : '▸'])
      ]);
      listEl.appendChild(row);
      if (open) listEl.appendChild(r.kind === 'funnel' ? funnelStepsEl(o) : itemPreviewEl(o));
    });
  }
  // aberto no painel: mensagens do funil numeradas, cada uma com "▶ daqui" (envia dela para baixo)
  function funnelStepsEl(f, onPick) {
    const box = el('div', { class: 'zf-steps' });
    f.steps.forEach((st, i) => {
      const inf = stepInfo(st);
      box.appendChild(el('div', { class: 'zf-step' + (inf.send ? '' : ' zf-step-wait') }, [
        el('span', { class: 'zf-step-n', text: String(i + 1) }),
        el('span', { class: 'zf-step-ic', text: inf.icon }),
        el('span', { class: 'zf-step-main' }, [el('span', { class: 'zf-step-name', text: inf.name }), inf.sub ? el('span', { class: 'zf-step-sub', text: inf.sub }) : null]),
        inf.send ? el('button', { class: 'zf-step-go', title: 'Enviar a partir desta mensagem (ela e as de baixo)', onclick: (e) => {
          e.stopPropagation();
          if (onPick) onPick();
          confirmAndSend({ kind: 'funnel', obj: f, fromStep: i });
        } }, [i ? '▶ daqui' : '▶ tudo']) : null
      ]));
    });
    return box;
  }
  function itemPreviewEl(it) {
    const txt = it.type === 'text' ? it.text || '' : it.type === 'audio' ? '🎤 Áudio de ' + ZF.fmtDuration(it.duration) + (it.asFile ? ' (como arquivo)' : ' (como gravado na hora)') : (it.caption ? 'Legenda: ' + it.caption : ZF.typeLabel(it.type)) + (it.filename ? ' · ' + it.filename : '');
    return el('div', { class: 'zf-steps zf-prev' }, [el('div', { class: 'zf-prev-txt', text: txt }), el('button', { class: 'zf-step-go', onclick: () => confirmAndSend({ kind: 'item', obj: it }) }, ['▶ enviar'])]);
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
          el('span', { class: 'zf-row-sub', text: r.stages.length + ' etapa(s) · ' + (r.mode === 'inactive' ? 'conversa parada' : r.mode === 'on_reply' ? 'se responder' : 'se não responder') })
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
        el('span', { class: 'zf-run-txt' }, [
          el('span', { text: '▶ ' + run.label + ' → ' + run.name + ' (' + run.step + '/' + run.total + ')' }),
          el('span', { class: 'zf-cd', 'data-chat': chatId, text: cdText(run) })
        ]),
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
    updateCountdowns();
  }

  function fmtLeft(ms) {
    const t = Math.max(0, Math.ceil(ms / 1000));
    if (t < 60) return t + 's';
    if (t < 3600) return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
    return Math.floor(t / 3600) + 'h' + String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  }
  function cdText(run) {
    const left = run.nextAt ? run.nextAt - Date.now() : null;
    const what = run.nextLabel ? ' ' + run.nextLabel : '';
    if (run.phase === 'enviando') return '⬆️ enviando' + what + '…';
    if (run.phase === 'gravando') return '🎙️ gravando… sai em ' + fmtLeft(left);
    if (run.phase === 'digitando') return '✍️ digitando… sai em ' + fmtLeft(left);
    if (run.phase === 'resposta') return '💬 esperando resposta' + (left != null ? ' (até ' + fmtLeft(left) + ')' : '');
    if (left != null) return '⏱ próxima em ' + fmtLeft(left) + what;
    return '';
  }
  // Atualiza só os contadores (1x por segundo), sem redesenhar a lista
  function updateCountdowns() {
    try {
      if (runEl) {
        for (const sp of runEl.querySelectorAll('.zf-cd')) {
          const run = running.get(sp.dataset.chat);
          if (run) sp.textContent = cdText(run);
        }
      }
      if (!fabCd) return;
      const runs = Array.from(running.values());
      if (!runs.length) {
        fabCd.classList.remove('zf-show');
        return;
      }
      const soon = runs.filter((r) => r.nextAt).sort((a, b) => a.nextAt - b.nextAt)[0];
      let txt = '';
      if (soon && soon.phase === 'enviando') txt = '⬆️';
      else if (soon && soon.phase === 'gravando') txt = '🎙️ ' + fmtLeft(soon.nextAt - Date.now());
      else if (soon && soon.phase === 'digitando') txt = '✍️ ' + fmtLeft(soon.nextAt - Date.now());
      else if (soon && soon.phase === 'resposta') txt = '💬';
      else if (soon) txt = fmtLeft(soon.nextAt - Date.now());
      else txt = '•••';
      fabCd.textContent = txt + (runs.length > 1 ? ' ·' + runs.length : '');
      fabCd.title = runs.map((r) => r.label + ' → ' + r.name + ': ' + cdText(r)).join('\n');
      fabCd.classList.add('zf-show');
    } catch (e) {}
  }

  // "enviar a partir da mensagem N": mesmo funil (mesmo id → etiqueta e remarketing iguais), começando da etapa N
  function partialFunnel(f, k) {
    const steps = f.steps.slice(k).map((st, i) => (i === 0 ? Object.assign({}, st, { delay: 0 }) : st));
    return Object.assign({}, f, { steps, name: f.name + ' (da ' + (k + 1) + 'ª em diante)' });
  }
  // linha de cada etapa do funil (para o funil aberto no painel/barra e no celular)
  function stepInfo(st) {
    if (st.kind === 'wait_reply') return { icon: '⏳', name: 'Aguardar resposta' + (st.timeoutMin ? ' (até ' + st.timeoutMin + ' min)' : ''), sub: '', send: false };
    const it = st.inline || getItem(st.itemId);
    if (!it) return { icon: '⚠️', name: '(item apagado)', sub: '', send: false };
    const sub = it.type === 'text' ? ZF.applyVars(it.text || '', {}).slice(0, 90) : it.type === 'audio' ? 'Áudio ' + ZF.fmtDuration(it.duration) : it.caption ? it.caption.slice(0, 60) : ZF.typeLabel(it.type);
    return { icon: ZF.typeIcon(it.type), name: it.name || '', sub: sub + (st.delay ? ' · espera ' + ZF.fmtDelay(st.delay) : ''), send: true };
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
    const funnel = r.kind === 'funnel' ? (r.fromStep ? partialFunnel(r.obj, r.fromStep) : r.obj) : funnelFromItem(r.obj);
    const queued = running.has(chat.id);
    toast(queued ? '⏳ Na fila: ' + funnel.name : (r.kind === 'funnel' ? 'Funil iniciado: ' : 'Enviando: ') + funnel.name);
    try {
      const ctx = { name: chat.name, number: chat.id };
      if (chat.isGroup && panelMention.at && panelMention.at !== 'none') ctx.mention = panelMention;
      await runFunnel(chat.id, funnel, ctx, 'manual');
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
      r.fromStep ? el('div', { class: 'zf-c-from', text: '▶ a partir da mensagem ' + (r.fromStep + 1) + ' (' + (r.obj.steps.length - r.fromStep) + ' de ' + r.obj.steps.length + ')' }) : null,
      el('div', { class: 'zf-c-sub', text: 'para ' + (chat.name || chat.id.replace(/@.*/, '')) + (running.has(chat.id) ? ' · entra na fila' : '') }),
      el('div', { class: 'zf-c-btns' }, [el('button', { class: 'zf-c-no', onclick: closeConfirm }, ['Cancelar']), btnOk])
    ]);
    if (footer) {
      confirmEl.style.left = Math.max(12, rect.left + 16) + 'px';
      confirmEl.style.bottom = Math.min(window.innerHeight - 140, Math.max(12, window.innerHeight - rect.top + 8)) + 'px';
    } else {
      confirmEl.style.left = Math.max(12, window.innerWidth / 2 - 160) + 'px';
      confirmEl.style.bottom = '90px';
    }
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
    if (confirmEl && !confirmEl.contains(e.target) && !e.target.closest('.zf-chip,.zf-sug-row,.zf-row,.zf-step-go,.zf-pop')) closeConfirm();
  }, true);

  // ---- barra abaixo da caixa de mensagem
  let barHidden = false;
  chrome.storage.local.get('barHidden').then((d) => {
    barHidden = !!d.barHidden;
    ensureBar();
  });
  // filtro discreto da barra (☰): Tudo (padrão), só funis, só mensagens…
  let barFilter = 'all';
  chrome.storage.local.get('barFilter').then((d) => {
    if (d.barFilter) {
      barFilter = d.barFilter;
      barSig = '';
      ensureBar();
    }
  });
  const BAR_FILTERS = [['all', '✨ Tudo'], ['funnel', '🔁 Funis'], ['text', '💬 Mensagens'], ['audio', '🎤 Áudios'], ['media', '🖼️ Mídias'], ['document', '📄 Documentos']];
  const barPass = (r) => barFilter === 'all' || (barFilter === 'funnel' ? r.kind === 'funnel' : r.kind === 'item' && (barFilter === 'media' ? r.obj.type === 'image' || r.obj.type === 'video' : r.obj.type === barFilter));
  let popEl = null;
  function closePop() {
    if (popEl) popEl.remove();
    popEl = null;
  }
  function openPop(anchor, content) {
    closePop();
    const rc = anchor.getBoundingClientRect();
    popEl = el('div', { class: 'zf-pop' }, [content]);
    document.body.appendChild(popEl);
    const w = popEl.offsetWidth;
    popEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, rc.left)) + 'px';
    popEl.style.bottom = window.innerHeight - rc.top + 8 + 'px';
  }
  document.addEventListener('mousedown', (e) => {
    if (popEl && !popEl.contains(e.target) && !e.target.closest('.zf-bar-menu,.zf-chip-more')) closePop();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popEl) closePop();
  }, true);
  function buildBar() {
    const bar = el('div', { class: 'zf-bar', id: 'zf-bar' });
    const scroller = el('div', { class: 'zf-bar-scroll' });
    const entries = allEntries().filter(barPass);
    let lastG = -1;
    entries.forEach((r) => {
      if (r.g !== lastG && lastG !== -1) scroller.appendChild(el('span', { class: 'zf-bar-sep' }));
      lastG = r.g;
      const isF = r.kind === 'funnel';
      const chip = el('button', { class: 'zf-chip zf-chip-' + (isF ? 'funnel' : r.obj.type), title: (r.obj.type === 'text' ? r.obj.text : r.obj.name) || '', onclick: () => confirmAndSend(r) }, [
        el('span', { class: 'zf-chip-ic', text: entryIcon(r) }),
        el('span', { text: r.obj.name || '(sem nome)' }),
        isF ? el('span', { class: 'zf-chip-more', title: 'Ver mensagens / enviar a partir de uma', onclick: (e) => {
          e.stopPropagation();
          e.preventDefault();
          openPop(chip, el('div', {}, [el('div', { class: 'zf-pop-head', text: '🔁 ' + r.obj.name + ' · clique em ▶ para enviar daquela em diante' }), funnelStepsEl(r.obj, closePop)]));
        } }, ['▾']) : null
      ]);
      scroller.appendChild(chip);
    });
    if (!entries.length) scroller.appendChild(el('span', { class: 'zf-bar-empty', text: barFilter !== 'all' ? 'Nada nesse filtro — toque em ☰ para mudar' : 'Crie mensagens e funis no painel ⚙️ para aparecerem aqui' }));
    scroller.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        scroller.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
    bar.appendChild(el('button', { class: 'zf-bar-logo', title: 'Abrir painel ZapFunil', onclick: () => { if (!root.classList.contains('zf-open')) togglePanel(); } }, ['⚡']));
    const menuBtn = el('button', { class: 'zf-bar-menu' + (barFilter !== 'all' ? ' zf-on' : ''), title: 'Filtrar a barra', onclick: () => {
      openPop(menuBtn, el('div', { class: 'zf-pop-menu' }, BAR_FILTERS.map(([k, t]) => el('button', { class: 'zf-pop-opt' + (k === barFilter ? ' zf-on' : ''), onclick: () => {
        barFilter = k;
        chrome.storage.local.set({ barFilter: k });
        closePop();
        barSig = '';
        ensureBar();
      } }, [t]))));
    } }, [barFilter === 'all' ? '☰' : (BAR_FILTERS.find((x) => x[0] === barFilter) || ['', '☰'])[1].split(' ')[0]]);
    bar.appendChild(menuBtn);
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
    const sig = JSON.stringify([barFilter, DB.funnels.map((f) => [f.id, f.name, f.steps.length]), DB.items.map((i) => [i.id, i.name, i.type])]);
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
        if (!extAlive() || /context invalidated/i.test(e.message || '')) {
          showReloadBanner();
          return (err.textContent = 'A extensão foi atualizada: aperte F5 nesta página e salve de novo.');
        }
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
        // venda não expira em 15 min: fica guardada até o WhatsApp abrir (até 3 dias)
        const maxAge = cmd.kind === 'purchase' ? 3 * 86400000 : CMD_MAX_AGE;
        if (Date.now() - new Date(cmd.created_at).getTime() > maxAge) throw new Error('Expirou: o Mac/WhatsApp Web estava offline quando você mandou');
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

  // ---------------------------------------------------------------- VENDAS (Kiwify / Hubla)
  // produto → tipo de aluno pelas regras (texto no nome do produto)
  function saleKind(product) {
    const sales = Object.assign({}, ZF.DEFAULT_SETTINGS.sales, DB.settings.sales || {});
    const n = ZF.normalizeText(product || '');
    for (const r of sales.rules || []) {
      const m = ZF.normalizeText(r.match || '');
      if (m && n.includes(m)) return r.kind;
    }
    return '';
  }
  const SALE_STAGE = { apex: 'Aluno APEX', afiliado: 'Aluno Afiliado', nova: 'Aluno NOVA' };
  async function salesLogPush(e) {
    await mutate('salesLog', (arr) => [Object.assign({ t: Date.now() }, e)].concat(Array.isArray(arr) ? arr : []).slice(0, 300)).catch(() => {});
  }
  async function handlePurchase(p) {
    const sales = Object.assign({}, ZF.DEFAULT_SETTINGS.sales, DB.settings.sales || {});
    const kind = saleKind(p.product);
    const who = (p.name || '') + ' · ' + (p.product || '');
    if (sales.enabled === false) {
      await salesLogPush({ name: p.name, product: p.product, phone: p.phone, src: p.src, ok: true, note: 'vendas desligadas' });
      return 'Venda recebida (automação de vendas desligada)';
    }
    if (!kind || kind === 'ignorar') {
      await salesLogPush({ name: p.name, product: p.product, phone: p.phone, src: p.src, ok: true, note: 'produto sem regra — nada enviado' });
      return 'Venda recebida: ' + who + ' (produto sem regra, nada enviado)';
    }
    // a mesma venda não roda 2x (e order bump do mesmo produto em seguida não repete as boas-vindas)
    const log = (await chrome.storage.local.get('salesLog')).salesLog || [];
    if (p.orderId && log.some((x) => x.orderId === p.orderId && x.src === p.src && x.ok)) return 'Venda já processada';
    // já comprou esse tipo antes (renovação da assinatura, order bump, upgrade): só garante a etiqueta, sem repetir boas-vindas/grupo
    const recent = !!p.renewal || log.some((x) => x.phone === p.phone && x.kind === kind && x.ok && x.note && !/sem regra|desligadas/.test(x.note));
    const c = await resolveTarget(p.phone);
    const name = p.name || c.name || '';
    const ctx = { name, number: c.id };
    const steps = [];
    const errs = [];
    // 1) etiqueta de aluno (tira as de venda) + para o remarketing de venda
    try {
      await applyStage(c.id, SALE_STAGE[kind], ctx, 'venda ' + (p.src || ''));
      steps.push('🏷️ ' + SALE_STAGE[kind]);
    } catch (e) {
      errs.push('etiqueta: ' + e.message);
    }
    if (sales.stopRmkt !== false) await rmktStopChat(c.id).catch(() => {});
    // 2) boas-vindas
    const w = (sales.welcome || {})[kind];
    if (w && !recent) {
      const [tt, ...rest] = String(w).split(':');
      const f = targetToFunnel(tt, rest.join(':'));
      if (!f) errs.push('boas-vindas não existe mais');
      else {
        try {
          await runFunnel(c.id, f, ctx, 'venda: ' + (p.product || kind));
          steps.push('💬 boas-vindas');
        } catch (e) {
          errs.push('boas-vindas: ' + e.message);
        }
      }
    }
    // 3) NOVA: grupo de alunos (adiciona; se a privacidade não deixar, manda o link no privado)
    if (kind === 'nova' && sales.addToGroup !== false && sales.novaGroupId && !recent) {
      try {
        const g = await call('groupAddOrInvite', sales.novaGroupId, c.id);
        steps.push(g.added ? '👥 adicionado ao grupo' : g.already ? '👥 já estava no grupo' : '🔗 link do grupo enviado');
      } catch (e) {
        errs.push('grupo: ' + e.message);
      }
    }
    if (recent) steps.push('já era aluno — sem repetir boas-vindas' + (kind === 'nova' ? '/grupo' : ''));
    const ok = !errs.length;
    await salesLogPush({ name, product: p.product, phone: p.phone, chatId: c.id, src: p.src, orderId: p.orderId, kind, ok, note: steps.join(' · ') + (errs.length ? ' ⚠️ ' + errs.join(' · ') : '') });
    logHistory({ chatId: c.id, name, what: '💰 Venda: ' + (p.product || kind), source: 'venda ' + (p.src || ''), ok, err: errs.join(' · ') });
    notifyPhone(ok ? 'msg' : 'error', ok ? '💰 Nova venda' : '⚠️ Venda com erro', who + (ok ? ' — ' + steps.join(', ') : ' — ' + errs.join(' · ')), { tag: 'sale-' + (p.orderId || c.id), url: './#c=' + encodeURIComponent(c.id) });
    if (!ok) throw new Error(errs.join(' · '));
    return 'Venda: ' + who + ' → ' + steps.join(', ');
  }

  async function runCommand(cmd) {
    const p = cmd.payload || {};
    switch (cmd.kind) {
      case 'purchase':
        return handlePurchase(p);
      case 'send': {
        let funnel = targetToFunnel(p.targetType, p.targetId);
        if (!funnel) throw new Error('Funil/item não existe mais');
        const from = Math.max(0, parseInt(p.fromStep, 10) || 0);
        if (from && p.targetType === 'funnel' && from < funnel.steps.length) funnel = partialFunnel(funnel, from);
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
      funnels: DB.funnels.map((f) => ({ id: f.id, name: f.name, steps: f.steps.length, list: f.steps.map((st) => { const x = stepInfo(st); return { i: x.icon, n: x.name.slice(0, 60), s: x.send ? 1 : 0 }; }) })),
      rules: (DB.remarketing || []).map((r) => ({ id: r.id, name: r.name, enabled: !!r.enabled, stages: r.stages.length, mode: r.mode })),
      queue: (DB.rmktQueue || []).filter(ACTIVE).slice(-200).map((e) => ({ id: e.id, chatId: e.chatId, name: e.name, rule: ruleName(e.ruleId), stage: e.stageIdx + 1, total: ((DB.remarketing || []).find((r) => r.id === e.ruleId) || { stages: [] }).stages.length, dueAt: e.dueAt, status: e.status, mode: e.mode })),
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
      const busy = running.size > 0 || Array.from(queues.values()).some((q) => q && q.length) || !!(rmktBusy || campaignBusy || schedulerBusy || gBusy);
      sendResponse({ waReady, busy, state, qr, local: localLeader });
      return;
    }
    if (msg.type === 'zf:gtick') {
      if (!isLeader || !waReady || !DB) {
        sendResponse({ notReady: true, why: !waReady ? 'loading' : 'notLeader' });
        return;
      }
      setTimeout(() => gTick(), 300);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'zf:gsend') {
      if (!isLeader || !waReady || !DB) {
        sendResponse({ notReady: true });
        return;
      }
      const post = getPost(msg.postId);
      if (!post) {
        sendResponse({ error: 'post não encontrado' });
        return;
      }
      const groups = msg.groups && msg.groups.length ? msg.groups : gTargets(msg.targets);
      if (!groups.length) {
        sendResponse({ error: 'escolha pelo menos um grupo' });
        return;
      }
      sendPostToGroups(post, groups, 'grupo: enviar agora').catch(() => {});
      sendResponse({ ok: true, n: groups.length });
      return;
    }
    if (msg.type === 'zf:call') {
      const OK = ['labelsAll', 'labelsEnsure', 'labelMove', 'labelDelete', 'chatsByLabel', 'applyLabels'];
      if (!OK.includes(msg.method)) {
        sendResponse({ error: 'método não permitido' });
        return;
      }
      if (!waReady) {
        sendResponse({ error: 'WhatsApp ainda carregando' });
        return;
      }
      call(msg.method, ...(msg.args || [])).then((r) => sendResponse({ result: r }), (e) => sendResponse({ error: e.message || String(e) }));
      return true;
    }
    if (msg.type === 'zf:gmembers') {
      if (!waReady) {
        sendResponse({ error: 'WhatsApp ainda carregando' });
        return;
      }
      call('groupMembers', msg.groupId).then((r) => sendResponse(r), (e) => sendResponse({ error: e.message || String(e) }));
      return true;
    }
    if (msg.type === 'zf:groups') {
      if (!waReady) {
        sendResponse({ error: 'WhatsApp ainda carregando' });
        return;
      }
      call('listGroups')
        .then(async (list) => {
          list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
          await chrome.storage.local.set({ waGroups: { at: Date.now(), list } });
          sendResponse({ list });
        }, (e) => sendResponse({ error: e.message || String(e) }));
      return true;
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
      seedStats().catch(() => {});
    }
    initDone = true;
    every(updateCountdowns, 1000);
    every(heartbeat, 10000);
    every(schedulerTick, 15000);
    every(gTick, 20000);
    every(campaignTick, 5000);
    every(rmktTick, 10000);
    try {
      await call('ready');
      waReady = true;
      updateStatus();
      schedulerTick();
      gTick();
      campaignTick();
      rmktTick();
    } catch (e) {
      console.warn('[ZapFunil]', e);
    }
  }

  init();
})();
