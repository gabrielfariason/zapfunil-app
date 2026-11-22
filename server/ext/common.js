// Utilitários compartilhados (content script e painel de controle)
const ZF = (() => {
  const DEFAULT_SETTINGS = {
    typingCps: 18,          // caracteres por segundo da "digitação" simulada
    typingMin: 1.5,         // segundos mínimos digitando
    typingMax: 9,           // segundos máximos digitando
    recordingFactor: 1,     // gravando = duração do áudio x fator
    recordingMax: 30,       // segundos máximos "gravando"
    ignoreGroups: true,
    panelSide: 'right',
    optOutWords: 'parar, sair, cancelar, nao quero mais, pare de mandar, me tira da lista',
    undoSeconds: 8,         // depois de excluir, quanto tempo o botão "Desfazer" fica na tela (0 = pedir confirmação)
    statsDays: 120,         // quantos dias o relatório guarda
    autoBackup: { enabled: true, everyDays: 7, includeMedia: true, keep: 4 },
    // Variações: {oi} vira uma destas opções, sorteada a cada envio
    variations: [
      { key: 'oi', options: ['Oi', 'Olá', 'Opa', 'Oii', 'E aí'] },
      { key: 'show', options: ['Show', 'Boaa', 'Top', 'Perfeito', 'Massa'] },
      { key: 'tudo_bem', options: ['tudo bem?', 'tudo certo?', 'como você está?', 'tudo joia?'] }
    ]
  };

  let customVars = {};
  // Lista de variações → { chave: [opções] }
  function setVariations(list) {
    const out = {};
    for (const v of Array.isArray(list) ? list : []) {
      const k = String((v && v.key) || '').trim().toLowerCase();
      const opts = ((v && v.options) || []).map((o) => String(o).trim()).filter(Boolean);
      if (/^[a-z0-9_]+$/.test(k) && opts.length) out[k] = opts;
    }
    customVars = out;
    return out;
  }
  setVariations(DEFAULT_SETTINGS.variations);

  const UNIT = { s: 1, m: 60, h: 3600, d: 86400 };
  const UNIT_LABEL = { s: 'segundos', m: 'minutos', h: 'horas', d: 'dias' };

  function fmtDelay(sec) {
    sec = Math.round(sec || 0);
    if (sec >= 86400 && sec % 86400 === 0) return sec / 86400 + (sec === 86400 ? ' dia' : ' dias');
    if (sec >= 3600 && sec % 3600 === 0) return sec / 3600 + 'h';
    if (sec >= 60 && sec % 60 === 0) return sec / 60 + 'min';
    return sec + 's';
  }

  // Janela de horário: { enabled, start:'08:00', end:'21:00', days:[0..6] } (0 = domingo)
  // Devolve o primeiro instante >= ts dentro da janela.
  function nextAllowed(ts, win) {
    if (!win || !win.enabled) return ts;
    const days = Array.isArray(win.days) && win.days.length ? win.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    const toMin = (hhmm, def) => {
      const m = String(hhmm || def).match(/^(\d{1,2}):(\d{2})$/);
      return m ? Number(m[1]) * 60 + Number(m[2]) : toMin(def, '00:00');
    };
    const start = toMin(win.start, '08:00');
    let end = toMin(win.end, '21:00');
    if (end <= start) end = start + 1;
    let d = new Date(ts);
    for (let i = 0; i < 9; i++) {
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      if (days.includes(new Date(dayStart).getDay())) {
        const s = dayStart + start * 60000;
        const e = dayStart + end * 60000;
        if (ts < s) return s;
        if (ts < e) return ts;
      }
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      ts = Math.max(ts, d.getTime());
    }
    return ts;
  }

  function isOptOut(body, wordsCsv) {
    const t = normalizeText(body);
    if (!t) return false;
    return String(wordsCsv || '')
      .split(',')
      .map(normalizeText)
      .filter(Boolean)
      .some((w) => t === w || (w.includes(' ') ? t.includes(w) : new RegExp('(^|\\W)' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|\\W)').test(t) && t.split(' ').length <= 6));
  }

  const KEYS = ['items', 'funnels', 'triggers', 'schedules', 'campaigns', 'settings', 'triggerLog', 'history', 'remarketing', 'rmktQueue', 'rmktBlock', 'stats'];
  const OBJ_KEYS = ['triggerLog', 'rmktBlock', 'stats'];

  // "2026-11-22" no fuso local (relatório por dia)
  function dayKey(t) {
    const d = new Date(t || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // pastas usadas (mensagens + funis), em ordem alfabética
  function folders(list) {
    const set = new Set();
    (list || []).forEach((x) => { const f = String((x && x.folder) || '').trim(); if (f) set.add(f); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function load(keys) {
    const data = await chrome.storage.local.get(keys || KEYS);
    return {
      items: data.items || [],
      funnels: data.funnels || [],
      triggers: data.triggers || [],
      schedules: data.schedules || [],
      campaigns: data.campaigns || [],
      settings: (function () {
        const st = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
        st.autoBackup = Object.assign({}, DEFAULT_SETTINGS.autoBackup, (data.settings && data.settings.autoBackup) || {});
        setVariations(st.variations);
        return st;
      })(),
      triggerLog: data.triggerLog || {},
      history: data.history || [],
      remarketing: data.remarketing || [],
      rmktQueue: data.rmktQueue || [],
      rmktBlock: data.rmktBlock || {},
      stats: data.stats || {}
    };
  }

  function save(obj) {
    return chrome.storage.local.set(obj);
  }

  function normalizeNumber(raw) {
    const s = String(raw || '').trim();
    let d = s.replace(/\D/g, '');
    if (!d) return '';
    // Com "+" ou "00" na frente = já tem DDI, mantém como está
    if (s.startsWith('+')) return d;
    if (d.startsWith('00')) return d.slice(2);
    // Número brasileiro sem DDI (10 ou 11 dígitos) -> adiciona 55
    if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) d = '55' + d;
    return d;
  }

  function greeting(date) {
    const h = (date || new Date()).getHours();
    if (h < 5) return 'Boa noite';
    if (h < 12) return 'Bom dia';
    if (h < 18) return 'Boa tarde';
    return 'Boa noite';
  }

  // Variáveis: {nome} {primeiro_nome} {saudacao} {Saudacao} {data} {hora} {numero}
  // Spintax: {opção 1|opção 2|opção 3}
  function applyVars(text, ctx) {
    if (!text) return '';
    ctx = ctx || {};
    const name = (ctx.name || '').trim();
    const first = name.split(/\s+/)[0] || '';
    const now = new Date();
    const g = greeting(now);
    const map = {
      nome: name,
      primeiro_nome: first,
      saudacao: g.toLowerCase(),
      Saudacao: g,
      data: now.toLocaleDateString('pt-BR'),
      hora: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      numero: (ctx.number || '').replace(/@.*/, '')
    };
    // 1º) variações cadastradas: {oi} → "Olá" ({Oi} = primeira letra maiúscula)
    let out = text.replace(/\{([A-Za-z0-9_]+)\}/g, (m, key) => {
      const opts = customVars[key.toLowerCase()];
      if (!opts || Object.prototype.hasOwnProperty.call(map, key)) return m;
      let pick = opts[Math.floor(Math.random() * opts.length)];
      if (/^[A-Z]/.test(key)) pick = pick.charAt(0).toUpperCase() + pick.slice(1);
      return pick;
    });
    out = out.replace(/\{([^{}]+)\}/g, (m, inner) => {
      if (Object.prototype.hasOwnProperty.call(map, inner)) return map[inner];
      if (inner.includes('|')) {
        const opts = inner.split('|');
        return opts[Math.floor(Math.random() * opts.length)];
      }
      return m;
    });
    // limpa espaços duplos causados por nome vazio
    return out.replace(/ {2,}/g, ' ').replace(/ ([,.!?])/g, '$1');
  }

  function normalizeText(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matchTrigger(trigger, body) {
    const text = normalizeText(body);
    if (!text && trigger.match !== 'any') return false;
    if (trigger.match === 'any') return true;
    const kws = (trigger.keywords || []).map(normalizeText).filter(Boolean);
    return kws.some((k) => {
      if (trigger.match === 'exact') return text === k;
      if (trigger.match === 'starts') return text.startsWith(k);
      if (trigger.match === 'word') return new RegExp('(^|\\W)' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|\\W)').test(text);
      return text.includes(k);
    });
  }

  function typeLabel(t) {
    return { text: 'Mensagem', audio: 'Áudio', image: 'Imagem', video: 'Vídeo', document: 'Documento' }[t] || t;
  }

  function typeIcon(t) {
    return { text: '💬', audio: '🎤', image: '🖼️', video: '🎬', document: '📄' }[t] || '•';
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { DEFAULT_SETTINGS, setVariations, dayKey, folders, KEYS, OBJ_KEYS, UNIT, UNIT_LABEL, fmtDelay, nextAllowed, isOptOut, uid, load, save, normalizeNumber, applyVars, matchTrigger, normalizeText, typeLabel, typeIcon, fmtDuration, escapeHtml, greeting };
})();
