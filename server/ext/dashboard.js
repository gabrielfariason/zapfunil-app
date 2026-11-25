// ZapFunil – painel de controle
(() => {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = ZF.escapeHtml;
  let DB = null;
  let view = 'items';
  let filter = 'text';

  // ------------------------------------------------------------ utilidades
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  async function reload() {
    DB = await ZF.load();
  }
  const pending = {}; // chaves sendo gravadas por este painel (ignora o "eco" para não voltar estado antigo)
  async function persist(key) {
    pending[key] = (pending[key] || 0) + 1;
    try {
      await ZF.save({ [key]: DB[key] });
      if (key === 'items') DB.items = ZF.splitItems(DB.items).items; // mídia já foi para a chave própria
    } catch (e) {
      if (/context invalidated/i.test((e && e.message) || '')) staleBanner();
      throw e;
    } finally {
      setTimeout(() => (pending[key] = Math.max(0, (pending[key] || 0) - 1)), 50);
    }
  }
  // painel aberto antes de atualizar a extensão: precisa recarregar a página
  function staleBanner() {
    if (document.getElementById('zfStale')) return;
    const b = document.createElement('div');
    b.id = 'zfStale';
    b.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;background:#2a2d34;color:#f5f5f7;border:1px solid #f2b632;border-radius:12px;padding:10px 14px;display:flex;gap:12px;align-items:center;box-shadow:0 8px 24px rgba(0,0,0,.35)';
    b.innerHTML = '<span>A extensão foi atualizada. Recarregue esta página para salvar.</span><button class="btn sm">Recarregar</button>';
    b.querySelector('button').onclick = () => location.reload();
    document.body.appendChild(b);
  }
  window.addEventListener('unhandledrejection', (ev) => {
    if (/context invalidated/i.test((ev.reason && ev.reason.message) || String(ev.reason || ''))) staleBanner();
  });
  setInterval(() => {
    try {
      if (!chrome.runtime || !chrome.runtime.id) staleBanner();
    } catch (e) {
      staleBanner();
    }
  }, 5000);
  function openModal(html) {
    $('#modalBox').innerHTML = html;
    $('#modal').classList.remove('hidden');
  }
  function closeModal() {
    $('#modal').classList.add('hidden');
    $('#modalBox').innerHTML = '';
    if (window.__stopRec) window.__stopRec(true);
  }
  $('#modal').addEventListener('mousedown', (e) => {
    if (e.target.id === 'modal') closeModal();
  });
  function fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
  }
  function blobToDataUrl(blob) {
    return fileToDataUrl(blob);
  }
  function dataUrlSizeKb(d) {
    return Math.round(((d || '').length * 3) / 4 / 1024);
  }
  function fmtDate(ts) {
    return ts ? new Date(ts).toLocaleString('pt-BR') : '-';
  }
  function toLocalInput(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function targetOptions(selType, selId) {
    let h = '<optgroup label="Funis">';
    DB.funnels.forEach((f) => (h += `<option value="funnel:${f.id}" ${selType === 'funnel' && selId === f.id ? 'selected' : ''}>🔁 ${esc(f.name)}</option>`));
    h += '</optgroup><optgroup label="Itens">';
    DB.items.forEach((i) => (h += `<option value="item:${i.id}" ${selType === 'item' && selId === i.id ? 'selected' : ''}>${ZF.typeIcon(i.type)} ${esc(i.name)}</option>`));
    return h + '</optgroup>';
  }
  function targetName(type, id) {
    if (type === 'item') {
      const i = DB.items.find((x) => x.id === id);
      return i ? ZF.typeIcon(i.type) + ' ' + i.name : '(item apagado)';
    }
    const f = DB.funnels.find((x) => x.id === id);
    return f ? '🔁 ' + f.name : '(funil apagado)';
  }
  function parseTarget(v) {
    const [t, ...rest] = String(v || '').split(':');
    return { targetType: t, targetId: rest.join(':') };
  }
  function parseNumbers(text) {
    return String(text || '')
      .split(/[\n;]+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const parts = l.split(/[,\t]/);
        const number = ZF.normalizeNumber(parts[0]);
        const name = (parts.slice(1).join(' ') || '').trim();
        return { number, name };
      })
      .filter((c) => c.number.length >= 10);
  }
  function varBtns() {
    const custom = (DB && DB.settings && DB.settings.variations) || [];
    return `<div class="vars">
    <button type="button" data-ins="{nome}">{nome}</button>
    <button type="button" data-ins="{primeiro_nome}">{primeiro_nome}</button>
    <button type="button" data-ins="{Saudacao}">{Saudacao}</button>
    <button type="button" data-ins="{saudacao}">{saudacao}</button>
    <button type="button" data-ins="{data}">{data}</button>
    <button type="button" data-ins="{hora}">{hora}</button>
    ${custom.filter((v) => v && v.key).map((v) => `<button type="button" class="vv" data-ins="{${esc(v.key)}}" title="${esc((v.options || []).join(' / '))}">🔀 {${esc(v.key)}}</button>`).join('')}
    <button type="button" data-ins="{Oi|Olá|E aí}">{Oi|Olá|E aí} (aleatório)</button>
  </div><div class="hint" style="margin-top:4px">🔀 = variações (sorteia uma a cada envio). Cadastre e edite em <a href="#settings">Configurações → Variações</a>.</div>`;
  }
  function bindVarButtons(textarea) {
    $$('.vars button').forEach((b) =>
      b.addEventListener('click', () => {
        const ta = textarea();
        const s = ta.selectionStart, e = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + b.dataset.ins + ta.value.slice(e);
        ta.focus();
        ta.selectionStart = ta.selectionEnd = s + b.dataset.ins.length;
      })
    );
  }

  // ------------------------------------------------------------ áudio: decodificar, medir e converter para MP3
  async function decodeAudio(arrayBuffer) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    try {
      return await ac.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      ac.close();
    }
  }
  function encodeMp3(audioBuffer) {
    const sr = audioBuffer.sampleRate;
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
    const len = ch0.length;
    const pcm = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      let v = ch1 ? (ch0[i] + ch1[i]) / 2 : ch0[i];
      v = Math.max(-1, Math.min(1, v));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const enc = new lamejs.Mp3Encoder(1, sr, 96);
    const chunks = [];
    for (let i = 0; i < len; i += 1152) {
      const b = enc.encodeBuffer(pcm.subarray(i, i + 1152));
      if (b.length) chunks.push(new Uint8Array(b));
    }
    const end = enc.flush();
    if (end.length) chunks.push(new Uint8Array(end));
    return new Blob(chunks, { type: 'audio/mpeg' });
  }
  // Recebe um arquivo/blob de áudio e devolve {data, mime, duration, filename}
  async function prepareAudio(blob, filename) {
    const buf = await blob.arrayBuffer();
    let decoded;
    try {
      decoded = await decodeAudio(buf);
    } catch (e) {
      throw new Error('Não consegui ler esse áudio. Use MP3, OGG, M4A ou WAV.');
    }
    const duration = decoded.duration;
    const type = (blob.type || '').toLowerCase();
    // OGG/Opus e MP3 vão como estão (melhor qualidade). O resto vira MP3.
    if (/ogg|opus|mpeg|mp3/.test(type) || /\.(ogg|opus|mp3)$/i.test(filename || '')) {
      let mime = type || (/\.mp3$/i.test(filename) ? 'audio/mpeg' : 'audio/ogg; codecs=opus');
      if (/ogg|opus/.test(mime)) mime = 'audio/ogg; codecs=opus';
      const data = await blobToDataUrl(blob);
      return { data, mime, duration, filename: filename || 'audio' };
    }
    const mp3 = encodeMp3(decoded);
    return { data: await blobToDataUrl(mp3), mime: 'audio/mpeg', duration, filename: (filename || 'audio').replace(/\.\w+$/, '') + '.mp3' };
  }

  // ------------------------------------------------------------ navegação
  function setView(v, f) {
    view = v;
    if (f) filter = f;
    $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === v && (v !== 'items' || a.dataset.filter === filter)));
    location.hash = v + (v === 'items' ? ':' + filter : '');
    render();
  }
  $$('#nav a').forEach((a) => a.addEventListener('click', () => setView(a.dataset.view, a.dataset.filter)));
  $('#openWa').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'focusWhatsApp' }));

  function render() {
    const fn = { mobile: renderMobile, items: renderItems, funnels: renderFunnels, remarketing: renderRemarketing, triggers: renderTriggers, schedules: renderSchedules, campaigns: renderCampaigns, groups: renderGroups, report: renderReport, search: renderSearch, history: renderHistory, settings: renderSettings }[view] || renderItems;
    fn();
  }

  // Move um registro para cima/baixo dentro do grupo visível (respeita a ordem do array)
  // ----- prévias leves: mídia só vira <video>/<audio> quando você clica (antes travava com vários vídeos)
  const blobUrls = new Map();
  async function blobUrl(item) {
    const k = item.id + ':' + (item.data ? item.data.length : item.mediaKb || 0);
    if (blobUrls.has(k)) return blobUrls.get(k);
    const data = item.data || (await ZF.getMedia(item.id));
    if (!data) throw new Error('sem arquivo');
    const b = await (await fetch(data)).blob();
    const u = URL.createObjectURL(b);
    blobUrls.set(k, u);
    return u;
  }
  function mediaPreview(i) {
    if (i.type === 'image') return `<div class="mprev" data-mprev="${i.id}"><div class="mph">🖼️</div></div>`;
    if (i.type === 'video') return `<button type="button" class="mprev play" data-play="${i.id}"><span>▶</span> Ver vídeo</button>`;
    if (i.type === 'audio') return `<button type="button" class="mprev play" data-play="${i.id}"><span>▶</span> Ouvir</button>`;
    return '';
  }
  function bindPreviews(root) {
    const io = 'IntersectionObserver' in window ? new IntersectionObserver((ents) => {
      ents.forEach(async (e) => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        const it = DB.items.find((x) => x.id === e.target.dataset.mprev);
        if (!it || !(it.data || it.hasMedia)) return;
        try { e.target.innerHTML = `<img src="${await blobUrl(it)}" alt="">`; } catch (err) {}
      });
    }, { rootMargin: '200px' }) : null;
    $$('[data-mprev]', root).forEach((el) => (io ? io.observe(el) : null));
    $$('[data-play]', root).forEach((b) => (b.onclick = async (ev) => {
      ev.stopPropagation();
      const it = DB.items.find((x) => x.id === b.dataset.play);
      if (!it) return;
      b.disabled = true;
      b.innerHTML = 'Carregando…';
      try {
        const u = await blobUrl(it);
        const m = document.createElement(it.type === 'video' ? 'video' : 'audio');
        m.src = u; m.controls = true; m.autoplay = true; m.className = 'mplayer';
        b.replaceWith(m);
      } catch (err) { b.textContent = 'Não consegui abrir'; }
    }));
  }

  // ----- arrastar para reordenar: segure o ⋮⋮ e arraste (mouse ou toque)
  function makeSortable(container, onDrop) {
    $$('[data-row]', container).forEach((row) => {
      const handle = $('.grip', row);
      if (!handle) return;
      handle.style.touchAction = 'none';
      handle.onpointerdown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        const id = row.dataset.row;
        let target = null, after = false, moved = false;
        const sy = e.clientY;
        try { handle.setPointerCapture(e.pointerId); } catch (x) {}
        const clear = () => $$('.drop-before,.drop-after', container).forEach((x) => x.classList.remove('drop-before', 'drop-after'));
        const move = (ev) => {
          if (!moved && Math.abs(ev.clientY - sy) < 4) return;
          moved = true;
          row.classList.add('dragging');
          const el = document.elementFromPoint(ev.clientX, ev.clientY);
          const over = el && el.closest('[data-row]');
          clear();
          target = null;
          if (!over || over === row || !container.contains(over)) return;
          const r = over.getBoundingClientRect();
          after = container.classList.contains('grid') ? ev.clientX > r.left + r.width / 2 : ev.clientY > r.top + r.height / 2;
          over.classList.add(after ? 'drop-after' : 'drop-before');
          target = over.dataset.row;
          // rola a página perto das bordas
          if (ev.clientY < 60) window.scrollBy(0, -12);
          else if (ev.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          row.classList.remove('dragging');
          clear();
          if (moved && target && target !== id) onDrop(id, target, after);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      };
    });
  }
  // move "id" para antes/depois de "targetId" só entre os do mesmo grupo (ex.: só áudios)
  async function reorder(key, id, targetId, after, inGroup, render) {
    const arr = DB[key];
    const pos = [];
    arr.forEach((x, i) => { if (inGroup(x)) pos.push(i); });
    const sub = pos.map((i) => arr[i]);
    const from = sub.findIndex((x) => x.id === id);
    if (from < 0) return;
    const [moved] = sub.splice(from, 1);
    let to = sub.findIndex((x) => x.id === targetId);
    if (to < 0) return;
    if (after) to++;
    sub.splice(to, 0, moved);
    pos.forEach((p, k) => (arr[p] = sub[k]));
    if (render) render(); // mostra na hora; grava em seguida
    await persist(key);
  }
  async function moveEdge(key, id, toTop, inGroup, render) {
    const sub = DB[key].filter(inGroup);
    if (sub.length < 2) return;
    const target = toTop ? sub[0] : sub[sub.length - 1];
    if (target.id === id) return;
    await reorder(key, id, target.id, !toTop, inGroup, render);
  }
  let listMode = (() => { try { return localStorage.getItem('zfListMode') !== 'cards'; } catch (e) { return true; } })();
  function viewToggle() {
    return `<div class="seg"><button type="button" class="${listMode ? 'on' : ''}" data-vm="list">☰ Lista</button><button type="button" class="${listMode ? '' : 'on'}" data-vm="cards">▦ Cartões</button></div>`;
  }
  function bindViewToggle(again) {
    $$('[data-vm]').forEach((b) => (b.onclick = () => {
      listMode = b.dataset.vm === 'list';
      try { localStorage.setItem('zfListMode', listMode ? 'list' : 'cards'); } catch (e) {}
      again();
    }));
  }

  async function moveIn(key, id, dir, sameGroup, render) {
    const arr = DB[key];
    const i = arr.findIndex((x) => x.id === id);
    if (i < 0) return;
    let j = i + dir;
    while (j >= 0 && j < arr.length && !sameGroup(arr[j])) j += dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    if (render) render();
    await persist(key);
  }

  // ----- pastas (mensagens e funis): uma pasta escolhida vale para todas as abas
  let curFolder = (() => { try { return localStorage.getItem('zfFolder') || ''; } catch (e) { return ''; } })();
  const folderOf = (x) => String((x && x.folder) || '').trim();
  const allFolders = () => ZF.folders(DB.items.concat(DB.funnels));
  function folderMatch(x, sel) {
    return !sel || (sel === '__none' ? !folderOf(x) : folderOf(x) === sel);
  }
  function folderChips(pool) {
    const fl = allFolders();
    if (curFolder && curFolder !== '__none' && !fl.includes(curFolder)) curFolder = '';
    if (!fl.length) return '';
    const opts = [['', 'Todas']].concat(fl.map((f) => [f, '📁 ' + f]), [['__none', 'Sem pasta']]);
    return '<div class="chips" id="fchips">' + opts.map(([v, t]) => {
      const n = pool.filter((x) => folderMatch(x, v)).length;
      return `<button type="button" class="chip ${curFolder === v ? 'on' : ''} ${n ? '' : 'zero'}" data-fsel="${esc(v)}">${esc(t)} <span>${n}</span></button>`;
    }).join('') + '</div>';
  }
  function bindFolderChips(again) {
    $$('#fchips [data-fsel]').forEach((b) => (b.onclick = () => {
      curFolder = b.dataset.fsel;
      try { localStorage.setItem('zfFolder', curFolder); } catch (e) {}
      again();
    }));
  }
  function folderField(cur) {
    const def = cur != null ? cur : curFolder && curFolder !== '__none' ? curFolder : '';
    return `<div><label>Pasta (opcional)</label><input type="text" id="fFolder" list="folderList" value="${esc(def)}" placeholder="ex: APEX, Afiliado…" autocomplete="off">
      <datalist id="folderList">${allFolders().map((f) => `<option value="${esc(f)}">`).join('')}</datalist><div class="hint">Organiza a lista aqui e no painel ⚡ do WhatsApp</div></div>`;
  }
  const ftag = (x) => (folderOf(x) && !curFolder ? `<span class="ftag">📁 ${esc(folderOf(x))}</span>` : '');
  // mover para pasta (botão 📁 de cada linha)
  function moveToFolder(key, id, again) {
    const obj = DB[key].find((x) => x.id === id);
    if (!obj) return;
    const fl = allFolders();
    openModal(`<h2>📁 Mover para pasta</h2><p class="hint">${esc(obj.name)}</p>
      <div class="chips" id="mvList" style="margin:10px 0 14px">${fl.map((f) => `<button type="button" class="chip ${folderOf(obj) === f ? 'on' : ''}" data-mv="${esc(f)}">📁 ${esc(f)}</button>`).join('')}<button type="button" class="chip ${folderOf(obj) ? '' : 'on'}" data-mv="">Sem pasta</button></div>
      <label>Ou crie uma pasta nova</label><input type="text" id="mvNew" placeholder="Nome da pasta">
      <div class="modal-foot"><button class="btn sec" id="cancel">Cancelar</button><button class="btn" id="mvOk">Criar e mover</button></div>`);
    const apply = async (name) => {
      name = String(name || '').trim().slice(0, 40);
      if (name) obj.folder = name;
      else delete obj.folder;
      closeModal();
      again();
      await persist(key);
      toast(name ? 'Movido para 📁 ' + name : 'Agora está sem pasta');
    };
    $$('#mvList [data-mv]').forEach((b) => (b.onclick = () => apply(b.dataset.mv)));
    $('#mvOk').onclick = () => { const v = $('#mvNew').value.trim(); if (!v) return toast('Digite o nome da pasta'); apply(v); };
    $('#mvNew').onkeydown = (e) => { if (e.key === 'Enter') $('#mvOk').click(); };
    $('#cancel').onclick = closeModal;
    setTimeout(() => $('#mvNew').focus(), 30);
  }

  // ----- excluir com "Desfazer" (em Configurações: quantos segundos, ou 0 = pedir confirmação)
  let undoCur = null;
  function undoSecs() {
    const v = Number(DB.settings.undoSeconds);
    return Number.isFinite(v) ? Math.max(0, Math.min(60, v)) : 8;
  }
  function closeUndo() {
    const u = $('#undo');
    if (undoCur) clearTimeout(undoCur.t);
    undoCur = null;
    u.classList.add('hidden');
    u.innerHTML = '';
  }
  function showUndo(msg, onUndo) {
    closeUndo();
    const secs = undoSecs();
    const u = $('#undo');
    u.innerHTML = `<span>${esc(msg)}</span><button class="btn sm yel" type="button">↶ Desfazer</button><i class="ubar"></i>`;
    u.classList.remove('hidden');
    const bar = $('.ubar', u);
    bar.style.width = '100%';
    bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: secs * 1000, easing: 'linear', fill: 'forwards' });
    const me = { t: setTimeout(closeUndo, secs * 1000) };
    undoCur = me;
    $('button', u).onclick = async () => {
      if (undoCur !== me) return;
      closeUndo();
      try { await onUndo(); toast('Restaurado ✅'); } catch (e) { toast('Não consegui desfazer: ' + e.message); }
    };
  }
  // remove 1 registro de DB[key]; devolve false se o usuário desistiu
  async function removeWithUndo(key, id, label, extra) {
    extra = extra || {};
    const arr = DB[key];
    const idx = arr.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    const obj = arr[idx];
    const secs = undoSecs();
    if (!secs && !confirm('Excluir "' + label + '"?' + (extra.warn ? '\n\n' + extra.warn : ''))) return false;
    DB[key] = arr.filter((x) => x.id !== id);
    render();
    await persist(key);
    if (extra.after) await extra.after();
    if (secs) showUndo('"' + label + '" excluído' + (extra.warn ? ' · ' + extra.warn : ''), async () => {
      if (!DB[key].some((x) => x.id === id)) DB[key].splice(Math.min(idx, DB[key].length), 0, obj);
      await persist(key);
      if (extra.undo) await extra.undo();
      render();
    });
    return true;
  }

  // ------------------------------------------------------------ seletor de mensagem/funil (filtro por tipo, pasta e busca)
  // O <select> original continua guardando o valor (nada muda na hora de salvar); por cima aparece um botão
  // que abre a lista com filtros. Padrão: "Todos".
  const PK_KINDS = [['all', 'Todos'], ['funnel', '🔁 Funis'], ['text', '💬 Texto'], ['audio', '🎤 Áudio'], ['image', '🖼️ Imagem'], ['video', '🎬 Vídeo'], ['document', '📄 Doc']];
  let pkEl = null;
  function pkEntry(v) {
    if (!v) return null;
    let kind = 'item';
    let id = v;
    const m = /^(funnel|item):(.*)$/s.exec(v);
    if (m) { kind = m[1]; id = m[2]; }
    if (kind === 'funnel') {
      const f = DB.funnels.find((x) => x.id === id);
      return f ? { v, kind: 'funnel', icon: '🔁', name: f.name, folder: folderOf(f), sub: f.steps.length + ' etapa(s)' } : null;
    }
    const i = DB.items.find((x) => x.id === id);
    return i ? { v, kind: i.type, icon: ZF.typeIcon(i.type), name: i.name, folder: folderOf(i), sub: i.type === 'text' ? (i.text || '').slice(0, 70) : ZF.typeLabel(i.type) + (i.duration ? ' · ' + ZF.fmtDuration(i.duration) : '') } : null;
  }
  function closePicker() {
    if (pkEl) pkEl.remove();
    pkEl = null;
    document.removeEventListener('mousedown', pkOutside, true);
  }
  function pkOutside(e) {
    if (pkEl && !pkEl.contains(e.target) && !e.target.closest('.pk-btn')) closePicker();
  }
  function attachPicker(sel) {
    if (!sel || sel.dataset.pk) return;
    sel.dataset.pk = '1';
    sel.classList.add('pk-hidden');
    sel.tabIndex = -1;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pk-btn';
    sel.after(btn);
    const label = () => {
      const e = pkEntry(sel.value);
      btn.innerHTML = e ? `<span>${e.icon}</span><span class="pk-name">${esc(e.name)}</span>${e.folder ? `<span class="ftag">📁 ${esc(e.folder)}</span>` : ''}<span class="pk-caret">▾</span>` : '<span class="hint">— escolha —</span><span class="pk-caret">▾</span>';
    };
    label();
    sel.addEventListener('change', label);
    btn.onclick = (e) => {
      e.preventDefault();
      if (pkEl && pkEl.dataset.for === sel.dataset.pkid) return closePicker();
      openPicker(sel, btn);
    };
  }
  let pkSeq = 0;
  function openPicker(sel, btn) {
    closePicker();
    sel.dataset.pkid = sel.dataset.pkid || 'pk' + ++pkSeq;
    const all = [...sel.options].map((o) => pkEntry(o.value)).filter(Boolean);
    const kinds = PK_KINDS.filter(([k]) => k === 'all' || all.some((e) => e.kind === k));
    const fl = ZF.folders(all.map((e) => ({ folder: e.folder })));
    let kind = 'all';
    let fold = '';
    pkEl = document.createElement('div');
    pkEl.className = 'pk-pop';
    pkEl.dataset.for = sel.dataset.pkid;
    pkEl.innerHTML = `<input type="search" class="pk-q" placeholder="Buscar pelo nome…">
      <div class="pk-kinds">${kinds.map(([k, t]) => `<button type="button" data-k="${k}" class="chip ${k === 'all' ? 'on' : ''}">${t}</button>`).join('')}</div>
      ${fl.length ? `<select class="pk-f"><option value="">📁 Todas as pastas</option>${fl.map((f) => `<option value="${esc(f)}">📁 ${esc(f)}</option>`).join('')}<option value="__none">Sem pasta</option></select>` : ''}
      <div class="pk-list"></div>`;
    document.body.appendChild(pkEl);
    const r = btn.getBoundingClientRect();
    const w = Math.max(r.width, 380);
    pkEl.style.width = w + 'px';
    pkEl.style.left = Math.min(r.left, window.innerWidth - w - 10) + 'px';
    const below = window.innerHeight - r.bottom;
    if (below < 300 && r.top > below) pkEl.style.bottom = window.innerHeight - r.top + 4 + 'px';
    else pkEl.style.top = r.bottom + 4 + 'px';
    pkEl.style.maxHeight = Math.max(240, Math.min(440, below > 300 ? below - 20 : r.top - 20)) + 'px';
    const q = $('.pk-q', pkEl);
    const draw = () => {
      const t = ZF.normalizeText(q.value);
      const rows = all.filter((e) => (kind === 'all' || e.kind === kind) && (!fold || (fold === '__none' ? !e.folder : e.folder === fold)) && (!t || ZF.normalizeText(e.name + ' ' + e.folder + ' ' + e.sub).includes(t)));
      $('.pk-list', pkEl).innerHTML = rows.length ? rows.map((e) => `<button type="button" class="pk-row ${e.v === sel.value ? 'on' : ''}" data-v="${esc(e.v)}"><span class="pk-ic">${e.icon}</span><span class="pk-main"><span class="pk-t"><b>${esc(e.name)}</b>${e.folder ? `<span class="ftag">📁 ${esc(e.folder)}</span>` : ''}</span><small>${esc(e.sub)}</small></span></button>`).join('') : '<div class="hint" style="padding:12px">Nada encontrado.</div>';
      $$('.pk-row', pkEl).forEach((b) => (b.onclick = () => {
        sel.value = b.dataset.v;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        closePicker();
      }));
    };
    $$('[data-k]', pkEl).forEach((b) => (b.onclick = () => {
      kind = b.dataset.k;
      $$('[data-k]', pkEl).forEach((x) => x.classList.toggle('on', x === b));
      draw();
    }));
    if ($('.pk-f', pkEl)) $('.pk-f', pkEl).onchange = (e) => { fold = e.target.value; draw(); };
    q.oninput = draw;
    q.onkeydown = (e) => {
      if (e.key === 'Escape') closePicker();
      if (e.key === 'Enter') { e.preventDefault(); const f = $('.pk-row', pkEl); if (f) f.click(); }
    };
    draw();
    setTimeout(() => q.focus(), 0);
    document.addEventListener('mousedown', pkOutside, true);
  }
  // qualquer seletor de "o que enviar" que aparecer num modal ganha o seletor novo
  new MutationObserver(() => {
    $$('#modal select.it, #modal select.tg, #modal select#tTarget, #modal select#sTarget, #modal select#cTarget').forEach(attachPicker);
    if (pkEl && $('#modal').classList.contains('hidden')) closePicker();
  }).observe(document.getElementById('modal'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  // ------------------------------------------------------------ grupos + marcar todos (oculto)
  async function loadGroups(force) {
    const c = (await chrome.storage.local.get('waGroups')).waGroups;
    if (c && c.list && !force) return { list: c.list, at: c.at };
    const r = await bgMsg({ type: 'wa:groups' });
    if (r && r.list) return { list: r.list, at: Date.now() };
    if (c && c.list) return { list: c.list, at: c.at, error: r && r.error };
    throw new Error((r && r.error) || 'não consegui carregar os grupos');
  }
  // caixa de grupos dentro de um modal; devolve getter da seleção
  function groupBox(selected) {
    let picked = (selected || []).map((g) => ({ id: g.id, name: g.name }));
    let list = [];
    const box = $('#grpBox');
    const draw = () => {
      const q = ZF.normalizeText(($('#grpQ') || {}).value || '');
      const merged = list.slice();
      picked.forEach((p) => { if (!merged.some((g) => g.id === p.id)) merged.unshift(Object.assign({ size: 0 }, p)); });
      const rows = merged.filter((g) => !q || ZF.normalizeText(g.name).includes(q));
      $('#grpList').innerHTML = rows.length ? rows.slice(0, 300).map((g) => `<label class="grp-row"><input type="checkbox" data-g="${esc(g.id)}" ${picked.some((p) => p.id === g.id) ? 'checked' : ''}> <span>👥 ${esc(g.name || g.id)}</span>${g.size ? `<small>${g.size} membros</small>` : ''}${g.onlyAdmins ? '<small style="color:var(--red)">só admins enviam</small>' : ''}</label>`).join('') : `<div class="hint">${list.length ? 'Nenhum grupo com esse nome.' : 'Clique em “Carregar grupos”.'}</div>`;
      $$('#grpList [data-g]').forEach((cb) => (cb.onchange = () => {
        const g = merged.find((x) => x.id === cb.dataset.g);
        if (cb.checked) picked.push({ id: g.id, name: g.name });
        else picked = picked.filter((p) => p.id !== g.id);
        $('#grpN').textContent = picked.length ? picked.length + ' selecionado(s)' : '';
        box.dispatchEvent(new Event('change'));
      }));
      $('#grpN').textContent = picked.length ? picked.length + ' selecionado(s)' : '';
    };
    const load = async (force) => {
      $('#grpLoad').disabled = true;
      $('#grpLoad').textContent = 'Carregando…';
      try {
        const r = await loadGroups(force);
        list = r.list;
        $('#grpInfo').textContent = list.length + ' grupos' + (r.at ? ' · atualizado ' + fmtDate(r.at) : '') + (r.error ? ' (' + r.error + ')' : '');
      } catch (e) {
        $('#grpInfo').textContent = e.message;
      }
      $('#grpLoad').disabled = false;
      $('#grpLoad').textContent = '🔄 Atualizar grupos';
      draw();
    };
    $('#grpLoad').onclick = () => load(true);
    $('#grpQ').oninput = draw;
    load(false);
    return () => picked;
  }
  const GROUP_BOX_HTML = `<div id="grpBox" class="section" style="margin:10px 0;padding:12px 14px"><div class="bar" style="margin:0 0 8px"><b>👥 Grupos</b><span class="hint" id="grpN"></span><span class="grow"></span><button type="button" class="btn sm sec" id="grpLoad">Carregar grupos</button></div>
    <input type="search" id="grpQ" placeholder="Buscar grupo…"><div id="grpList" class="grp-list"></div><div class="hint" id="grpInfo"></div></div>`;
  function mentionHtml(m) {
    m = m || {};
    return `<div id="mBox" class="section" style="margin:10px 0;padding:12px 14px"><label class="inline"><input type="checkbox" id="mOn" ${m.on ? 'checked' : ''}> <b>👥 Marcar todos do grupo</b> <span class="hint">(oculto: todo mundo é notificado, sem aparecer @ no texto)</span></label>
      <div id="mOpts" class="row2" style="margin-top:8px"><div><label>Em quais mensagens</label><select id="mAt">${[['first', 'Na 1ª mensagem'], ['last', 'Na última'], ['all', 'Em todas'], ['custom', 'Escolher quais…']].map(([v, t]) => `<option value="${v}" ${(m.at || 'first') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div id="mCustom"><label>Números das mensagens</label><input type="text" id="mList" value="${esc((m.list || []).join(', '))}" placeholder="ex: 2  ou  1, 3"></div></div>
      <div class="hint" id="mSteps"></div></div>`;
  }
  function bindMention(targetSel) {
    const upd = () => {
      $('#mOpts').style.display = $('#mOn').checked ? '' : 'none';
      $('#mSteps').style.display = $('#mOn').checked ? '' : 'none';
      $('#mCustom').style.visibility = $('#mAt').value === 'custom' ? 'visible' : 'hidden';
      const t = parseTarget(targetSel.value);
      const f = t.targetType === 'funnel' ? DB.funnels.find((x) => x.id === t.targetId) : null;
      let n = 0;
      $('#mSteps').innerHTML = f ? 'Mensagens deste funil: ' + f.steps.filter((x) => x.itemId && x.kind !== 'wait_reply').map((x) => { const it = DB.items.find((i) => i.id === x.itemId); return it ? `<b>${++n}</b> ${ZF.typeIcon(it.type)} ${esc(it.name)}` : ''; }).filter(Boolean).join(' · ') : t.targetId ? 'Uma mensagem só: marca nela.' : '';
    };
    ['#mOn', '#mAt'].forEach((k) => ($(k).onchange = upd));
    targetSel.addEventListener('change', upd);
    upd();
    return () => {
      const at = $('#mAt').value;
      const list = String($('#mList').value || '').split(/[^\d]+/).map(Number).filter((x) => x > 0);
      return { on: $('#mOn').checked, at, list: at === 'custom' ? list : [] };
    };
  }

  // ------------------------------------------------------------ ITENS
  const FILTER_INFO = {
    text: { title: 'Mensagens', sub: 'Textos prontos com variáveis. Envie com 1 clique ou digitando /atalho + Tab no WhatsApp.', types: ['text'], newType: 'text' },
    audio: { title: 'Áudios', sub: 'Áudios enviados como se fossem gravados na hora (com "gravando áudio…" antes).', types: ['audio'], newType: 'audio' },
    media: { title: 'Mídias', sub: 'Imagens e vídeos com legenda.', types: ['image', 'video'], newType: 'image' },
    document: { title: 'Documentos', sub: 'PDFs, planilhas e qualquer arquivo.', types: ['document'], newType: 'document' }
  };

  let mediaSub = 'all'; // Mídias: todos | image | video
  function renderItems() {
    const info = FILTER_INFO[filter];
    const shownTypes = filter === 'media' && mediaSub !== 'all' ? [mediaSub] : info.types;
    const pool = DB.items.filter((i) => shownTypes.includes(i.type));
    const items = pool.filter((i) => folderMatch(i, curFolder));
    let h = `<h1>${info.title}</h1><p class="sub">${info.sub} A ordem aqui é a ordem no painel ⚡ e na barra do WhatsApp — arraste pelo ⋮⋮ ou use ↑ ↓.</p>
      <div class="bar"><input type="search" id="q" placeholder="Buscar nesta lista…" style="max-width:320px">${viewToggle()}${filter === 'media' ? `<div class="seg" id="msub"><button type="button" data-ms="all" class="${mediaSub === 'all' ? 'on' : ''}">Todos (${DB.items.filter((x) => x.type === 'image' || x.type === 'video').length})</button><button type="button" data-ms="image" class="${mediaSub === 'image' ? 'on' : ''}">🖼️ Imagens (${DB.items.filter((x) => x.type === 'image').length})</button><button type="button" data-ms="video" class="${mediaSub === 'video' ? 'on' : ''}">🎬 Vídeos (${DB.items.filter((x) => x.type === 'video').length})</button></div>` : ''}<span class="grow"></span>
      <button class="btn" id="newItem">+ Novo</button></div>${folderChips(pool)}`;
    const metaOf = (i) => {
      const meta = [ZF.typeLabel(i.type)];
      if (i.type === 'audio') meta.push(ZF.fmtDuration(i.duration));
      if (i.data) meta.push(dataUrlSizeKb(i.data) + ' KB');
      else if (i.mediaKb) meta.push(i.mediaKb + ' KB');
      return meta.join(' · ');
    };
    const srch = (i) => esc(ZF.normalizeText([i.name, i.text, i.caption, i.shortcut, i.folder, i.filename].join(' ')));
    if (!items.length) h += `<div class="empty">${pool.length ? 'Nada nesta pasta.' : 'Nada aqui ainda. Clique em <b>+ Novo</b>.'}</div>`;
    else if (listMode) {
      h += '<div class="list" id="grid">';
      items.forEach((i, n) => {
        const sub = i.type === 'text' ? esc((i.text || '').slice(0, 140)) : esc(metaOf(i)) + (i.caption ? ' · ' + esc(i.caption.slice(0, 80)) : '');
        h += `<div class="lrow card" data-row="${i.id}" data-search="${srch(i)}">
          <span class="grip" title="Arraste para mudar a ordem">⋮⋮</span><span class="lnum">${n + 1}</span>
          <span class="licon">${ZF.typeIcon(i.type)}</span>
          <div class="lmain"><div class="lname">${esc(i.name)} ${i.shortcut ? `<span class="tag">/${esc(i.shortcut)}</span>` : ''}${ftag(i)}</div><div class="lsub">${sub}</div></div>
          ${i.type !== 'text' && i.type !== 'document' ? `<div class="lprev">${mediaPreview(i)}</div>` : ''}
          <div class="lact"><button class="btn sm sec" data-top="${i.id}" title="Mandar para o topo">⤒</button><button class="btn sm sec" data-up="${i.id}" title="Subir">↑</button><button class="btn sm sec" data-down="${i.id}" title="Descer">↓</button>
          <button class="btn sm sec" data-edit="${i.id}">Editar</button><button class="btn sm sec" data-fold="${i.id}" title="Mover para pasta">📁</button><button class="btn sm sec" data-dup="${i.id}" title="Duplicar">⧉</button><button class="btn sm red" data-del="${i.id}" title="Excluir">✕</button></div></div>`;
      });
      h += '</div>';
    } else {
      h += '<div class="grid" id="grid">';
      items.forEach((i) => {
        let preview = '';
        if (i.type === 'text') preview = `<div class="body">${esc(i.text)}</div>`;
        else if (i.type === 'document') preview = `<div class="body">📎 ${esc(i.filename || 'arquivo')}</div>`;
        else preview = mediaPreview(i);
        if (i.caption) preview += `<div class="body">${esc(i.caption)}</div>`;
        h += `<div class="card" data-row="${i.id}" data-search="${srch(i)}">
          <h3><span class="grip" title="Arraste para mudar a ordem">⋮⋮</span>${ZF.typeIcon(i.type)} ${esc(i.name)} ${i.shortcut ? `<span class="tag">/${esc(i.shortcut)}</span>` : ''}${ftag(i)}</h3>
          <div class="meta">${metaOf(i)}</div>${preview}
          <div class="actions"><button class="btn sm sec" data-up="${i.id}" title="Mover para cima">↑</button><button class="btn sm sec" data-down="${i.id}" title="Mover para baixo">↓</button>
          <button class="btn sm sec" data-edit="${i.id}">Editar</button>
          <button class="btn sm sec" data-fold="${i.id}" title="Mover para pasta">📁</button>
          <button class="btn sm sec" data-dup="${i.id}">Duplicar</button>
          <button class="btn sm red" data-del="${i.id}">Excluir</button></div></div>`;
      });
      h += '</div>';
    }
    $('#main').innerHTML = h;
    $('#newItem').onclick = () => editItem(null, filter === 'media' && mediaSub !== 'all' ? mediaSub : info.newType);
    const q = $('#q');
    if (q) q.oninput = () => {
      const v = ZF.normalizeText(q.value);
      $$('#grid [data-search]').forEach((c) => (c.style.display = c.dataset.search.includes(v) ? '' : 'none'));
    };
    bindViewToggle(renderItems);
    bindFolderChips(renderItems);
    $$('[data-fold]').forEach((b) => (b.onclick = () => moveToFolder('items', b.dataset.fold, renderItems)));
    bindPreviews($('#main'));
    $$('[data-edit]').forEach((b) => (b.onclick = () => editItem(DB.items.find((i) => i.id === b.dataset.edit))));
    $$('[data-ms]').forEach((b) => (b.onclick = () => { mediaSub = b.dataset.ms; renderItems(); }));
    const inGroup = (x) => shownTypes.includes(x.type) && folderMatch(x, curFolder);
    if ($('#grid')) makeSortable($('#grid'), (id, target, after) => reorder('items', id, target, after, inGroup, renderItems));
    $$('[data-top]').forEach((b) => (b.onclick = () => moveEdge('items', b.dataset.top, true, inGroup, renderItems)));
    $$('[data-up]').forEach((b) => (b.onclick = () => moveIn('items', b.dataset.up, -1, inGroup, renderItems)));
    $$('[data-down]').forEach((b) => (b.onclick = () => moveIn('items', b.dataset.down, 1, inGroup, renderItems)));
    $$('[data-dup]').forEach((b) => (b.onclick = async () => {
      const src = DB.items.find((i) => i.id === b.dataset.dup);
      const full = await ZF.withMedia(src); // a cópia leva o próprio arquivo
      DB.items.splice(DB.items.indexOf(src) + 1, 0, Object.assign({}, full, { id: ZF.uid(), name: src.name + ' (cópia)', shortcut: '' }));
      await persist('items');
      renderItems();
    }));
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const it = DB.items.find((i) => i.id === b.dataset.del);
      const used = DB.funnels.filter((f) => f.steps.some((s) => s.itemId === it.id)).map((f) => f.name);
      await removeWithUndo('items', it.id, it.name, { warn: used.length ? 'usado em: ' + used.join(', ') + ' (essas etapas serão puladas)' : '' });
    }));
  }

  async function editItem(item, newType) {
    if (item && item.hasMedia && !item.data) {
      item = await ZF.withMedia(item); // carrega o arquivo só ao abrir para editar
      if (!item.data) toast('Arquivo deste item não encontrado — envie de novo');
    }
    const isNew = !item;
    item = item ? Object.assign({}, item) : { id: ZF.uid(), type: newType, name: '', text: '', caption: '', shortcut: '' };
    const typeSel = isNew
      ? `<label>Tipo</label><select id="fType">
          <option value="text">💬 Mensagem</option><option value="audio">🎤 Áudio</option>
          <option value="image">🖼️ Imagem</option><option value="video">🎬 Vídeo</option><option value="document">📄 Documento</option></select>`
      : `<div class="meta">${ZF.typeIcon(item.type)} ${ZF.typeLabel(item.type)}</div>`;
    openModal(`<h2>${isNew ? 'Novo item' : 'Editar item'}</h2>${typeSel}
      <div class="row2"><div><label>Nome</label><input type="text" id="fName" value="${esc(item.name)}" placeholder="Ex: Boas-vindas"></div>
      <div><label>Atalho (opcional)</label><input type="text" id="fShort" value="${esc(item.shortcut || '')}" placeholder="ex: oi"><div class="hint">No WhatsApp digite /atalho e aperte Tab</div></div></div>
      <div class="row2">${folderField(isNew ? null : item.folder || '')}<div></div></div>
      <div id="fBody"></div>
      <div class="modal-foot"><button class="btn sec" id="cancel">Cancelar</button><button class="btn" id="saveItem">Salvar</button></div>`);
    if (isNew) $('#fType').value = item.type;
    let pending = item.data ? { data: item.data, mime: item.mime, duration: item.duration, filename: item.filename } : null;

    const body = () => {
      const t = item.type;
      let h = '';
      if (t === 'text') {
        h = `<label>Mensagem</label><textarea id="fText" placeholder="{Saudacao}, {primeiro_nome}! Tudo bem?">${esc(item.text || '')}</textarea>${varBtns()}
          <div class="hint">Formatação do WhatsApp funciona: *negrito*, _itálico_, ~riscado~.</div>`;
      } else {
        const accept = { audio: 'audio/*,.ogg,.opus,.mp3,.m4a,.wav', image: 'image/*', video: 'video/*', document: '*/*' }[t];
        h = `<label>Arquivo</label><input type="file" id="fFile" accept="${accept}">
          <div id="fPrev" class="hint">${pending ? 'Arquivo atual: ' + esc(pending.filename || ZF.typeLabel(t)) + ' (' + dataUrlSizeKb(pending.data) + ' KB)' : 'Nenhum arquivo.'}</div>`;
        if (t === 'audio') {
          h += `<div class="rec" id="recBox"><button class="btn sec" id="recBtn" type="button">🎙️ Gravar agora</button><span id="recInfo" class="hint"></span></div>
            <label class="inline"><input type="checkbox" id="fAsFile" ${item.asFile ? 'checked' : ''}> Enviar como arquivo de música (não como áudio de voz)</label>`;
        } else {
          h += `<label>Legenda (opcional)</label><textarea id="fCaption" style="min-height:70px">${esc(item.caption || '')}</textarea>${varBtns()}`;
          if (t === 'image' || t === 'video') h += `<label class="inline"><input type="checkbox" id="fViewOnce" ${item.viewOnce ? 'checked' : ''}> Visualização única</label>`;
        }
        h += `<div id="fPlayer" style="margin-top:8px"></div>`;
      }
      $('#fBody').innerHTML = h;
      if (t === 'text') bindVarButtons(() => $('#fText'));
      else if ($('#fCaption')) bindVarButtons(() => $('#fCaption'));
      const showPlayer = () => {
        if (!pending || !$('#fPlayer')) return;
        if (t === 'audio') $('#fPlayer').innerHTML = `<audio controls src="${pending.data}"></audio> <span class="hint">${ZF.fmtDuration(pending.duration)}</span>`;
        if (t === 'image') $('#fPlayer').innerHTML = `<img src="${pending.data}" style="max-height:160px;border-radius:8px">`;
        if (t === 'video') $('#fPlayer').innerHTML = `<video src="${pending.data}" controls style="max-height:180px"></video>`;
      };
      showPlayer();
      const fileIn = $('#fFile');
      if (fileIn) fileIn.onchange = async () => {
        const f = fileIn.files[0];
        if (!f) return;
        $('#fPrev').textContent = 'Processando…';
        try {
          if (t === 'audio') pending = await prepareAudio(f, f.name);
          else pending = { data: await fileToDataUrl(f), mime: f.type || undefined, filename: f.name };
          if (t === 'video' && pending && dataUrlSizeKb(pending.data) > 16000) toast('Atenção: vídeos acima de ~16 MB podem falhar no WhatsApp.');
          if (!$('#fName').value) $('#fName').value = f.name.replace(/\.\w+$/, '');
          $('#fPrev').textContent = 'Arquivo: ' + (pending.filename || f.name) + ' (' + dataUrlSizeKb(pending.data) + ' KB)';
          showPlayer();
        } catch (e) {
          $('#fPrev').textContent = e.message;
          pending = null;
        }
      };
      const recBtn = $('#recBtn');
      if (recBtn) recBtn.onclick = () => toggleRecord(async (blob) => {
        $('#recInfo').textContent = 'Convertendo…';
        try {
          pending = await prepareAudio(blob, 'gravacao.webm');
          if (!$('#fName').value) $('#fName').value = 'Áudio ' + new Date().toLocaleString('pt-BR');
          $('#fPrev').textContent = 'Gravação pronta (' + dataUrlSizeKb(pending.data) + ' KB)';
          $('#recInfo').textContent = '';
          showPlayer();
        } catch (e) {
          $('#recInfo').textContent = e.message;
        }
      });
    };
    body();
    if (isNew) $('#fType').onchange = () => {
      item.type = $('#fType').value;
      pending = null;
      body();
    };
    $('#cancel').onclick = closeModal;
    $('#saveItem').onclick = async () => {
      item.name = $('#fName').value.trim();
      item.shortcut = $('#fShort').value.trim().replace(/^\//, '').replace(/\s+/g, '');
      const fold = $('#fFolder').value.trim().slice(0, 40);
      if (fold) item.folder = fold;
      else delete item.folder;
      if (!item.name) return toast('Dê um nome ao item');
      if (item.shortcut) {
        const dupe = DB.items.concat(DB.funnels).find((x) => x.id !== item.id && x.shortcut && ZF.normalizeText(x.shortcut) === ZF.normalizeText(item.shortcut));
        if (dupe) return toast('Atalho já usado em "' + dupe.name + '"');
      }
      if (item.type === 'text') {
        item.text = $('#fText').value;
        if (!item.text.trim()) return toast('Escreva a mensagem');
        delete item.data;
        delete item.hasMedia;
        delete item.mediaKb;
      } else {
        if (!pending) return toast('Escolha um arquivo' + (item.type === 'audio' ? ' ou grave um áudio' : ''));
        Object.assign(item, pending);
        if ($('#fCaption')) item.caption = $('#fCaption').value;
        if ($('#fViewOnce')) item.viewOnce = $('#fViewOnce').checked;
        if ($('#fAsFile')) item.asFile = $('#fAsFile').checked;
      }
      const idx = DB.items.findIndex((i) => i.id === item.id);
      if (idx >= 0) DB.items[idx] = item;
      else DB.items.push(item);
      try {
        await persist('items');
      } catch (e) {
        return toast(/context invalidated/i.test(e.message) ? 'A extensão foi atualizada: recarregue esta página (F5) e salve de novo.' : 'Erro ao salvar: ' + e.message);
      }
      closeModal();
      toast('Salvo!');
      if (item.type === 'image' || item.type === 'video') filter = 'media';
      else filter = item.type;
      setView('items', filter);
    };
  }

  // Gravador de áudio
  let recState = null;
  function toggleRecord(onDone) {
    if (recState) return window.__stopRec(false);
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then((stream) => {
      const mr = new MediaRecorder(stream);
      const chunks = [];
      const start = Date.now();
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recState = { mr, stream, discard: false };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const discard = recState && recState.discard;
        recState = null;
        clearInterval(iv);
        const b = $('#recBtn');
        if (b) b.textContent = '🎙️ Gravar agora';
        if (!discard) onDone(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }));
      };
      mr.start(250);
      $('#recBtn').textContent = '⏹ Parar gravação';
      const iv = setInterval(() => {
        const i = $('#recInfo');
        if (i) i.innerHTML = '<span class="dot" style="display:inline-block"></span> Gravando ' + ZF.fmtDuration((Date.now() - start) / 1000);
      }, 300);
    }).catch((e) => toast('Microfone bloqueado: ' + e.message));
  }
  window.__stopRec = (discard) => {
    if (!recState) return;
    recState.discard = !!discard;
    recState.mr.stop();
  };

  // ------------------------------------------------------------ FUNIS
  const UNIT = ZF.UNIT;
  const fmtDelay = ZF.fmtDelay;
  function fmtTotal(sec) {
    sec = Math.round(sec);
    if (sec >= 3600) return Math.floor(sec / 3600) + 'h' + String(Math.round((sec % 3600) / 60)).padStart(2, '0');
    return ZF.fmtDuration(sec);
  }
  function funnelTime(f) {
    const s = DB.settings;
    let total = 0;
    f.steps.forEach((st) => {
      if (st.kind === 'wait_reply') return;
      // o intervalo já inclui o "digitando/gravando"; sem intervalo, conta só a simulação
      const delay = Number(st.delay) || 0;
      const it = DB.items.find((i) => i.id === st.itemId);
      let sim = 0;
      if (it && st.simulate !== false) {
        if (it.type === 'text') sim = Math.min(s.typingMax, Math.max(s.typingMin, (it.text || '').length / s.typingCps));
        else if (it.type === 'audio') sim = Math.min(s.recordingMax, Math.max(2, (it.duration || 5) * s.recordingFactor));
        else sim = 1.5;
      }
      total += delay || sim;
    });
    return total;
  }
  function renderFunnels() {
    let h = `<h1>Funis</h1><p class="sub">Sequências de mensagens, áudios e mídias com intervalos, digitação/gravação simulada e espera pela resposta do lead. No painel ⚡ e na barra do WhatsApp os funis aparecem primeiro, nesta ordem — arraste pelo ⋮⋮ ou use ↑ ↓.</p>
      <div class="bar"><input type="search" id="q" placeholder="Buscar funil…" style="max-width:320px">${viewToggle()}<span class="grow"></span><button class="btn" id="newF">+ Novo funil</button></div>${folderChips(DB.funnels)}`;
    const shownF = DB.funnels.filter((f) => folderMatch(f, curFolder));
    const fsrch = (f) => esc(ZF.normalizeText([f.name, f.shortcut, f.folder].concat(f.steps.map((st) => ((DB.items.find((x) => x.id === st.itemId) || {}).name || ''))).join(' ')));
    if (!shownF.length) h += `<div class="empty">${DB.funnels.length ? 'Nenhum funil nesta pasta.' : 'Nenhum funil ainda.'}</div>`;
    else {
      h += `<div class="${listMode ? 'list' : 'grid'}" id="fgrid">`;
      shownF.forEach((f, n) => {
        const steps = f.steps.map((s, i) => {
          if (s.kind === 'wait_reply') {
            const lbl = (v) => (!v || v === 'continue' ? 'continua' : v === 'stop' ? 'para' : '→ ' + esc(targetName(...v.split(/:(.*)/s).slice(0, 2))));
            return `${i + 1}. ⏳ Aguardar resposta${s.timeoutMin ? ' (' + s.timeoutMin + ' min)' : ''} · respondeu: ${lbl(s.onReply)} · não respondeu: ${lbl(s.onTimeout)}`;
          }
          const it = DB.items.find((x) => x.id === s.itemId);
          return `${i + 1}. ${s.delay ? '⏱ ' + fmtDelay(s.delay) + ' → ' : ''}${it ? ZF.typeIcon(it.type) + ' ' + esc(it.name) : '<i>(item apagado)</i>'}`;
        });
        if (listMode) {
          const icons = f.steps.map((st) => (st.kind === 'wait_reply' ? '⏳' : ZF.typeIcon((DB.items.find((x) => x.id === st.itemId) || {}).type || 'text'))).join('');
          h += `<div class="lrow card" data-row="${f.id}" data-search="${fsrch(f)}"><span class="grip" title="Arraste para mudar a ordem">⋮⋮</span><span class="lnum">${n + 1}</span><span class="licon">🔁</span>
            <div class="lmain"><div class="lname">${esc(f.name)} ${f.shortcut ? `<span class="tag">/${esc(f.shortcut)}</span>` : ''}${ftag(f)}</div><div class="lsub">${f.steps.length} etapa(s) · ~${fmtTotal(funnelTime(f))} · ${icons}</div></div>
            <div class="lact"><button class="btn sm sec" data-top="${f.id}" title="Mandar para o topo">⤒</button><button class="btn sm sec" data-up="${f.id}" title="Subir">↑</button><button class="btn sm sec" data-down="${f.id}" title="Descer">↓</button>
            <button class="btn sm sec" data-edit="${f.id}">Editar</button><button class="btn sm sec" data-fold="${f.id}" title="Mover para pasta">📁</button><button class="btn sm sec" data-dup="${f.id}" title="Duplicar">⧉</button><button class="btn sm red" data-del="${f.id}" title="Excluir">✕</button></div></div>`;
          return;
        }
        h += `<div class="card" data-row="${f.id}" data-search="${fsrch(f)}"><h3><span class="grip" title="Arraste para mudar a ordem">⋮⋮</span>🔁 ${esc(f.name)} ${f.shortcut ? `<span class="tag">/${esc(f.shortcut)}</span>` : ''}${ftag(f)}</h3>
          <div class="meta">${f.steps.length} etapa(s) · ~${fmtTotal(funnelTime(f))} do início ao fim</div>
          <div class="body">${steps.join('<br>')}</div>
          <div class="actions"><button class="btn sm sec" data-up="${f.id}" title="Mover para cima">↑</button><button class="btn sm sec" data-down="${f.id}" title="Mover para baixo">↓</button>
          <button class="btn sm sec" data-edit="${f.id}">Editar</button>
          <button class="btn sm sec" data-fold="${f.id}" title="Mover para pasta">📁</button>
          <button class="btn sm sec" data-dup="${f.id}">Duplicar</button>
          <button class="btn sm red" data-del="${f.id}">Excluir</button></div></div>`;
      });
      h += '</div>';
    }
    $('#main').innerHTML = h;
    $('#newF').onclick = () => editFunnel(null);
    $$('[data-edit]').forEach((b) => (b.onclick = () => editFunnel(DB.funnels.find((f) => f.id === b.dataset.edit))));
    bindViewToggle(renderFunnels);
    bindFolderChips(renderFunnels);
    const q = $('#q');
    if (q) q.oninput = () => {
      const v = ZF.normalizeText(q.value);
      $$('#fgrid [data-search]').forEach((c) => (c.style.display = c.dataset.search.includes(v) ? '' : 'none'));
    };
    const inG = (x) => folderMatch(x, curFolder);
    $$('[data-fold]').forEach((b) => (b.onclick = () => moveToFolder('funnels', b.dataset.fold, renderFunnels)));
    if ($('#fgrid')) makeSortable($('#fgrid'), (id, target, after) => reorder('funnels', id, target, after, inG, renderFunnels));
    $$('[data-top]').forEach((b) => (b.onclick = () => moveEdge('funnels', b.dataset.top, true, inG, renderFunnels)));
    $$('[data-up]').forEach((b) => (b.onclick = () => moveIn('funnels', b.dataset.up, -1, inG, renderFunnels)));
    $$('[data-down]').forEach((b) => (b.onclick = () => moveIn('funnels', b.dataset.down, 1, inG, renderFunnels)));
    $$('[data-dup]').forEach((b) => (b.onclick = async () => {
      const f = DB.funnels.find((x) => x.id === b.dataset.dup);
      DB.funnels.splice(DB.funnels.indexOf(f) + 1, 0, JSON.parse(JSON.stringify(Object.assign({}, f, { id: ZF.uid(), name: f.name + ' (cópia)', shortcut: '' }))));
      await persist('funnels');
      renderFunnels();
    }));
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const f = DB.funnels.find((x) => x.id === b.dataset.del);
      const usedBy = DB.remarketing.filter((r) => (r.triggers || []).includes('funnel:' + f.id) || r.stages.some((x) => x.targetType === 'funnel' && x.targetId === f.id)).length + DB.triggers.filter((t) => t.targetType === 'funnel' && t.targetId === f.id).length;
      await removeWithUndo('funnels', f.id, f.name, { warn: usedBy ? 'usado em ' + usedBy + ' regra(s)/gatilho(s)' : '' });
    }));
  }

  function editFunnel(f) {
    const isNew = !f;
    f = f ? JSON.parse(JSON.stringify(f)) : { id: ZF.uid(), name: '', shortcut: '', steps: [] };
    if (!DB.items.length) return toast('Crie primeiro mensagens/áudios/mídias para montar o funil');
    openModal(`<h2>${isNew ? 'Novo funil' : 'Editar funil'}</h2>
      <div class="row2"><div><label>Nome</label><input type="text" id="fName" value="${esc(f.name)}" placeholder="Ex: Funil de boas-vindas"></div>
      <div><label>Atalho (opcional)</label><input type="text" id="fShort" value="${esc(f.shortcut || '')}"></div></div>
      <div class="row2">${folderField(isNew ? null : f.folder || '')}<div></div></div>
      <label>Etapas</label><div id="steps"></div>
      <div class="bar"><button class="btn sec sm" id="addStep">+ Adicionar envio</button><button class="btn sec sm" id="addWait">+ Aguardar resposta do lead</button></div>
      <div class="hint">"Esperar" = tempo total entre a mensagem anterior e esta (o "digitando/gravando" acontece dentro desse tempo). "Aguardar resposta" pode seguir um caminho se o lead responder e outro se não responder.</div>
      <div class="modal-foot"><button class="btn sec" id="cancel">Cancelar</button><button class="btn" id="saveF">Salvar</button></div>`);
    // com pastas, a lista de itens vem agrupada por pasta
    const itemOpts = (sel) => {
      const opt = (i) => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${ZF.typeIcon(i.type)} ${esc(i.name)}</option>`;
      const fl = ZF.folders(DB.items);
      if (!fl.length) return DB.items.map(opt).join('');
      return fl.map((fo) => `<optgroup label="📁 ${esc(fo)}">${DB.items.filter((i) => folderOf(i) === fo).map(opt).join('')}</optgroup>`).join('')
        + (DB.items.some((i) => !folderOf(i)) ? `<optgroup label="Sem pasta">${DB.items.filter((i) => !folderOf(i)).map(opt).join('')}</optgroup>` : '');
    };
    const collect = () => {
      $$('#steps .step').forEach((row, i) => {
        const st = f.steps[i];
        if (st.kind === 'wait_reply') {
          st.timeoutMin = Number($('.tmo', row).value) || 0;
          st.onTimeout = $('.ont', row).value;
          st.onReply = $('.onr', row).value;
        } else {
          st.itemId = $('.it', row).value;
          st.delayUnit = $('.du', row).value;
          st.delay = Math.round(Math.max(0, Number($('.dl', row).value) || 0) * UNIT[st.delayUnit]);
          st.simulate = $('.sim', row).checked;
        }
      });
    };
    const draw = () => {
      $('#steps').innerHTML = f.steps.length ? '' : '<div class="hint">Nenhuma etapa.</div>';
      f.steps.forEach((st, i) => {
        const row = document.createElement('div');
        row.className = 'step';
        row.dataset.row = String(i);
        if (st.kind === 'wait_reply') {
          const branchOpts = (cur, base) => base + DB.funnels.filter((x) => x.id !== f.id).map((x) => `<option value="funnel:${x.id}" ${cur === 'funnel:' + x.id ? 'selected' : ''}>enviar 🔁 ${esc(x.name)} (e parar)</option>`).join('')
            + DB.items.map((x) => `<option value="item:${x.id}" ${cur === 'item:' + x.id ? 'selected' : ''}>enviar ${ZF.typeIcon(x.type)} ${esc(x.name)} (e parar)</option>`).join('');
          const onR = st.onReply || 'continue', onT = st.onTimeout || 'continue';
          row.innerHTML = `<span class="num">${i + 1}</span><div style="flex:1;display:grid;gap:6px">
            <div>⏳ <b>Aguardar resposta</b> por até <input type="number" class="tmo" min="0" value="${st.timeoutMin || 0}" style="width:80px"> min <span class="hint">(0 = sem limite)</span></div>
            <div>✅ Se responder: <select class="onr" style="min-width:200px">${branchOpts(onR, `<option value="continue" ${onR === 'continue' ? 'selected' : ''}>continuar o funil</option><option value="stop" ${onR === 'stop' ? 'selected' : ''}>parar o funil</option>`)}</select></div>
            <div>⌛ Se não responder: <select class="ont" style="min-width:200px">${branchOpts(onT, `<option value="continue" ${onT === 'continue' ? 'selected' : ''}>continuar o funil</option><option value="stop" ${onT === 'stop' ? 'selected' : ''}>parar o funil</option>`)}</select></div></div>`;
        } else {
          const u = st.delayUnit && UNIT[st.delayUnit] ? st.delayUnit : 's';
          const shown = +((st.delay || 0) / UNIT[u]).toFixed(2);
          row.innerHTML = `<span class="num">${i + 1}</span><select class="it">${itemOpts(st.itemId)}</select>
            Esperar <input type="number" class="dl" min="0" step="any" value="${shown}">
            <select class="du" style="flex:0;min-width:90px"><option value="s" ${u === 's' ? 'selected' : ''}>segundos</option><option value="m" ${u === 'm' ? 'selected' : ''}>minutos</option><option value="h" ${u === 'h' ? 'selected' : ''}>horas</option><option value="d" ${u === 'd' ? 'selected' : ''}>dias</option></select>
            <label class="inline" style="margin:0"><input type="checkbox" class="sim" ${st.simulate !== false ? 'checked' : ''}> digitando/gravando</label>`;
        }
        const ctr = document.createElement('span');
        ctr.innerHTML = `<button class="btn sm sec" data-a="up">↑</button> <button class="btn sm sec" data-a="down">↓</button> <button class="btn sm red" data-a="rm">✕</button>`;
        ctr.onclick = (e) => {
          const a = e.target.dataset.a;
          if (!a) return;
          collect();
          if (a === 'rm') f.steps.splice(i, 1);
          if (a === 'up' && i > 0) [f.steps[i - 1], f.steps[i]] = [f.steps[i], f.steps[i - 1]];
          if (a === 'down' && i < f.steps.length - 1) [f.steps[i + 1], f.steps[i]] = [f.steps[i], f.steps[i + 1]];
          draw();
        };
        row.appendChild(ctr);
        const grip = document.createElement('span');
        grip.className = 'grip';
        grip.title = 'Arraste para mudar a ordem';
        grip.textContent = '⋮⋮';
        row.prepend(grip);
        $('#steps').appendChild(row);
      });
      makeSortable($('#steps'), (from, to, after) => {
        collect();
        const a = Number(from), b = Number(to);
        const [mv] = f.steps.splice(a, 1);
        let t = b > a ? b - 1 : b;
        if (after) t++;
        f.steps.splice(t, 0, mv);
        draw();
      });
    };
    draw();
    $('#addStep').onclick = () => {
      collect();
      f.steps.push({ kind: 'send', itemId: DB.items[0].id, delay: f.steps.length ? 3 : 0, simulate: true });
      draw();
    };
    $('#addWait').onclick = () => {
      collect();
      f.steps.push({ kind: 'wait_reply', timeoutMin: 0, onTimeout: 'continue', onReply: 'continue' });
      draw();
    };
    $('#cancel').onclick = closeModal;
    $('#saveF').onclick = async () => {
      collect();
      f.name = $('#fName').value.trim();
      f.shortcut = $('#fShort').value.trim().replace(/^\//, '').replace(/\s+/g, '');
      const fold = $('#fFolder').value.trim().slice(0, 40);
      if (fold) f.folder = fold;
      else delete f.folder;
      if (!f.name) return toast('Dê um nome ao funil');
      if (!f.steps.some((s) => s.kind !== 'wait_reply')) return toast('Adicione pelo menos um envio');
      if (f.shortcut) {
        const dupe = DB.items.concat(DB.funnels).find((x) => x.id !== f.id && x.shortcut && ZF.normalizeText(x.shortcut) === ZF.normalizeText(f.shortcut));
        if (dupe) return toast('Atalho já usado em "' + dupe.name + '"');
      }
      const idx = DB.funnels.findIndex((x) => x.id === f.id);
      if (idx >= 0) DB.funnels[idx] = f;
      else DB.funnels.push(f);
      await persist('funnels');
      closeModal();
      toast('Funil salvo!');
      renderFunnels();
    };
  }


  // ------------------------------------------------------------ REMARKETING
  const RM_MODE = {
    no_reply: { label: 'Se não responder', desc: 'Depois do funil, se o lead não responder em X tempo, envia a etapa 1. Se continuar sem responder, etapa 2… Respondeu = para tudo.' },
    on_reply: { label: 'Se responder', desc: 'Depois do funil, quando o lead responder, envia a etapa 1 (X tempo depois da resposta dele). Se ele responder de novo, envia a etapa 2… Se ele não responder dentro do prazo, encerra.' },
    inactive: { label: 'Conversa parou', desc: 'Para conversas que esfriaram: se a última mensagem foi sua e o lead sumiu por X tempo, envia. Se ele responder, o relógio zera e espera você responder de novo.' }
  };
  const RM_STATUS = {
    waiting: ['Aguardando', 'run'], sending: ['Enviando', 'run'], done: ['Concluído', ''], replied: ['Respondeu ✅', ''],
    cancelled: ['Cancelado', 'off'], error: ['Erro', 'err'], expired: ['Expirado', 'off']
  };
  let rmShowAll = false;
  function renderRemarketing() {
    const q = DB.rmktQueue || [];
    const active = q.filter((e) => e.status === 'waiting' || e.status === 'sending');
    const stats = (rid) => {
      const mine = q.filter((e) => e.ruleId === rid);
      return { active: mine.filter((e) => e.status === 'waiting' || e.status === 'sending').length, replied: mine.filter((e) => e.status === 'replied').length, done: mine.filter((e) => e.status === 'done').length };
    };
    let h = `<h1>Remarketing</h1><p class="sub">Sequências automáticas de follow-up que só disparam se o lead <b>não responder</b>. Ficam salvas: se fechar o WhatsApp Web, continuam quando abrir de novo.</p>
      <div class="bar"><span class="grow"></span><button class="btn" id="newR">+ Nova regra de remarketing</button></div>`;
    if (!DB.remarketing.length) h += `<div class="empty">Nenhuma regra ainda.<br><br>Exemplo: <i>Funil 1 enviado → sem resposta em 2h → Mensagem "Viu meu áudio?" → sem resposta em 1 dia → Funil de remarketing</i></div>`;
    else {
      h += '<div class="grid">';
      DB.remarketing.forEach((r) => {
        const st = stats(r.id);
        const trig = (r.triggers || []).map((t) => { const p = parseTarget(t); return esc(targetName(p.targetType, p.targetId)); }).join(', ') || '<i>só manual (botão 🔔 no WhatsApp)</i>';
        const steps = r.stages.map((x, i) => `${i + 1}. sem resposta ${fmtDelay(x.delay)} → ${esc(targetName(x.targetType, x.targetId))}`).join('<br>');
        h += `<div class="card"><h3>🔔 ${esc(r.name)} ${r.enabled ? '<span class="tag">Ativa</span>' : '<span class="tag off">Pausada</span>'}</h3>
          <div class="meta">${RM_MODE[r.mode || 'no_reply'].label} · depois de: ${trig}</div>
          <div class="body">${steps}</div>
          <div class="meta">${r.window && r.window.enabled ? '🕘 só ' + esc(r.window.start) + '–' + esc(r.window.end) + ' · ' : ''}👥 ${st.active} na fila · ✅ ${st.replied} responderam · ${st.done} concluíram</div>
          <div class="actions"><button class="btn sm sec" data-edit="${r.id}">Editar</button>
          <button class="btn sm sec" data-tog="${r.id}">${r.enabled ? 'Pausar' : 'Ativar'}</button>
          <button class="btn sm sec" data-dup="${r.id}">Duplicar</button>
          <button class="btn sm red" data-del="${r.id}">Excluir</button></div></div>`;
      });
      h += '</div>';
    }
    const list = (rmShowAll ? q.slice() : active).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 500);
    h += `<h2 style="margin-top:28px;font-size:18px">Contatos no remarketing</h2>
      <div class="bar"><label class="inline"><input type="checkbox" id="rmAll" ${rmShowAll ? 'checked' : ''}> Mostrar finalizados também</label><span class="grow"></span>
      <button class="btn sec sm" id="rmClear">Limpar finalizados</button></div>`;
    if (!list.length) h += `<div class="empty">${rmShowAll ? 'Nada ainda.' : 'Nenhum contato aguardando remarketing agora.'}</div>`;
    else {
      h += '<table><tr><th>Contato</th><th>Regra</th><th>Etapa</th><th>Próximo envio</th><th>Status</th><th></th></tr>';
      list.forEach((e) => {
        const r = DB.remarketing.find((x) => x.id === e.ruleId);
        const total = r ? r.stages.length : '?';
        const s = RM_STATUS[e.status] || [e.status, ''];
        let next = '-';
        if (e.status === 'waiting') next = e.dueAt ? fmtDate(e.dueAt) : (e.mode === 'inactive' ? 'esperando você responder o lead' : e.mode === 'on_reply' ? 'esperando o lead responder' + (e.expireAt ? ' (até ' + fmtDate(e.expireAt) + ')' : '') : '-');
        if (r && !r.enabled && e.status === 'waiting') next += ' (regra pausada)';
        h += `<tr><td><b>${esc(e.name || '')}</b> <span class="hint">${esc(e.chatId.replace(/@.*/, ''))}</span></td><td>${esc(r ? r.name : '(apagada)')}</td>
          <td>${Math.min(e.stageIdx + (e.status === 'done' ? 0 : 1), total)}/${total}</td><td>${next}</td>
          <td><span class="tag ${s[1]}">${s[0]}</span>${e.reason && e.status !== 'waiting' ? `<div class="hint">${esc(e.reason)}</div>` : ''}${e.lastError && e.status === 'waiting' ? `<div class="hint" style="color:var(--red)">tentando de novo: ${esc(e.lastError)}</div>` : ''}</td>
          <td>${e.status === 'waiting' ? `<button class="btn sm red" data-cancel="${e.id}">Parar</button>` : ''}</td></tr>`;
      });
      h += '</table>';
    }
    $('#main').innerHTML = h;
    $('#newR').onclick = () => editRemarketing(null);
    $('#rmAll').onchange = () => { rmShowAll = $('#rmAll').checked; renderRemarketing(); };
    $('#rmClear').onclick = async () => {
      await updateQueue((qq) => qq.filter((e) => e.status === 'waiting' || e.status === 'sending'));
      renderRemarketing();
    };
    $$('[data-cancel]').forEach((b) => (b.onclick = async () => {
      await updateQueue((qq) => qq.map((e) => (e.id === b.dataset.cancel && e.status === 'waiting' ? Object.assign({}, e, { status: 'cancelled', reason: 'parado manualmente', endedAt: Date.now() }) : e)));
      renderRemarketing();
    }));
    $$('[data-edit]').forEach((b) => (b.onclick = () => editRemarketing(DB.remarketing.find((r) => r.id === b.dataset.edit))));
    $$('[data-tog]').forEach((b) => (b.onclick = async () => {
      const r = DB.remarketing.find((x) => x.id === b.dataset.tog);
      r.enabled = !r.enabled;
      await persist('remarketing');
      renderRemarketing();
    }));
    $$('[data-dup]').forEach((b) => (b.onclick = async () => {
      const r = DB.remarketing.find((x) => x.id === b.dataset.dup);
      DB.remarketing.push(JSON.parse(JSON.stringify(Object.assign({}, r, { id: ZF.uid(), name: r.name + ' (cópia)', enabled: false }))));
      await persist('remarketing');
      renderRemarketing();
    }));
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const r = DB.remarketing.find((x) => x.id === b.dataset.del);
      const n = active.filter((e) => e.ruleId === r.id).length;
      const before = {};
      await removeWithUndo('remarketing', r.id, r.name, {
        warn: n ? n + ' contato(s) da fila cancelados' : '',
        after: () => updateQueue((qq) => qq.map((e) => {
          if (e.ruleId !== r.id || e.status !== 'waiting') return e;
          before[e.id] = e;
          return Object.assign({}, e, { status: 'cancelled', reason: 'regra apagada', endedAt: Date.now() });
        })),
        // desfazer: quem foi cancelado por causa da exclusão volta para a fila como estava
        undo: () => updateQueue((qq) => qq.map((e) => (before[e.id] && e.status === 'cancelled' && e.reason === 'regra apagada' ? before[e.id] : e)))
      });
    }));
  }
  // lê a fila mais recente antes de alterar (a aba do WhatsApp também mexe nela)
  async function updateQueue(fn) {
    const d = await chrome.storage.local.get('rmktQueue');
    DB.rmktQueue = fn(d.rmktQueue || []);
    await ZF.save({ rmktQueue: DB.rmktQueue });
  }

  function editRemarketing(r) {
    if (!DB.items.length && !DB.funnels.length) return toast('Crie mensagens/funis primeiro');
    const isNew = !r;
    r = r ? JSON.parse(JSON.stringify(r)) : {
      id: ZF.uid(), name: '', enabled: true, mode: 'no_reply', triggers: [],
      stages: [{ delay: 7200, delayUnit: 'h', targetType: '', targetId: '' }],
      stopOnManual: true, stopOnOtherFunnel: true, restartOnReply: true,
      window: { enabled: true, start: '08:00', end: '21:00', days: [0, 1, 2, 3, 4, 5, 6] }, maxLateHours: 0
    };
    const trigBoxes = DB.funnels.map((f) => ['funnel:' + f.id, '🔁 ' + f.name]).concat(DB.items.map((i) => ['item:' + i.id, ZF.typeIcon(i.type) + ' ' + i.name]))
      .map(([v, l]) => `<label class="inline" style="width:46%"><input type="checkbox" class="trg" value="${esc(v)}" ${(r.triggers || []).includes(v) ? 'checked' : ''}> ${esc(l)}</label>`).join('');
    const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const w = r.window || { enabled: false, start: '08:00', end: '21:00', days: [0, 1, 2, 3, 4, 5, 6] };
    openModal(`<h2>${isNew ? 'Nova regra de remarketing' : 'Editar remarketing'}</h2>
      <label>Nome</label><input type="text" id="rName" value="${esc(r.name)}" placeholder="Ex: Rmkt Funil 1">
      <label>Tipo</label><select id="rMode">${Object.entries(RM_MODE).map(([k, v]) => `<option value="${k}" ${r.mode === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      <div class="hint" id="rModeDesc"></div>
      <label>Começa quando eu enviar (marque um ou mais)</label>
      <div style="max-height:150px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:6px 10px">${trigBoxes}</div>
      <div class="hint">Vale para envio manual, gatilho, agendamento e disparo em massa. Sem nada marcado = só entra quem você colocar pelo botão 🔔 no WhatsApp.</div>
      <label>Etapas do remarketing</label><div id="rStages"></div>
      <button class="btn sec sm" id="rAdd" type="button">+ Adicionar etapa</button>
      <div class="hint" id="rStageHint"></div>
      <div class="section" style="margin-top:14px;padding:14px;background:var(--card2);box-shadow:none">
        <label class="inline"><input type="checkbox" id="rManual" ${r.stopOnManual !== false ? 'checked' : ''}> Parar se eu mandar mensagem manualmente para o lead</label><br>
        <label class="inline"><input type="checkbox" id="rOther" ${r.stopOnOtherFunnel !== false ? 'checked' : ''}> Parar se eu enviar outro funil para o lead</label><br>
        <label class="inline" id="rRestartBox"><input type="checkbox" id="rRestart" ${r.restartOnReply !== false ? 'checked' : ''}> Quando o lead responder, recomeçar da etapa 1</label>
        <div id="rReplyBox" style="margin-top:6px">Se o lead não responder em até <input type="number" id="rRw" min="0" value="${r.replyWindowHours == null ? 72 : r.replyWindowHours}" style="width:80px"> horas, encerrar <span class="hint">(0 = esperar para sempre)</span></div>
        <div style="margin-top:8px"><label class="inline"><input type="checkbox" id="rWin" ${w.enabled ? 'checked' : ''}> Só enviar no horário:</label>
          <input type="text" id="rWs" value="${esc(w.start)}" style="width:70px"> até <input type="text" id="rWe" value="${esc(w.end)}" style="width:70px">
          <div style="margin-top:6px">${dayNames.map((d, i) => `<label class="inline"><input type="checkbox" class="wd" value="${i}" ${(w.days || []).map(Number).includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
          <div class="hint">Fora do horário, a mensagem espera e sai no começo do próximo horário permitido.</div></div>
        <label>Se o WhatsApp Web estava fechado e atrasou mais de X horas, não enviar (0 = envia mesmo atrasado)</label>
        <input type="number" id="rLate" min="0" value="${r.maxLateHours || 0}" style="width:120px">
      </div>
      <label class="inline"><input type="checkbox" id="rEn" ${r.enabled ? 'checked' : ''}> Ativa</label>
      <div class="modal-foot"><button class="btn sec" id="cancel">Cancelar</button><button class="btn" id="saveR">Salvar</button></div>`);
    const syncMode = () => {
      const m = $('#rMode').value;
      $('#rModeDesc').textContent = RM_MODE[m].desc;
      $('#rRestartBox').style.display = m === 'inactive' ? '' : 'none';
      $('#rReplyBox').style.display = m === 'on_reply' ? '' : 'none';
      $('#rStageHint').textContent = m === 'inactive'
        ? 'Cada tempo conta a partir da sua última mensagem sem resposta.'
        : m === 'on_reply'
          ? 'Cada tempo conta a partir da resposta do lead (da última mensagem dele). Etapa 2 só depois de uma nova resposta.'
          : 'Etapa 1: tempo depois do funil. Demais etapas: tempo depois da etapa anterior. Só envia se o lead não respondeu.';
      $$('#rStages .lead').forEach((x) => (x.textContent = m === 'on_reply' ? 'Lead respondeu → esperar' : 'Sem resposta por'));
    };
    $('#rMode').onchange = syncMode;
    const collect = () => {
      $$('#rStages .step').forEach((row, i) => {
        const st = r.stages[i];
        st.delayUnit = $('.du', row).value;
        st.delay = Math.round(Math.max(0, Number($('.dl', row).value) || 0) * UNIT[st.delayUnit]);
        Object.assign(st, parseTarget($('.tg', row).value));
      });
    };
    const draw = () => {
      $('#rStages').innerHTML = '';
      r.stages.forEach((st, i) => {
        const u = st.delayUnit && UNIT[st.delayUnit] ? st.delayUnit : 'h';
        const row = document.createElement('div');
        row.className = 'step';
        row.innerHTML = `<span class="num">${i + 1}</span> <span class="lead">${$('#rMode') && $('#rMode').value === 'on_reply' ? 'Lead respondeu → esperar' : 'Sem resposta por'}</span> <input type="number" class="dl" min="0" step="any" value="${+((st.delay || 0) / UNIT[u]).toFixed(2)}">
          <select class="du" style="flex:0;min-width:95px">${Object.entries(ZF.UNIT_LABEL).map(([k, l]) => `<option value="${k}" ${k === u ? 'selected' : ''}>${l}</option>`).join('')}</select> → enviar
          <select class="tg"><option value="">— escolha —</option>${targetOptions(st.targetType, st.targetId)}</select>`;
        const ctr = document.createElement('span');
        ctr.innerHTML = `<button class="btn sm sec" data-a="up">↑</button> <button class="btn sm sec" data-a="down">↓</button> <button class="btn sm red" data-a="rm">✕</button>`;
        ctr.onclick = (e) => {
          const a = e.target.dataset.a;
          if (!a) return;
          collect();
          if (a === 'rm') r.stages.splice(i, 1);
          if (a === 'up' && i > 0) [r.stages[i - 1], r.stages[i]] = [r.stages[i], r.stages[i - 1]];
          if (a === 'down' && i < r.stages.length - 1) [r.stages[i + 1], r.stages[i]] = [r.stages[i], r.stages[i + 1]];
          draw();
        };
        row.appendChild(ctr);
        $('#rStages').appendChild(row);
      });
    };
    draw();
    syncMode();
    $('#rAdd').onclick = () => { collect(); r.stages.push($('#rMode').value === 'on_reply' ? { delay: 30, delayUnit: 's', targetType: '', targetId: '' } : { delay: 86400, delayUnit: 'd', targetType: '', targetId: '' }); draw(); };
    $('#cancel').onclick = closeModal;
    $('#saveR').onclick = async () => {
      collect();
      r.name = $('#rName').value.trim();
      if (!r.name) return toast('Dê um nome à regra');
      r.mode = $('#rMode').value;
      r.triggers = $$('.trg').filter((c) => c.checked).map((c) => c.value);
      if (!r.stages.length) return toast('Adicione pelo menos uma etapa');
      const bad = r.stages.findIndex((x) => !x.targetId);
      if (bad >= 0) return toast('Escolha o que enviar na etapa ' + (bad + 1));
      const minDelay = r.mode === 'on_reply' ? 5 : 60;
      const zero = r.stages.findIndex((x) => x.delay < minDelay);
      if (zero >= 0) return toast('Etapa ' + (zero + 1) + ': use pelo menos ' + (r.mode === 'on_reply' ? '5 segundos' : '1 minuto') + ' de espera');
      r.replyWindowHours = Math.max(0, Number($('#rRw').value) || 0);
      r.stopOnManual = $('#rManual').checked;
      r.stopOnOtherFunnel = $('#rOther').checked;
      r.restartOnReply = $('#rRestart').checked;
      const valid = (t) => /^\d{1,2}:\d{2}$/.test(t);
      const ws = $('#rWs').value.trim(), we = $('#rWe').value.trim();
      r.window = { enabled: $('#rWin').checked, start: ws, end: we, days: $$('.wd').filter((c) => c.checked).map((c) => Number(c.value)) };
      if (r.window.enabled && (!valid(ws) || !valid(we))) return toast('Horário no formato 08:00');
      if (r.window.enabled && !r.window.days.length) return toast('Marque pelo menos um dia');
      r.maxLateHours = Math.max(0, Number($('#rLate').value) || 0);
      r.enabled = $('#rEn').checked;
      const idx = DB.remarketing.findIndex((x) => x.id === r.id);
      if (idx >= 0) DB.remarketing[idx] = r;
      else DB.remarketing.push(r);
      await persist('remarketing');
      // etapas mudaram: recalcula horário de quem já está na fila
      await updateQueue((qq) => qq.map((e) => {
        if (e.ruleId !== r.id || e.status !== 'waiting') return e;
        if (e.stageIdx >= r.stages.length) return Object.assign({}, e, { status: 'done', reason: 'regra encurtada', endedAt: Date.now(), dueAt: null });
        const st = r.stages[e.stageIdx];
        const n = Object.assign({}, e, { mode: r.mode });
        if (r.mode === 'on_reply' && e.mode !== 'on_reply') { n.gotReply = false; n.expireAt = r.replyWindowHours > 0 ? Date.now() + r.replyWindowHours * 3600000 : null; }
        n.dueAt = (r.mode === 'inactive' && !e.lastFromMe) || (r.mode === 'on_reply' && !n.gotReply) ? null : e.baseAt + st.delay * 1000;
        return n;
      }));
      closeModal();
      toast('Remarketing salvo!');
      renderRemarketing();
    };
  }

  // ------------------------------------------------------------ GATILHOS
  const MATCH = { contains: 'contém', word: 'contém a palavra', exact: 'é exatamente', starts: 'começa com', any: 'qualquer mensagem' };
  function renderTriggers() {
    let h = `<h1>Gatilhos</h1><p class="sub">Respostas automáticas: quando o lead mandar uma palavra-chave, o funil dispara sozinho. Precisa do WhatsApp Web aberto.</p>
      <div class="bar"><span class="grow"></span><button class="btn sec" id="resetLog">Zerar memória de quem já recebeu</button><button class="btn" id="newT">+ Novo gatilho</button></div>`;
    if (!DB.triggers.length) h += `<div class="empty">Nenhum gatilho ainda.</div>`;
    else {
      h += '<table><tr><th>Ativo</th><th>Nome</th><th>Quando a mensagem…</th><th>Envia</th><th>Regras</th><th></th></tr>';
      DB.triggers.forEach((t) => {
        const rules = [t.once ? '1x por contato' : t.cooldownHours ? 'a cada ' + t.cooldownHours + 'h' : 'sempre', t.ignoreGroups !== false ? 'sem grupos' : 'inclui grupos', t.delay ? 'espera ' + t.delay + 's' : ''].filter(Boolean).join(' · ');
        h += `<tr><td><input type="checkbox" data-tog="${t.id}" ${t.enabled ? 'checked' : ''}></td><td><b>${esc(t.name || '-')}</b></td>
          <td>${MATCH[t.match] || t.match} ${t.match !== 'any' ? '<b>' + esc((t.keywords || []).join(', ')) + '</b>' : ''}</td>
          <td>${esc(targetName(t.targetType, t.targetId))}</td><td>${rules}</td>
          <td><button class="btn sm sec" data-edit="${t.id}">Editar</button> <button class="btn sm red" data-del="${t.id}">✕</button></td></tr>`;
      });
      h += '</table>';
    }
    $('#main').innerHTML = h;
    $('#newT').onclick = () => editTrigger(null);
    $('#resetLog').onclick = async () => {
      if (!confirm('Zerar a memória? Contatos que já receberam gatilhos "1x por contato" poderão receber de novo.')) return;
      await ZF.save({ triggerLog: {} });
      toast('Memória zerada');
    };
    $$('[data-tog]').forEach((c) => (c.onchange = async () => {
      DB.triggers.find((t) => t.id === c.dataset.tog).enabled = c.checked;
      await persist('triggers');
    }));
    $$('[data-edit]').forEach((b) => (b.onclick = () => editTrigger(DB.triggers.find((t) => t.id === b.dataset.edit))));
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const t = DB.triggers.find((x) => x.id === b.dataset.del);
      await removeWithUndo('triggers', t.id, t.name || 'gatilho');
    }));
  }
  function editTrigger(t) {
    if (!DB.items.length && !DB.funnels.length) return toast('Crie um item ou funil primeiro');
    const isNew = !t;
    t = t ? Object.assign({}, t) : { id: ZF.uid(), name: '', enabled: true, match: 'contains', keywords: [], once: true, cooldownHours: 0, ignoreGroups: true, delay: 2, targetType: 'funnel', targetId: '' };
    openModal(`<h2>${isNew ? 'Novo gatilho' : 'Editar gatilho'}</h2>
      <label>Nome</label><input type="text" id="tName" value="${esc(t.name)}" placeholder="Ex: Lead pediu preço">
      <div class="row2"><div><label>Quando a mensagem</label><select id="tMatch">${Object.entries(MATCH).map(([k, v]) => `<option value="${k}" ${t.match === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div><label>Palavras-chave (separe por vírgula)</label><input type="text" id="tKw" value="${esc((t.keywords || []).join(', '))}" placeholder="preço, valor, quanto custa"></div></div>
      <div class="hint">Não diferencia maiúsculas nem acentos.</div>
      <label>Enviar</label><select id="tTarget">${targetOptions(t.targetType, t.targetId)}</select>
      <div class="row2"><div><label>Esperar antes de começar (s)</label><input type="number" id="tDelay" min="0" value="${t.delay || 0}"></div>
      <div><label>Repetir para o mesmo contato</label><select id="tFreq">
        <option value="once" ${t.once ? 'selected' : ''}>Só 1 vez por contato</option>
        <option value="cool" ${!t.once && t.cooldownHours ? 'selected' : ''}>Depois de X horas</option>
        <option value="always" ${!t.once && !t.cooldownHours ? 'selected' : ''}>Sempre</option></select></div></div>
      <div id="coolBox"><label>Horas entre disparos</label><input type="number" id="tCool" min="1" value="${t.cooldownHours || 24}"></div>
      <label class="inline"><input type="checkbox" id="tGroups" ${t.ignoreGroups !== false ? 'checked' : ''}> Ignorar grupos</label>
      <label class="inline"><input type="checkbox" id="tEnabled" ${t.enabled ? 'checked' : ''}> Ativo</label>
      <div class="modal-foot"><button class="btn sec" id="cancel">Cancelar</button><button class="btn" id="saveT">Salvar</button></div>`);
    const syncCool = () => ($('#coolBox').style.display = $('#tFreq').value === 'cool' ? '' : 'none');
    syncCool();
    $('#tFreq').onchange = syncCool;
    $('#cancel').onclick = closeModal;
    $('#saveT').onclick = async () => {
      t.name = $('#tName').value.trim();
      t.match = $('#tMatch').value;
      t.keywords = $('#tKw').value.split(',').map((s) => s.trim()).filter(Boolean);
      if (t.match !== 'any' && !t.keywords.length) return toast('Informe ao menos uma palavra-chave');
      Object.assign(t, parseTarget($('#tTarget').value));
      if (!t.targetId) return toast('Escolha o que enviar');
      t.delay = Math.max(0, Number($('#tDelay').value) || 0);
      const fq = $('#tFreq').value;
      t.once = fq === 'once';
      t.cooldownHours = fq === 'cool' ? Math.max(1, Number($('#tCool').value) || 24) : 0;
      t.ignoreGroups = $('#tGroups').checked;
      t.enabled = $('#tEnabled').checked;
      const idx = DB.triggers.findIndex((x) => x.id === t.id);
      if (idx >= 0) DB.triggers[idx] = t;
      else DB.triggers.push(t);
      await persist('triggers');
      closeModal();
      toast('Gatilho salvo!');
      renderTriggers();
    };
  }

  // ------------------------------------------------------------ AGENDAMENTOS
  function statusTag(s) {
    const m = { pending: ['Agendado', ''], running: ['Enviando', 'run'], done: ['Enviado', ''], error: ['Com erro', 'err'], paused: ['Pausado', 'off'], stopped: ['Parado', 'off'], draft: ['Rascunho', 'off'] }[s] || [s, ''];
    return `<span class="tag ${m[1]}">${m[0]}</span>`;
  }
  function renderSchedules() {
    const list = DB.schedules.slice().sort((a, b) => a.at - b.at);
    let h = `<h1>Agendamentos</h1><p class="sub">Programe mensagens e funis para data e hora certas (follow-up, lembrete, pós-venda). O WhatsApp Web precisa estar aberto no horário; se estiver fechado, envia assim que abrir.</p>
      <div class="bar"><span class="grow"></span><button class="btn sec" id="clearDone">Limpar enviados</button><button class="btn" id="newS">+ Novo agendamento</button></div>`;
    if (!list.length) h += `<div class="empty">Nenhum agendamento.</div>`;
    else {
      h += '<table><tr><th>Quando</th><th>Para</th><th>Envia</th><th>Repetir</th><th>Status</th><th></th></tr>';
      list.forEach((s) => {
        const to = s.numbers.slice(0, 3).map(esc).concat((s.groups || []).slice(0, 3).map((g) => '👥 ' + esc(g.name || 'grupo')));
        const more = s.numbers.length + (s.groups || []).length - to.length;
        h += `<tr><td>${fmtDate(s.at)}</td><td>${to.join(', ')}${more > 0 ? ' +' + more : ''}${s.mention && s.mention.on && (s.groups || []).length ? ' <span class="tag">👥 marca todos</span>' : ''}</td>
          <td>${esc(targetName(s.targetType, s.targetId))}</td><td>${{ none: '-', daily: 'Diário', weekly: 'Semanal' }[s.repeat || 'none']}</td>
          <td>${statusTag(s.status)}${s.lastError ? `<div class="hint" style="color:var(--red)">${esc(s.lastError)}</div>` : ''}</td>
          <td>${s.status === 'pending' ? `<button class="btn sm sec" data-pause="${s.id}">Pausar</button>` : s.status === 'paused' ? `<button class="btn sm" data-resume="${s.id}">Retomar</button>` : ''}
          <button class="btn sm sec" data-edit="${s.id}">Editar</button> <button class="btn sm red" data-del="${s.id}">✕</button></td></tr>`;
      });
      h += '</table>';
    }
    $('#main').innerHTML = h;
    $('#newS').onclick = () => editSchedule(null);
    $('#clearDone').onclick = async () => {
      DB.schedules = DB.schedules.filter((s) => s.status !== 'done');
      await persist('schedules');
      renderSchedules();
    };
    $$('[data-edit]').forEach((b) => (b.onclick = () => editSchedule(DB.schedules.find((s) => s.id === b.dataset.edit))));
    const setSch = async (id, status) => {
      DB.schedules = DB.schedules.map((x) => (x.id === id ? Object.assign({}, x, { status }) : x));
      await persist('schedules');
      renderSchedules();
    };
    $$('[data-pause]').forEach((b) => (b.onclick = () => setSch(b.dataset.pause, 'paused')));
    $$('[data-resume]').forEach((b) => (b.onclick = () => setSch(b.dataset.resume, 'pending')));
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const sc = DB.schedules.find((x) => x.id === b.dataset.del);
      await removeWithUndo('schedules', sc.id, 'agendamento de ' + fmtDate(sc.at));
    }));
  }
  function editSchedule(s) {
    if (!DB.items.length && !DB.funnels.length) return toast('Crie um item ou funil primeiro');
    const isNew = !s;
    s = s ? Object.assign({}, s) : { id: ZF.uid(), numbers: [], groups: [], at: Date.now() + 3600000, repeat: 'none', targetType: 'funnel', targetId: '', status: 'pending', useName: '' };
    openModal(`<h2>${isNew ? 'Novo agendamento' : 'Editar agendamento'}</h2>
      <label>Números (um por linha, com DDD)</label><textarea id="sNums" placeholder="11999998888">${esc(s.numbers.join('\n'))}</textarea>
      <div class="hint">Números brasileiros sem 55 recebem o 55 automaticamente. Para grupos, use a aba <b>👥 Grupos</b>.</div>
      <label>Nome para {nome} (opcional – se vazio usa o nome salvo no WhatsApp)</label><input type="text" id="sName" value="${esc(s.useName || '')}">
      <label>Enviar</label><select id="sTarget">${targetOptions(s.targetType, s.targetId)}</select>
      <div class="row2"><div><label>Data e hora</label><input type="datetime-local" id="sAt" value="${toLocalInput(s.at)}"></div>
      <div><label>Repetir</label><select id="sRep"><option value="none">Não repetir</option><option value="daily" ${s.repeat === 'daily' ? 'selected' : ''}>Todo dia</option><option value="weekly" ${s.repeat === 'weekly' ? 'selected' : ''}>Toda semana</option></select></div></div>
      <div class="modal-foot"><button class="btn sec" id="cancel">Cancelar</button><button class="btn" id="saveS">Salvar</button></div>`);
    $('#cancel').onclick = closeModal;
    $('#saveS').onclick = async () => {
      s.numbers = parseNumbers($('#sNums').value).map((c) => c.number);
      if (!s.numbers.length) return toast('Informe ao menos um número válido');
      Object.assign(s, parseTarget($('#sTarget').value));
      if (!s.targetId) return toast('Escolha o que enviar');
      const at = new Date($('#sAt').value).getTime();
      if (!at) return toast('Data inválida');
      s.at = at;
      s.repeat = $('#sRep').value;
      s.useName = $('#sName').value.trim();
      s.status = 'pending';
      s.lastError = '';
      const idx = DB.schedules.findIndex((x) => x.id === s.id);
      if (idx >= 0) DB.schedules[idx] = s;
      else DB.schedules.push(s);
      await persist('schedules');
      closeModal();
      toast('Agendado!');
      renderSchedules();
    };
  }

  // ------------------------------------------------------------ GRUPOS (aba própria)
  // Por dentro: gPosts (a mensagem) + gSchedules (para quem/quando). Na tela isso é um "envio".
  let gTab = (() => { try { const t = localStorage.getItem('zfGTab'); return ['envios', 'grupos', 'auto'].includes(t) ? t : 'envios'; } catch (e) { return 'envios'; } })();
  let gFilter = 'next';
  let gWeek = false;
  const G_TABS = [['envios', '📨 Envios'], ['grupos', '👥 Grupos'], ['auto', '🤖 Automações']];
  const DAYS = [[1, 'Seg'], [2, 'Ter'], [3, 'Qua'], [4, 'Qui'], [5, 'Sex'], [6, 'Sáb'], [0, 'Dom']];
  const gid = () => 'g' + ZF.uid();
  function gUniq(t) {
    const map = new Map();
    t = t || {};
    (t.groups || []).forEach((g) => map.set(g.id, g));
    (t.lists || []).forEach((lid) => { const l = DB.gLists.find((x) => x.id === lid); (l ? l.groups : []).forEach((g) => map.set(g.id, g)); });
    return Array.from(map.values());
  }
  function gTargetsLabel(t) {
    t = t || {};
    if (t.all) return 'Todos os grupos';
    const parts = (t.lists || []).map((lid) => { const l = DB.gLists.find((x) => x.id === lid); return l ? '📋 ' + l.name : null; }).filter(Boolean)
      .concat((t.groups || []).map((g) => '👥 ' + (g.name || 'grupo')));
    if (!parts.length) return '(nenhum grupo)';
    const n = gUniq(t).length;
    return (parts.length > 3 ? parts.slice(0, 3).join(', ') + ' +' + (parts.length - 3) : parts.join(', ')) + (n > 1 ? ' · ' + n + ' grupos' : '');
  }
  const gHas = (t, groupId) => !!t && (t.all || gUniq(t).some((g) => g.id === groupId));
  const postOf = (id) => DB.gPosts.find((p) => p.id === id);
  const postHasMention = (p) => !!(p && (p.parts || []).some((x) => x.mention));
  function postIcons(p) {
    return ((p && p.parts) || []).map((x) => {
      if (x.kind === 'text') return '💬';
      if (x.kind === 'funnel') return '🔁';
      const it = DB.items.find((i) => i.id === x.itemId);
      return it ? ZF.typeIcon(it.type) : '❔';
    }).join(' ');
  }
  function gNext(s, n) {
    if (!s.enabled) return [];
    if (s.mode === 'once') return s.doneAt || !s.at ? [] : [s.at];
    const out = [];
    const now = Date.now();
    for (let k = 0; k < 15 && out.length < n; k++) {
      const d = new Date(now + k * 86400000);
      if (!(s.days || []).includes(d.getDay())) continue;
      (s.times || []).slice().sort().forEach((hm) => {
        const [h, m] = hm.split(':').map(Number);
        const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m || 0).getTime();
        if (at > now) out.push(at);
      });
    }
    return out.sort((a, b) => a - b).slice(0, n);
  }
  const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const fmtShort = (ts) => { const d = new Date(ts); return WD[d.getDay()] + ' ' + d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
  function dayLabel(ts) {
    const d = new Date(ts);
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t0) / 86400000);
    if (diff === 0) return 'hoje';
    if (diff === 1) return 'amanhã';
    return WD[d.getDay()] + ' ' + d.getDate();
  }
  const hhmm = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  function repeatLabel(s) {
    if (s.mode === 'once') return s.doneAt ? 'enviado' : 'uma vez';
    const d = (s.days || []).slice().sort();
    const dl = d.length === 7 ? 'todo dia' : d.join() === '1,2,3,4,5' ? 'seg a sex' : DAYS.filter(([x]) => d.includes(x)).map((x) => x[1].toLowerCase()).join(', ');
    return dl + ' · ' + (s.times || []).slice().sort().join(', ');
  }

  // destino: todos / listas / grupos (um por modal)
  function targetsHtml(allowAll) {
    return `${allowAll ? `<label class="inline" style="margin:6px 0 2px"><input type="checkbox" id="tgAll"> <b>Todos os grupos</b> <span class="hint">(em que você está)</span></label>` : ''}
      <div id="tgPick"><div id="tgListsWrap"><label>📋 Listas de grupos</label><div class="chips" id="tgLists" style="margin:4px 0 2px"></div></div>${GROUP_BOX_HTML}</div>`;
  }
  function bindTargets(t, onChange) {
    t = t || {};
    let lists = (t.lists || []).filter((id) => DB.gLists.some((l) => l.id === id));
    const drawLists = () => {
      $('#tgListsWrap').style.display = DB.gLists.length ? '' : 'none';
      $('#tgLists').innerHTML = DB.gLists.map((l) => `<button type="button" class="chip ${lists.includes(l.id) ? 'on' : ''}" data-tl="${l.id}">📋 ${esc(l.name)} <span>${l.groups.length}</span></button>`).join('');
      $$('#tgLists [data-tl]').forEach((b) => (b.onclick = () => {
        lists = lists.includes(b.dataset.tl) ? lists.filter((x) => x !== b.dataset.tl) : lists.concat(b.dataset.tl);
        drawLists();
        if (onChange) onChange();
      }));
    };
    drawLists();
    const getGroups = groupBox(t.groups || []);
    if (onChange) $('#grpBox').addEventListener('change', onChange);
    if ($('#tgAll')) {
      $('#tgAll').checked = !!t.all;
      const upd = () => { $('#tgPick').style.display = $('#tgAll').checked ? 'none' : ''; if (onChange) onChange(); };
      $('#tgAll').onchange = upd;
      upd();
    }
    return () => ({ all: !!($('#tgAll') && $('#tgAll').checked), lists: lists.slice(), groups: getGroups() });
  }
  const tgEmpty = (t) => !t.all && !gUniq(t).length;

  // montador de mensagens (texto escrito na hora + acervo, com "@ todos" em cada uma)
  function msgBuilder(box, parts, opts) {
    opts = opts || {};
    parts = JSON.parse(JSON.stringify(parts && parts.length ? parts : [{ kind: 'text', text: '', mention: false, delay: 0 }]));
    const read = () => {
      $$('.gpart', box).forEach((row, i) => {
        const part = parts[i];
        if (!part) return;
        part.delay = Math.max(0, Number($('.gp-delay', row).value) || 0);
        if (part.kind === 'text') part.text = $('.gp-text', row).value;
        else {
          const [k, ...rest] = $('select.tg', row).value.split(':');
          part.kind = k === 'funnel' ? 'funnel' : 'item';
          if (part.kind === 'funnel') { part.funnelId = rest.join(':'); delete part.itemId; } else { part.itemId = rest.join(':'); delete part.funnelId; }
        }
      });
    };
    const draw = () => {
      box.innerHTML = '';
      const list = document.createElement('div');
      parts.forEach((part, i) => {
        const row = document.createElement('div');
        row.className = 'gpart step';
        row.innerHTML = `<div class="gp-head"><span class="num">${i + 1}</span>${part.kind === 'text' ? '<b>💬 Texto</b>' : '<b>📦 Do acervo</b>'}<span class="grow"></span>
          ${opts.noMention ? '' : `<button type="button" class="atbtn ${part.mention ? 'on' : ''}" data-at="${i}" title="Marcar todos do grupo nesta mensagem (oculto: notifica todo mundo sem aparecer @)">@ todos</button>`}
          ${i ? `<span class="hint">esperar</span><input type="number" class="gp-delay" min="0" value="${part.delay || 0}" title="Segundos antes desta mensagem (o digitando/gravando acontece dentro)"><span class="hint">s</span>` : '<input type="hidden" class="gp-delay" value="0">'}
          <button type="button" class="btn sm sec" data-up="${i}" title="Subir">↑</button><button type="button" class="btn sm sec" data-dn="${i}" title="Descer">↓</button><button type="button" class="btn sm red" data-rm="${i}" title="Tirar">✕</button></div>
          ${part.kind === 'text' ? `<textarea class="gp-text" rows="3" placeholder="${esc(opts.placeholder || '{Saudacao}, pessoal! Hoje tem aula às 20h 🚀')}">${esc(part.text || '')}</textarea>` : `<select class="tg"><option value="">— escolha —</option>${targetOptions(part.kind, part.kind === 'funnel' ? part.funnelId : part.itemId)}</select>`}`;
        list.appendChild(row);
        if (part.kind !== 'text' && !(part.itemId || part.funnelId)) row.querySelector('select.tg').value = '';
      });
      box.appendChild(list);
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.margin = '8px 0 0';
      bar.innerHTML = `<button type="button" class="btn sm sec" data-add="text">+ Texto</button><button type="button" class="btn sm sec" data-add="item">+ Do acervo (áudio, imagem, vídeo, funil…)</button>${opts.saved && DB.gPosts.length ? '<span class="grow"></span><select class="gp-saved" style="max-width:260px"><option value="">↺ Usar envio salvo…</option>' + DB.gPosts.slice().reverse().map((p) => `<option value="${p.id}">${esc(p.name)} (${p.parts.length})</option>`).join('') + '</select>' : ''}`;
      box.appendChild(bar);
      $$('[data-at]', box).forEach((b) => (b.onclick = () => { read(); const x = parts[+b.dataset.at]; x.mention = !x.mention; draw(); }));
      $$('[data-up]', box).forEach((b) => (b.onclick = () => { read(); const i = +b.dataset.up; if (i > 0) { [parts[i - 1], parts[i]] = [parts[i], parts[i - 1]]; draw(); } }));
      $$('[data-dn]', box).forEach((b) => (b.onclick = () => { read(); const i = +b.dataset.dn; if (i < parts.length - 1) { [parts[i + 1], parts[i]] = [parts[i], parts[i + 1]]; draw(); } }));
      $$('[data-rm]', box).forEach((b) => (b.onclick = () => { read(); parts.splice(+b.dataset.rm, 1); if (!parts.length) parts.push({ kind: 'text', text: '', mention: false, delay: 0 }); draw(); }));
      $$('[data-add]', box).forEach((b) => (b.onclick = () => {
        read();
        parts.push(b.dataset.add === 'text' ? { kind: 'text', text: '', mention: false, delay: parts.length ? 3 : 0 } : { kind: 'item', itemId: '', mention: false, delay: parts.length ? 3 : 0 });
        draw();
        setTimeout(() => { if (b.dataset.add === 'text') { const t = $$('.gp-text', box).pop(); if (t) t.focus(); } else { const k = $$('.gpart .pk-btn', box).pop(); if (k) k.click(); } }, 30);
      }));
      const sv = $('.gp-saved', box);
      if (sv) sv.onchange = () => {
        const p = postOf(sv.value);
        if (!p) return;
        read();
        const empty = parts.length === 1 && parts[0].kind === 'text' && !String(parts[0].text || '').trim();
        parts = (empty ? [] : parts).concat(JSON.parse(JSON.stringify(p.parts)));
        if (opts.onSaved) opts.onSaved(p);
        draw();
      };
    };
    draw();
    return {
      get: () => { read(); return parts.filter((x) => (x.kind === 'text' ? String(x.text || '').trim() : x.itemId || x.funnelId)).map((x, i) => (i === 0 ? Object.assign({}, x, { delay: 0 }) : x)); },
      firstText: () => { read(); const t = parts.find((x) => x.kind === 'text' && String(x.text || '').trim()); return t ? t.text : ''; }
    };
  }
  // grava a mensagem: reaproveita o mesmo registro se só este envio/automação usa; senão cria outro
  function savePost(oldId, name, parts, ownerKey) {
    const used = (id) => DB.gSchedules.filter((s) => s.postId === id).length + (((DB.gAuto || {}).welcome || {}).postId === id ? 1 : 0) + (((DB.gAuto || {}).keywords) || []).filter((k) => k.postId === id).length;
    const p = oldId && postOf(oldId);
    if (p && used(oldId) <= (ownerKey ? 1 : 0)) {
      p.name = name;
      p.parts = parts;
      return p.id;
    }
    const np = { id: gid(), name, parts };
    DB.gPosts.push(np);
    return np.id;
  }
  const autoName = (parts, fallback) => {
    const t = parts.find((x) => x.kind === 'text');
    if (t) return t.text.replace(/\{[^}]+\}/g, '').replace(/\s+/g, ' ').replace(/^[\s,.!?;:–-]+/, '').trim().slice(0, 40) || fallback;
    const x = parts[0];
    return x ? targetName(x.kind === 'funnel' ? 'funnel' : 'item', x.kind === 'funnel' ? x.funnelId : x.itemId).replace(/^\S+\s/, '') : fallback;
  };

  function renderGroups() {
    $('#main').innerHTML = `<h1>Grupos</h1><p class="sub">Mande e programe mensagens nos seus grupos, com "@ todos" (oculto) onde quiser. Tudo começa no botão <b>Novo envio</b>.</p>
      <div class="bar" style="margin:0 0 16px"><div class="seg gtabs" style="margin:0">${G_TABS.map(([k, t]) => `<button type="button" data-gt="${k}" class="${gTab === k ? 'on' : ''}">${t}</button>`).join('')}</div><span class="grow"></span><button class="btn" id="gNew">+ Novo envio</button></div><div id="gBody"></div>`;
    $$('[data-gt]').forEach((b) => (b.onclick = () => {
      gTab = b.dataset.gt;
      try { localStorage.setItem('zfGTab', gTab); } catch (e) {}
      renderGroups();
    }));
    $('#gNew').onclick = () => gWizard(null);
    ({ envios: gRenderEnvios, grupos: gRenderGrupos, auto: gRenderAuto }[gTab] || gRenderEnvios)($('#gBody'));
  }

  // ----- Envios
  function gRow(s, when, sub2) {
    const p = postOf(s.postId);
    const last = s.last && !s.last.ok ? `<div class="hint" style="color:var(--red);margin-top:3px" title="${esc(s.last.err || '')}">⚠️ ${esc((s.last.err || 'erro').slice(0, 90))}</div>` : '';
    return `<div class="erow ${s.enabled ? '' : 'off'}"><div class="ewhen">${when}</div>
      <div class="lmain"><div class="lname">${esc(p ? p.name : '(mensagem apagada)')} ${postHasMention(p) ? '<span class="atag">@ todos</span>' : ''} ${s.enabled ? '' : '<span class="tag off">Pausado</span>'}</div>
      <div class="lsub">${postIcons(p)} · ${esc(gTargetsLabel(s.targets))} · ${s.mode === 'once' ? '📌 ' : '🔁 '}${esc(repeatLabel(s))}${sub2 || ''}</div>${last}</div>
      <div class="lact"><button class="btn sm sec" data-ge="${s.id}">Editar</button><button class="btn sm sec" data-gtog="${s.id}">${s.enabled ? 'Pausar' : 'Retomar'}</button><button class="btn sm sec" data-gdup="${s.id}" title="Duplicar">⧉</button><button class="btn sm red" data-gdel="${s.id}" title="Excluir">✕</button></div></div>`;
  }
  function gRenderEnvios(box) {
    const sch = DB.gSchedules;
    const hist = (DB.history || []).filter((x) => /@g\.us$/.test(x.chatId || ''));
    const nRep = sch.filter((s) => s.mode !== 'once').length;
    let h = `<div class="bar" style="margin:0 0 12px"><div class="chips" style="margin:0">${[['next', 'Próximos'], ['rep', 'Repetindo (' + nRep + ')'], ['sent', 'Enviados']].map(([k, t]) => `<button type="button" class="chip ${gFilter === k ? 'on' : ''}" data-gf="${k}">${t}</button>`).join('')}</div><span class="grow"></span>${gFilter !== 'sent' && nRep ? `<button type="button" class="btn sm sec" id="gWeekBtn">${gWeek ? '☰ Ver como lista' : '📅 Ver como semana'}</button>` : ''}</div>`;
    if (!sch.length && !hist.length) {
      h += `<div class="empty"><div style="font-size:30px;margin-bottom:6px">📨</div><b>Nenhum envio ainda</b><br>Clique em <b>+ Novo envio</b>: monte a mensagem, escolha os grupos e diga quando (agora, numa data, ou repetindo na semana).</div>`;
      box.innerHTML = h;
      bindEnvios(box);
      return;
    }
    if (gFilter === 'sent') {
      h += hist.length ? '<div class="elist">' + hist.slice(0, 200).map((x) => `<div class="erow"><div class="ewhen"><b>${hhmm(x.t)}</b><small>${dayLabel(x.t) === 'hoje' ? 'hoje' : new Date(x.t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</small></div>
        <div class="lmain"><div class="lname">${esc((x.what || '').replace(/^👥\s*/, ''))}</div><div class="lsub">👥 ${esc(x.name || x.chatId.replace(/@.*/, ''))} · ${esc(String(x.source || '').replace(/^grupo:\s*/, ''))}</div></div>
        <div class="lact">${x.ok ? '<span class="tag">✅ enviado</span>' : `<span class="tag err" title="${esc(x.err || '')}">❌ ${esc((x.err || 'erro').slice(0, 40))}</span>`}</div></div>`).join('') + '</div>' : '<div class="empty">Nada enviado em grupos ainda.</div>';
    } else if (gWeek) {
      const weekly = sch.filter((s) => s.mode !== 'once');
      h += '<div class="week">';
      DAYS.forEach(([d, label]) => {
        const today = new Date().getDay() === d;
        const slots = [];
        weekly.forEach((s) => { if ((s.days || []).includes(d)) (s.times || []).forEach((t) => slots.push({ s, t })); });
        slots.sort((a, b) => a.t.localeCompare(b.t));
        h += `<div class="wday ${today ? 'today' : ''}"><div class="wd-h">${label}${today ? ' · hoje' : ''}</div>` + (slots.length ? slots.map(({ s, t }) => {
          const p = postOf(s.postId);
          return `<button type="button" class="wslot ${s.enabled ? '' : 'off'} ${postHasMention(p) ? 'men' : ''}" data-ge="${s.id}"><b>${t}</b>${postHasMention(p) ? '<span class="at">@</span>' : ''}<span class="wn">${esc(p ? p.name : '(apagada)')}</span><small>${esc(gTargetsLabel(s.targets))}</small></button>`;
        }).join('') : '<div class="wempty">—</div>') + '</div>';
      });
      h += '</div>';
    } else if (gFilter === 'rep') {
      const rep = sch.filter((s) => s.mode !== 'once');
      h += rep.length ? '<div class="elist">' + rep.map((s) => { const nx = gNext(s, 1)[0]; return gRow(s, nx ? `<b>${hhmm(nx)}</b><small>${dayLabel(nx)}</small>` : '<b>—</b><small>pausado</small>'); }).join('') + '</div>' : '<div class="empty">Nenhum envio repetindo. No <b>Novo envio</b>, escolha "Repetir".</div>';
    } else {
      // próximos: cada envio uma vez, no próximo horário dele (pausados no fim)
      const occ = [];
      sch.forEach((s) => { const t = gNext(s, 1)[0]; if (t) occ.push({ s, t }); });
      occ.sort((a, b) => a.t - b.t);
      const paused = sch.filter((s) => !s.enabled);
      let lastDay = '';
      h += occ.length ? '<div class="elist">' + occ.slice(0, 80).map(({ s, t }) => {
        const dl = dayLabel(t);
        const head = dl !== lastDay ? `<div class="eday">${dl === 'hoje' ? 'Hoje' : dl === 'amanhã' ? 'Amanhã' : fmtShort(t).slice(0, 9)}</div>` : '';
        lastDay = dl;
        return head + gRow(s, `<b>${hhmm(t)}</b><small>${dl}</small>`);
      }).join('') + '</div>' : '<div class="empty">Nada programado. Clique em <b>+ Novo envio</b>.</div>';
      if (paused.length) h += '<div class="eday" style="margin-top:16px">Pausados</div><div class="elist">' + paused.map((s) => gRow(s, '<b>⏸</b><small>pausado</small>')).join('') + '</div>';
    }
    box.innerHTML = h;
    bindEnvios(box);
  }
  function bindEnvios(box) {
    $$('[data-gf]', box).forEach((b) => (b.onclick = () => { gFilter = b.dataset.gf; renderGroups(); }));
    if ($('#gWeekBtn')) $('#gWeekBtn').onclick = () => { gWeek = !gWeek; renderGroups(); };
    bindSchedActions(box);
  }
  function bindSchedActions(box) {
    $$('[data-ge]', box).forEach((b) => (b.onclick = () => gWizard(DB.gSchedules.find((s) => s.id === b.dataset.ge))));
    $$('[data-gtog]', box).forEach((b) => (b.onclick = async () => {
      DB.gSchedules = DB.gSchedules.map((s) => (s.id === b.dataset.gtog ? Object.assign({}, s, { enabled: !s.enabled }) : s));
      render();
      await persist('gSchedules');
    }));
    $$('[data-gdup]', box).forEach((b) => (b.onclick = () => {
      const s = DB.gSchedules.find((x) => x.id === b.dataset.gdup);
      const p = postOf(s.postId);
      gWizard(null, { parts: p ? p.parts : [], name: p ? p.name + ' (cópia)' : '', targets: s.targets, mode: s.mode, days: s.days, times: s.times, at: s.at });
    }));
    $$('[data-gdel]', box).forEach((b) => (b.onclick = () => {
      const s = DB.gSchedules.find((x) => x.id === b.dataset.gdel);
      const p = postOf(s.postId);
      removeWithUndo('gSchedules', s.id, p ? p.name : 'envio');
    }));
  }

  // ----- Assistente "Novo envio": 1 Mensagem · 2 Grupos · 3 Quando
  function gWizard(s, preset) {
    const isNew = !s;
    preset = preset || {};
    const p0 = s ? postOf(s.postId) : null;
    s = s ? JSON.parse(JSON.stringify(s)) : { id: gid(), targets: preset.targets || { lists: [], groups: [] }, mode: preset.mode || 'now', days: preset.days || [1, 2, 3, 4, 5], times: preset.times || ['08:00'], at: preset.at && preset.at > Date.now() ? preset.at : Date.now() + 3600000, enabled: true, lateMin: 120, done: {} };
    let mode = s.mode === 'once' ? (isNew ? 'now' : 'once') : s.mode === 'week' ? 'week' : 'now';
    if (!isNew && s.mode === 'once') mode = 'once';
    let step = 1;
    openModal(`<h2>${isNew ? 'Novo envio' : 'Editar envio'}</h2>
      <div class="wsteps"><button type="button" data-ws="1">1 · Mensagem</button><button type="button" data-ws="2">2 · Grupos</button><button type="button" data-ws="3">3 · Quando</button></div>
      <div data-wp="1"><div id="wMsg"></div><label style="margin-top:12px">Nome (para você achar depois)</label><input type="text" id="wName" value="${esc(p0 ? p0.name : preset.name || '')}" placeholder="automático: o começo do texto">
        <div class="hint" style="margin-top:6px">Variáveis: {nome}/{grupo} = nome do grupo · {saudacao}, {data}, {hora} e suas variações ({oi}…).</div></div>
      <div data-wp="2">${targetsHtml(false)}<div class="hint" id="wTgInfo"></div></div>
      <div data-wp="3"><div class="wmodes">${[['now', '📤', 'Agora'], ['once', '📌', 'Data e hora'], ['week', '🔁', 'Repetir']].map(([k, i, t]) => `<button type="button" data-wm="${k}"><span>${i}</span>${t}</button>`).join('')}</div>
        <div id="wOnce"><label>Data e hora</label><input type="datetime-local" id="wAt" value="${toLocalInput(s.at)}"></div>
        <div id="wWeek"><label>Dias</label><div class="chips" id="wDays" style="margin:4px 0 6px">${DAYS.map(([d, l]) => `<button type="button" class="chip" data-day="${d}">${l}</button>`).join('')}
          <span class="hint" style="align-self:center;margin-left:6px">atalhos:</span><button type="button" class="chip" data-dset="all">Todo dia</button><button type="button" class="chip" data-dset="work">Seg–Sex</button></div>
          <label>Horários</label><div id="wTimes" class="chips" style="align-items:center"></div></div>
        <div id="wLateBox"><details style="margin-top:12px"><summary class="hint" style="cursor:pointer">Se o WhatsApp estiver fechado no horário…</summary><label style="margin-top:8px">Enviar com até quantos minutos de atraso</label><input type="number" id="wLate" min="5" max="1440" value="${s.lateMin || 120}" style="max-width:140px"><div class="hint">Depois disso, aquele horário é pulado (para não sair um "bom dia" à tarde).</div></details></div>
        <div class="wsum" id="wSum"></div></div>
      <div class="modal-foot"><button class="btn sec" id="wBack">Cancelar</button><span class="grow"></span><button class="btn" id="wNext">Próximo</button></div>`);
    const mb = msgBuilder($('#wMsg'), p0 ? p0.parts : preset.parts, { saved: true, onSaved: (p) => { if (!$('#wName').value.trim()) $('#wName').value = p.name; } });
    const getT = bindTargets(s.targets, () => { const n = gUniq(getT ? getT() : {}).length; $('#wTgInfo').textContent = n ? n + ' grupo(s) vão receber' : ''; });
    let days = (s.days || []).slice();
    let times = (s.times || []).slice();
    const tmp = () => ({ mode: mode === 'week' ? 'week' : 'once', days, times, enabled: true, at: mode === 'now' ? Date.now() : new Date($('#wAt').value).getTime() });
    const summary = () => {
      const t = getT();
      const g = gUniq(t).length;
      const parts = mb.get();
      const men = parts.filter((x) => x.mention).length;
      let when = '';
      if (mode === 'now') when = '<b>agora</b>';
      else {
        const nx = gNext(tmp(), 3);
        when = nx.length ? (mode === 'week' ? '<b>' + esc(repeatLabel(tmp())) + '</b> · próximos: ' + nx.map(fmtShort).join(', ') : '<b>' + fmtShort(nx[0]) + '</b>') : '<span style="color:var(--red)">nenhum horário futuro</span>';
      }
      $('#wSum').innerHTML = `<b>${parts.length}</b> mensagem(ns)${men ? ' · <span class="atag">@ todos</span> em ' + men : ''} → <b>${g}</b> grupo(s) · ${when}`;
    };
    const drawMode = () => {
      $$('[data-wm]').forEach((b) => b.classList.toggle('on', b.dataset.wm === mode));
      $('#wOnce').style.display = mode === 'once' ? '' : 'none';
      $('#wWeek').style.display = mode === 'week' ? '' : 'none';
      $('#wLateBox').style.display = mode === 'week' ? '' : 'none';
      summary();
      drawFoot();
    };
    const drawDays = () => { $$('[data-day]').forEach((b) => b.classList.toggle('on', days.includes(+b.dataset.day))); summary(); };
    const drawTimes = () => {
      $('#wTimes').innerHTML = times.map((t, i) => `<span class="tpill"><input type="time" value="${t}" data-ti="${i}"><button type="button" data-tx="${i}" title="Tirar">✕</button></span>`).join('') + '<button type="button" class="chip" id="wAddT">+ horário</button>';
      $$('[data-ti]').forEach((inp) => (inp.onchange = () => { times[+inp.dataset.ti] = inp.value; summary(); }));
      $$('[data-tx]').forEach((b) => (b.onclick = () => { times.splice(+b.dataset.tx, 1); drawTimes(); }));
      $('#wAddT').onclick = () => { times.push(times.length ? times[times.length - 1] : '12:00'); drawTimes(); };
      summary();
    };
    $$('[data-wm]').forEach((b) => (b.onclick = () => { mode = b.dataset.wm; drawMode(); }));
    $$('[data-day]').forEach((b) => (b.onclick = () => { const d = +b.dataset.day; days = days.includes(d) ? days.filter((x) => x !== d) : days.concat(d); drawDays(); }));
    $$('[data-dset]').forEach((b) => (b.onclick = () => { days = b.dataset.dset === 'all' ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]; drawDays(); }));
    $('#wAt').onchange = summary;
    drawTimes();
    drawDays();
    const check = (n) => {
      if (n >= 1 && !mb.get().length) { toast('Escreva ou escolha pelo menos uma mensagem'); return 1; }
      if (n >= 2 && tgEmpty(getT())) { toast('Escolha pelo menos um grupo ou lista'); return 2; }
      return 0;
    };
    const go = (n) => {
      if (n > step) { const bad = check(n - 1); if (bad) n = bad; }
      step = n;
      $$('[data-wp]').forEach((x) => (x.style.display = +x.dataset.wp === step ? '' : 'none'));
      $$('[data-ws]').forEach((x) => { x.classList.toggle('on', +x.dataset.ws === step); x.classList.toggle('done', +x.dataset.ws < step); });
      if (step === 3) summary();
      drawFoot();
    };
    function drawFoot() {
      $('#wBack').textContent = step === 1 ? 'Cancelar' : '← Voltar';
      $('#wNext').textContent = step < 3 ? 'Próximo →' : mode === 'now' ? '📤 Enviar agora' : isNew ? 'Programar' : 'Salvar';
    }
    $$('[data-ws]').forEach((b) => (b.onclick = () => go(+b.dataset.ws)));
    $('#wBack').onclick = () => (step === 1 ? closeModal() : go(step - 1));
    $('#wNext').onclick = async () => {
      if (step < 3) return go(step + 1);
      const bad = check(2);
      if (bad) return go(bad);
      const parts = mb.get();
      const t = getT();
      const name = $('#wName').value.trim() || autoName(parts, 'Envio ' + new Date().toLocaleDateString('pt-BR'));
      if (mode === 'week') {
        times = Array.from(new Set(times.filter((x) => /^\d\d:\d\d$/.test(x)))).sort();
        if (!days.length) return toast('Escolha pelo menos um dia');
        if (!times.length) return toast('Coloque pelo menos um horário');
      }
      let at = Date.now();
      if (mode === 'once') {
        at = new Date($('#wAt').value).getTime();
        if (!at) return toast('Data inválida');
        if (at < Date.now() - 60000 && !confirm('Essa data já passou. Enviar assim que possível?')) return;
      }
      s.postId = savePost(s.postId, name, parts, !isNew);
      s.targets = t;
      if (mode === 'week') Object.assign(s, { mode: 'week', days: days.slice().sort(), times, lateMin: Math.max(5, Math.min(1440, +$('#wLate').value || 120)) });
      else {
        if (s.mode !== 'once' || s.at !== at) s.doneAt = 0;
        Object.assign(s, { mode: 'once', at });
      }
      if (isNew || !s.createdAt) s.createdAt = Date.now();
      s.enabled = true;
      const i = DB.gSchedules.findIndex((x) => x.id === s.id);
      if (i >= 0) DB.gSchedules[i] = s;
      else DB.gSchedules.push(s);
      closeModal();
      await persist('gPosts');
      await persist('gSchedules');
      if (mode === 'now') {
        const r = await bgMsg({ type: 'wa:gtick' });
        toast(r && r.ok ? 'Enviando para ' + gUniq(t).length + ' grupo(s) 📤' : 'Salvo — envia assim que o WhatsApp Web abrir');
        gFilter = 'sent';
      } else toast(isNew ? 'Programado ✅' : 'Envio salvo');
      gTab = 'envios';
      render();
    };
    go(1);
    drawMode();
  }

  // ----- Grupos e listas
  function gRenderGrupos(box) {
    let h = `<div class="section"><div class="bar" style="margin:0 0 10px"><h3 style="margin:0">📋 Listas</h3><span class="hint">vários grupos com um nome só — ex: "Turmas APEX"</span><span class="grow"></span><button class="btn sm sec" id="glNew">+ Nova lista</button></div>`;
    h += DB.gLists.length ? '<div class="glists">' + DB.gLists.map((l) => `<div class="glist"><div class="lname">📋 ${esc(l.name)}</div><div class="lsub">${l.groups.length} grupo(s): ${esc(l.groups.slice(0, 4).map((g) => g.name).join(', '))}${l.groups.length > 4 ? '…' : ''}</div>
      <div class="bar" style="margin:8px 0 0"><button class="btn sm" data-glsend="${l.id}">Novo envio</button><button class="btn sm sec" data-gle="${l.id}">Editar</button><button class="btn sm red" data-gld="${l.id}" title="Excluir">✕</button></div></div>`).join('') + '</div>' : '<div class="hint">Nenhuma lista ainda.</div>';
    h += `</div><div class="section"><div class="bar" style="margin:0 0 10px"><h3 style="margin:0">👥 Seus grupos</h3><span class="hint" id="gwInfo"></span><span class="grow"></span><button class="btn sm sec" id="gwRef">🔄 Atualizar</button></div>
      <input type="search" id="gwq" placeholder="Buscar grupo…" style="max-width:320px"><div id="gwList" class="elist" style="margin-top:10px"><div class="hint">Carregando…</div></div></div>`;
    box.innerHTML = h;
    $('#glNew').onclick = () => gEditList(null);
    $$('[data-gle]').forEach((b) => (b.onclick = () => gEditList(DB.gLists.find((l) => l.id === b.dataset.gle))));
    $$('[data-glsend]').forEach((b) => (b.onclick = () => gWizard(null, { targets: { lists: [b.dataset.glsend], groups: [] } })));
    $$('[data-gld]').forEach((b) => (b.onclick = () => { const l = DB.gLists.find((x) => x.id === b.dataset.gld); removeWithUndo('gLists', l.id, l.name); }));
    let all = [];
    const draw = () => {
      const q = ZF.normalizeText($('#gwq').value);
      const rows = all.filter((g) => !q || ZF.normalizeText(g.name).includes(q));
      $('#gwList').innerHTML = rows.length ? rows.slice(0, 400).map((g) => {
        const inLists = DB.gLists.filter((l) => l.groups.some((x) => x.id === g.id));
        const nEnv = DB.gSchedules.filter((s) => s.enabled && gHas(s.targets, g.id) && gNext(s, 1).length).length;
        return `<button type="button" class="erow gpick" data-gopen="${esc(g.id)}"><span class="licon">👥</span><div class="lmain"><div class="lname">${esc(g.name || g.id)} ${inLists.map((l) => `<span class="ftag">📋 ${esc(l.name)}</span>`).join('')}</div>
          <div class="lsub">${g.size ? g.size + ' membros' : ''}${g.onlyAdmins ? ' · <span style="color:var(--red)">só admins enviam</span>' : ''}${nEnv ? ' · 📨 ' + nEnv + ' envio(s) programado(s)' : ''}</div></div><span class="pk-caret">›</span></button>`;
      }).join('') : `<div class="hint">${all.length ? 'Nenhum grupo com esse nome.' : 'Nenhum grupo carregado.'}</div>`;
      $$('[data-gopen]').forEach((b) => (b.onclick = () => gGroupDetail(all.find((x) => x.id === b.dataset.gopen))));
    };
    const load = async (force) => {
      try {
        const r = await loadGroups(force);
        all = r.list;
        $('#gwInfo').textContent = all.length + ' grupos · atualizado ' + fmtDate(r.at) + (r.error ? ' (' + r.error + ')' : '');
      } catch (e) {
        $('#gwInfo').textContent = e.message;
      }
      draw();
    };
    $('#gwq').oninput = draw;
    $('#gwRef').onclick = () => load(true);
    load(false);
  }
  function gGroupDetail(g) {
    if (!g) return;
    const env = DB.gSchedules.filter((s) => gHas(s.targets, g.id));
    const a = DB.gAuto || {};
    const autos = [];
    if (a.welcome && a.welcome.enabled && gHas(a.welcome.targets, g.id)) autos.push('👋 Boas-vindas');
    ((a.keywords || []).filter((k) => k.enabled && gHas(k.targets, g.id))).forEach((k) => autos.push('🔑 ' + k.words));
    const hist = (DB.history || []).filter((x) => x.chatId === g.id).slice(0, 8);
    const lists = DB.gLists.filter((l) => l.groups.some((x) => x.id === g.id));
    openModal(`<h2>👥 ${esc(g.name)}</h2><p class="hint" style="margin-top:-8px">${g.size ? g.size + ' membros' : ''}${lists.length ? ' · listas: ' + lists.map((l) => esc(l.name)).join(', ') : ''}</p>
      <div class="bar" style="margin:8px 0 14px"><button class="btn" id="gdNew">+ Novo envio neste grupo</button></div>
      <h3 style="margin:0 0 8px">📨 Envios para este grupo</h3>${env.length ? '<div class="elist" id="gdEnv">' + env.map((s) => { const nx = gNext(s, 1)[0]; return gRow(s, nx ? `<b>${hhmm(nx)}</b><small>${dayLabel(nx)}</small>` : '<b>—</b><small>' + (s.enabled ? 'sem próximo' : 'pausado') + '</small>'); }).join('') + '</div>' : '<div class="hint">Nenhum.</div>'}
      <h3 style="margin:16px 0 8px">🤖 Automações ativas</h3><div class="hint">${autos.length ? autos.map(esc).join(' · ') : 'Nenhuma.'}</div>
      <h3 style="margin:16px 0 8px">📜 Últimos envios</h3>${hist.length ? hist.map((x) => `<div class="lsub">${fmtDate(x.t)} · ${esc((x.what || '').replace(/^👥\s*/, ''))} · ${x.ok ? '✅' : '❌ ' + esc(x.err || '')}</div>`).join('') : '<div class="hint">Nada ainda.</div>'}
      <div class="modal-foot"><button class="btn sec" id="cancel">Fechar</button></div>`);
    $('#cancel').onclick = closeModal;
    $('#gdNew').onclick = () => gWizard(null, { targets: { lists: [], groups: [{ id: g.id, name: g.name }] } });
    if ($('#gdEnv')) bindSchedActions($('#gdEnv'));
  }
  function gEditList(l) {
    const isNew = !l;
    l = l ? JSON.parse(JSON.stringify(l)) : { id: gid(), name: '', groups: [] };
    openModal(`<h2>${isNew ? 'Nova lista de grupos' : 'Editar lista'}</h2>
      <label>Nome da lista</label><input type="text" id="glName" value="${esc(l.name)}" placeholder="Turmas APEX">${GROUP_BOX_HTML}
      <div class="modal-foot"><button class="btn sec" id="cancel">Cancelar</button><button class="btn" id="glSave">Salvar lista</button></div>`);
    $('#cancel').onclick = closeModal;
    const getG = groupBox(l.groups);
    $('#glSave').onclick = async () => {
      l.name = $('#glName').value.trim();
      l.groups = getG();
      if (!l.name) return toast('Dê um nome à lista');
      if (!l.groups.length) return toast('Escolha pelo menos um grupo');
      const i = DB.gLists.findIndex((x) => x.id === l.id);
      if (i >= 0) DB.gLists[i] = l;
      else DB.gLists.push(l);
      closeModal();
      render();
      await persist('gLists');
      toast('Lista salva');
    };
  }

  // ----- Automações (liga/desliga direto no cartão)
  function gRenderAuto(box) {
    const a = DB.gAuto || {};
    const w = a.welcome || {};
    const kws = a.keywords || [];
    const pn = (id) => { const p = postOf(id); return p ? p.name : '—'; };
    const sw = (id, on, attr) => `<label class="switch" title="${on ? 'Ligada' : 'Desligada'}"><input type="checkbox" ${attr || ''} id="${id}" ${on ? 'checked' : ''}><span></span></label>`;
    let h = `<p class="hint" style="margin-top:-6px">Funcionam sozinhas com o WhatsApp Web aberto (ou o servidor 24h) e respeitam o "Pausar automações".</p>
      <div class="acard ${w.enabled ? 'on' : ''}"><div class="acard-h">${sw('gwSw', !!w.enabled)}<div class="lmain"><div class="lname">👋 Boas-vindas</div>
        <div class="lsub">${w.postId ? `Quem entra recebe <b>${esc(pn(w.postId))}</b> · ${esc(gTargetsLabel(w.targets))}${w.mentionNew !== false ? ' · marca quem entrou' : ''}` : 'Mande uma mensagem automática para quem entrar no grupo.'}</div></div><button class="btn sm sec" id="gwEdit">${w.postId ? 'Editar' : 'Configurar'}</button></div></div>
      <div class="acard ${kws.some((k) => k.enabled) ? 'on' : ''}"><div class="acard-h"><span style="font-size:20px">🔑</span><div class="lmain"><div class="lname">Resposta por palavra-chave</div><div class="lsub">Ex.: alguém escreve "link" no grupo → responde e marca a pessoa.</div></div><button class="btn sm" id="gkNew">+ Nova regra</button></div>
        ${kws.length ? '<div class="elist" style="margin-top:10px">' + kws.map((k) => `<div class="erow ${k.enabled ? '' : 'off'}">${sw('', !!k.enabled, `data-gksw="${k.id}"`)}<div class="lmain"><div class="lname">${esc(k.words)} <span class="ftag">${{ contains: 'contém', exact: 'igual a', starts: 'começa com' }[k.match || 'contains']}</span></div>
          <div class="lsub">→ ${esc(pn(k.postId))} · ${esc(gTargetsLabel(k.targets))}${k.mentionSender !== false ? ' · marca quem perguntou' : ''} · 1x a cada ${k.cooldownMin || 10} min</div></div>
          <div class="lact"><button class="btn sm sec" data-gke="${k.id}">Editar</button><button class="btn sm red" data-gkd="${k.id}" title="Excluir">✕</button></div></div>`).join('') + '</div>' : ''}</div>`;
    box.innerHTML = h;
    const save = async () => { render(); await persist('gAuto'); };
    $('#gwSw').onchange = async (e) => {
      if (!w.postId) { e.target.checked = false; return gEditWelcome(); }
      DB.gAuto = Object.assign({}, a, { welcome: Object.assign({}, w, { enabled: e.target.checked }) });
      await save();
      toast('Boas-vindas ' + (e.target.checked ? 'ligada' : 'desligada'));
    };
    $('#gwEdit').onclick = () => gEditWelcome();
    $('#gkNew').onclick = () => gEditKw(null);
    $$('[data-gke]').forEach((b) => (b.onclick = () => gEditKw(kws.find((k) => k.id === b.dataset.gke))));
    $$('[data-gksw]').forEach((b) => (b.onchange = async () => {
      DB.gAuto = Object.assign({}, a, { keywords: kws.map((k) => (k.id === b.dataset.gksw ? Object.assign({}, k, { enabled: b.checked }) : k)) });
      await save();
    }));
    $$('[data-gkd]').forEach((b) => (b.onclick = async () => {
      const k = kws.find((x) => x.id === b.dataset.gkd);
      if (!confirm('Excluir a regra "' + k.words + '"?')) return;
      DB.gAuto = Object.assign({}, a, { keywords: kws.filter((x) => x.id !== k.id) });
      await save();
    }));
  }
  function gEditWelcome() {
    const w = Object.assign({ enabled: true, mentionNew: true, waitSec: 20, targets: { all: true } }, (DB.gAuto || {}).welcome || {});
    const p = postOf(w.postId);
    openModal(`<h2>👋 Boas-vindas</h2>
      <label>Mensagem</label><div id="gwMsg"></div><div class="hint" style="margin-top:6px">Use <b>{membro}</b> para o nome de quem entrou.</div>
      <label style="margin-top:12px">Em quais grupos</label>${targetsHtml(true)}
      <div class="row2"><div><label class="inline" style="margin-top:8px"><input type="checkbox" id="gwMen" ${w.mentionNew !== false ? 'checked' : ''}> Marcar quem entrou (oculto)</label></div>
      <div><label>Juntar entradas por (segundos)</label><input type="number" id="gwWait" min="3" max="600" value="${w.waitSec || 20}"><div class="hint">Se entrarem várias pessoas juntas, manda uma vez só.</div></div></div>
      <div class="modal-foot"><button class="btn sec" id="cancel">Cancelar</button><button class="btn" id="gwSave">Salvar e ligar</button></div>`);
    $('#cancel').onclick = closeModal;
    const mb = msgBuilder($('#gwMsg'), p ? p.parts : [{ kind: 'text', text: 'Seja bem-vindo(a), {membro}! 👋', mention: false, delay: 0 }], { saved: true, placeholder: 'Seja bem-vindo(a), {membro}! 👋' });
    const getT = bindTargets(w.targets);
    $('#gwSave').onclick = async () => {
      const parts = mb.get();
      if (!parts.length) return toast('Escreva a mensagem de boas-vindas');
      const t = getT();
      if (tgEmpty(t)) return toast('Escolha os grupos (ou "Todos os grupos")');
      const postId = savePost(w.postId, 'Boas-vindas', parts, true);
      DB.gAuto = Object.assign({}, DB.gAuto || {}, { welcome: { enabled: true, postId, targets: t, mentionNew: $('#gwMen').checked, waitSec: Math.max(3, Math.min(600, +$('#gwWait').value || 20)) } });
      closeModal();
      render();
      await persist('gPosts');
      await persist('gAuto');
      toast('Boas-vindas ligada');
    };
  }
  function gEditKw(k) {
    const isNew = !k;
    k = k ? JSON.parse(JSON.stringify(k)) : { id: gid(), words: '', match: 'contains', postId: '', targets: { all: true }, mentionSender: true, cooldownMin: 10, enabled: true };
    const p = postOf(k.postId);
    openModal(`<h2>🔑 ${isNew ? 'Nova regra' : 'Editar regra'}</h2>
      <div class="row2"><div><label>Palavras (separe por vírgula)</label><input type="text" id="gkW" value="${esc(k.words)}" placeholder="link, onde compra, valor"></div>
      <div><label>Quando a mensagem</label><select id="gkM">${[['contains', 'contém a palavra'], ['exact', 'é igual à palavra'], ['starts', 'começa com a palavra']].map(([v, t]) => `<option value="${v}" ${k.match === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
      <label style="margin-top:12px">Responder com</label><div id="gkMsg"></div>
      <label style="margin-top:12px">Em quais grupos</label>${targetsHtml(true)}
      <div class="row2"><div><label class="inline" style="margin-top:8px"><input type="checkbox" id="gkMen" ${k.mentionSender !== false ? 'checked' : ''}> Marcar quem perguntou (oculto)</label></div>
      <div><label>No máximo 1 resposta a cada (min, por grupo)</label><input type="number" id="gkCd" min="0" max="1440" value="${k.cooldownMin || 10}"></div></div>
      <div class="modal-foot"><button class="btn sec" id="cancel">Cancelar</button><button class="btn" id="gkSave">Salvar</button></div>`);
    $('#cancel').onclick = closeModal;
    const mb = msgBuilder($('#gkMsg'), p ? p.parts : null, { saved: true, placeholder: 'Oi {membro}! O link é: …' });
    const getT = bindTargets(k.targets);
    $('#gkSave').onclick = async () => {
      k.words = $('#gkW').value.split(',').map((x) => x.trim()).filter(Boolean).join(', ');
      if (!k.words) return toast('Escreva pelo menos uma palavra');
      const parts = mb.get();
      if (!parts.length) return toast('Escreva a resposta');
      k.targets = getT();
      if (tgEmpty(k.targets)) return toast('Escolha os grupos (ou "Todos os grupos")');
      k.postId = savePost(k.postId, 'Resposta: ' + k.words.slice(0, 30), parts, !isNew);
      k.match = $('#gkM').value;
      k.mentionSender = $('#gkMen').checked;
      k.cooldownMin = Math.max(0, Math.min(1440, +$('#gkCd').value || 0));
      const list = ((DB.gAuto || {}).keywords || []).slice();
      const i = list.findIndex((x) => x.id === k.id);
      if (i >= 0) list[i] = k;
      else list.push(k);
      DB.gAuto = Object.assign({}, DB.gAuto || {}, { keywords: list });
      closeModal();
      render();
      await persist('gPosts');
      await persist('gAuto');
      toast('Regra salva');
    };
  }

  // ------------------------------------------------------------ CAMPANHAS
  function renderCampaigns() {
    let h = `<h1>Disparo em massa</h1><p class="sub">Envie um funil para uma lista de contatos com intervalos aleatórios e pausas automáticas. Mantenha o WhatsApp Web aberto enquanto roda.</p>
      <div class="section" style="background:var(--yel-soft)"><b>⚠️ Evite bloqueio:</b> envie só para quem te conhece ou pediu contato, use intervalos de 30s+ e pausas longas a cada 20–30 envios. Números novos devem começar com poucos envios por dia.</div>
      <div class="bar"><span class="grow"></span><button class="btn" id="newC">+ Nova campanha</button></div>`;
    if (!DB.campaigns.length) h += `<div class="empty">Nenhuma campanha.</div>`;
    else {
      h += '<div class="grid">';
      DB.campaigns.slice().reverse().forEach((c) => {
        const total = c.contacts.length;
        const done = c.progress || 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        const btns = [];
        if (c.status === 'draft' || c.status === 'paused' || c.status === 'stopped' || c.status === 'error') btns.push(`<button class="btn sm" data-start="${c.id}">${done ? '▶ Continuar' : '▶ Iniciar'}</button>`);
        if (c.status === 'running') btns.push(`<button class="btn sm yel" data-pause="${c.id}">⏸ Pausar</button>`);
        if (c.status !== 'running') btns.push(`<button class="btn sm sec" data-edit="${c.id}">Editar</button>`);
        if (done) btns.push(`<button class="btn sm sec" data-csv="${c.id}">Relatório CSV</button>`);
        if (done && c.status !== 'running') btns.push(`<button class="btn sm sec" data-restart="${c.id}">Recomeçar</button>`);
        btns.push(`<button class="btn sm red" data-del="${c.id}">Excluir</button>`);
        h += `<div class="card"><h3>🚀 ${esc(c.name)} ${statusTag(c.status)}</h3>
          <div class="meta">${(c.variants || []).length > 1 ? '🔀 ' + c.variants.length + ' variações alternadas' : (c.variants || []).length === 1 ? esc(campVarLabel(c.variants[0])) : esc(targetName(c.targetType, c.targetId))} · intervalo ${c.minDelay}–${c.maxDelay}s${c.pauseEvery ? ` · pausa ${c.pauseMinutes}min a cada ${c.pauseEvery}` : ''}</div>
          <div class="progress"><div style="width:${pct}%"></div></div>
          <div class="meta">${done}/${total} · ✅ ${c.sent || 0} enviados · ❌ ${c.failed || 0} falhas${c.status === 'running' && c.nextAt > Date.now() ? ' · próximo às ' + new Date(c.nextAt).toLocaleTimeString('pt-BR') : ''}</div>
          ${c.lastError ? `<div class="hint" style="color:var(--red)">${esc(c.lastError)}</div>` : ''}
          <div class="actions">${btns.join('')}</div></div>`;
      });
      h += '</div>';
    }
    $('#main').innerHTML = h;
    $('#newC').onclick = () => editCampaign(null);
    const setStatus = async (id, status, extra) => {
      if (status === 'running' && DB.campaigns.some((c) => c.status === 'running' && c.id !== id)) return toast('Já existe uma campanha rodando. Pause-a primeiro.');
      DB.campaigns = DB.campaigns.map((c) => (c.id === id ? Object.assign({}, c, { status, lastError: '' }, extra || {}) : c));
      await persist('campaigns');
      if (status === 'running') {
        chrome.runtime.sendMessage({ type: 'focusWhatsApp' }, (r) => {
          if (r && r.ok === false) toast('Abri o WhatsApp Web – a campanha começa assim que ele carregar.');
        });
      }
      renderCampaigns();
    };
    $$('[data-start]').forEach((b) => (b.onclick = () => setStatus(b.dataset.start, 'running')));
    $$('[data-pause]').forEach((b) => (b.onclick = () => setStatus(b.dataset.pause, 'paused')));
    $$('[data-restart]').forEach((b) => (b.onclick = () => {
      if (confirm('Recomeçar do zero? Todos os contatos receberão de novo.')) setStatus(b.dataset.restart, 'draft', { progress: 0, results: [], sent: 0, failed: 0 });
    }));
    $$('[data-edit]').forEach((b) => (b.onclick = () => editCampaign(DB.campaigns.find((c) => c.id === b.dataset.edit))));
    $$('[data-csv]').forEach((b) => (b.onclick = () => {
      const c = DB.campaigns.find((x) => x.id === b.dataset.csv);
      const rows = [['numero', 'nome', 'variacao', 'status', 'erro', 'horario']].concat((c.results || []).map((r) => [r.number, r.name, r.v || '', r.ok ? 'enviado' : 'falha', r.err || '', fmtDate(r.t)]));
      const csv = rows.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(';')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
      a.download = 'campanha-' + c.name.replace(/\W+/g, '-') + '.csv';
      a.click();
    }));
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const c = DB.campaigns.find((x) => x.id === b.dataset.del);
      if (c.status === 'running') return toast('Pause a campanha antes de excluir');
      await removeWithUndo('campaigns', c.id, c.name);
    }));
  }
  const VL = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
  function campVarLabel(v) {
    if (!v) return '';
    if (v.kind === 'text') return '💬 ' + String(v.text || '').slice(0, 40);
    return targetName(v.kind === 'funnel' ? 'funnel' : 'item', v.kind === 'funnel' ? v.funnelId : v.itemId);
  }
  function editCampaign(c) {
    const isNew = !c;
    c = c ? JSON.parse(JSON.stringify(c)) : { id: ZF.uid(), name: '', contacts: [], variants: [{ kind: 'text', text: '' }], minDelay: 40, maxDelay: 90, pauseEvery: 25, pauseMinutes: 10, status: 'draft', progress: 0, results: [] };
    // campanha antiga (um único funil/item) vira a variação A
    if (!c.variants || !c.variants.length) c.variants = c.targetId ? [c.targetType === 'item' ? { kind: 'item', itemId: c.targetId } : { kind: 'funnel', funnelId: c.targetId }] : [{ kind: 'text', text: '' }];
    openModal(`<h2>${isNew ? 'Nova campanha' : 'Editar campanha'}</h2>
      <label>Nome</label><input type="text" id="cName" value="${esc(c.name)}" placeholder="Ex: Remarketing Black Friday">
      <label style="margin-top:12px">Contatos – um por linha: <code>numero,nome</code></label><textarea id="cList" style="min-height:130px" placeholder="11999998888,Maria\n21988887777,João">${esc(c.contacts.map((x) => x.number + (x.name ? ',' + x.name : '')).join('\n'))}</textarea>
      <div class="bar" style="margin-top:6px"><input type="file" id="cCsv" accept=".csv,.txt" style="max-width:240px"><button type="button" class="btn sm sec" id="cGrpBtn">👥 Puxar membros de grupo</button><span class="hint" id="cCount"></span></div>
      <div id="cGrp" style="display:none">${GROUP_BOX_HTML}<div class="bar" style="margin:-4px 0 10px"><label class="inline" style="margin:0"><input type="checkbox" id="cSkipAdm"> Pular administradores</label><span class="grow"></span><button type="button" class="btn sm" id="cGrpAdd">Adicionar membros à lista</button></div><div class="hint" id="cGrpMsg"></div></div>
      <div class="hint">Aceita CSV (número na 1ª coluna, nome na 2ª). Números repetidos são removidos.</div>
      <label style="margin-top:14px">Mensagens — variações</label>
      <div class="hint" style="margin-bottom:8px">Cada contato recebe <b>uma</b> variação, alternando na ordem: 1º contato → A, 2º → B, 3º → C… e volta para A. Mensagens diferentes ajudam a evitar bloqueio. Use {nome}, {primeiro_nome} e suas variações ({oi}…).</div>
      <div id="cVars"></div>
      <div class="bar" style="margin:6px 0 0"><button type="button" class="btn sm sec" id="cAddT">+ Variação de texto</button><button type="button" class="btn sm sec" id="cAddA">+ Variação do acervo (áudio, mídia, funil…)</button></div>
      <div class="row2" style="margin-top:12px"><div><label>Intervalo mínimo entre contatos (s)</label><input type="number" id="cMin" min="5" value="${c.minDelay}"></div>
      <div><label>Intervalo máximo (s)</label><input type="number" id="cMax" min="5" value="${c.maxDelay}"></div></div>
      <div class="row2"><div><label>Pausa longa a cada X envios (0 = nunca)</label><input type="number" id="cPe" min="0" value="${c.pauseEvery}"></div>
      <div><label>Duração da pausa (min)</label><input type="number" id="cPm" min="1" value="${c.pauseMinutes}"></div></div>
      <div class="modal-foot"><button class="btn sec" id="cancel">Cancelar</button><button class="btn" id="saveC">Salvar</button></div>`);
    const count = () => {
      const seen = new Set();
      const n = parseNumbers($('#cList').value).filter((x) => !seen.has(x.number) && seen.add(x.number)).length;
      const v = c.variants.length;
      $('#cCount').textContent = n + ' contato(s) válido(s)' + (v > 1 && n ? ' · cada variação vai para ~' + Math.ceil(n / v) : '');
    };
    // ----- variações
    const box = $('#cVars');
    const read = () => {
      $$('.cvar', box).forEach((row, i) => {
        const v = c.variants[i];
        if (!v) return;
        if (v.kind === 'text') v.text = $('textarea', row).value;
        else {
          const val = $('select.tg', row).value;
          const [k, ...rest] = val.split(':');
          if (k === 'funnel') { v.kind = 'funnel'; v.funnelId = rest.join(':'); delete v.itemId; } else { v.kind = 'item'; v.itemId = rest.join(':'); delete v.funnelId; }
        }
      });
    };
    const draw = () => {
      box.innerHTML = '';
      c.variants.forEach((v, i) => {
        const row = document.createElement('div');
        row.className = 'cvar step';
        row.innerHTML = `<div class="gp-head"><span class="vletter">${VL(i)}</span><b>${v.kind === 'text' ? '💬 Texto' : '📦 Do acervo'}</b><span class="grow"></span>
          ${v.kind === 'text' ? `<button type="button" class="btn sm sec" data-vdup="${i}" title="Duplicar para criar outra parecida">⧉</button>` : ''}<button type="button" class="btn sm sec" data-vup="${i}" title="Subir">↑</button><button type="button" class="btn sm sec" data-vdn="${i}" title="Descer">↓</button><button type="button" class="btn sm red" data-vrm="${i}" title="Tirar">✕</button></div>
          ${v.kind === 'text' ? `<textarea rows="3" placeholder="{Oi} {primeiro_nome}! Tudo bem? Passando pra te avisar que…">${esc(v.text || '')}</textarea>` : `<select class="tg"><option value="">— escolha —</option>${targetOptions(v.kind === 'funnel' ? 'funnel' : 'item', v.kind === 'funnel' ? v.funnelId : v.itemId)}</select>`}`;
        box.appendChild(row);
        if (v.kind !== 'text' && !(v.itemId || v.funnelId)) row.querySelector('select.tg').value = '';
      });
      $$('[data-vup]', box).forEach((b) => (b.onclick = () => { read(); const i = +b.dataset.vup; if (i > 0) { [c.variants[i - 1], c.variants[i]] = [c.variants[i], c.variants[i - 1]]; draw(); } }));
      $$('[data-vdn]', box).forEach((b) => (b.onclick = () => { read(); const i = +b.dataset.vdn; if (i < c.variants.length - 1) { [c.variants[i + 1], c.variants[i]] = [c.variants[i], c.variants[i + 1]]; draw(); } }));
      $$('[data-vrm]', box).forEach((b) => (b.onclick = () => { read(); c.variants.splice(+b.dataset.vrm, 1); if (!c.variants.length) c.variants.push({ kind: 'text', text: '' }); draw(); }));
      $$('[data-vdup]', box).forEach((b) => (b.onclick = () => { read(); const i = +b.dataset.vdup; c.variants.splice(i + 1, 0, Object.assign({}, c.variants[i])); draw(); }));
      count();
    };
    draw();
    $('#cAddT').onclick = () => { read(); c.variants.push({ kind: 'text', text: '' }); draw(); setTimeout(() => { const t = $$('.cvar textarea', box).pop(); if (t) t.focus(); }, 20); };
    $('#cAddA').onclick = () => { read(); c.variants.push({ kind: 'item', itemId: '' }); draw(); setTimeout(() => { const b = $$('.cvar .pk-btn', box).pop(); if (b) b.click(); }, 30); };
    // ----- membros de grupo
    let getG = null;
    $('#cGrpBtn').onclick = () => {
      const g = $('#cGrp');
      g.style.display = g.style.display === 'none' ? '' : 'none';
      if (!getG) getG = groupBox([]);
    };
    $('#cGrpAdd').onclick = async () => {
      const groups = getG ? getG() : [];
      if (!groups.length) return toast('Marque pelo menos um grupo');
      const btn = $('#cGrpAdd');
      btn.disabled = true;
      btn.textContent = 'Puxando…';
      const existing = new Set(parseNumbers($('#cList').value).map((x) => x.number));
      let added = 0, dup = 0, hidden = 0, adm = 0;
      const errs = [];
      const lines = [];
      for (const g of groups) {
        const r = await bgMsg({ type: 'wa:gmembers', groupId: g.id });
        if (!r || !r.members) { errs.push((g.name || 'grupo') + ': ' + ((r && r.error) || 'erro')); continue; }
        hidden += r.hidden || 0;
        for (const m of r.members) {
          if ($('#cSkipAdm').checked && m.admin) { adm++; continue; }
          const num = ZF.normalizeNumber(m.number);
          if (!num) continue;
          if (existing.has(num)) { dup++; continue; }
          existing.add(num);
          lines.push(num + (m.name ? ',' + m.name.replace(/[,;\n]/g, ' ') : ''));
          added++;
        }
      }
      if (lines.length) $('#cList').value = ($('#cList').value.trim() ? $('#cList').value.trim() + '\n' : '') + lines.join('\n');
      btn.disabled = false;
      btn.textContent = 'Adicionar membros à lista';
      $('#cGrpMsg').innerHTML = `✅ <b>${added}</b> adicionado(s)` + (dup ? ` · ${dup} já estavam na lista` : '') + (adm ? ` · ${adm} admin(s) pulado(s)` : '') + (hidden ? ` · <span style="color:var(--red)">${hidden} com número escondido pelo WhatsApp (ficaram de fora)</span>` : '') + (errs.length ? `<div style="color:var(--red)">${esc(errs.join(' · '))}</div>` : '');
      count();
    };
    $('#cList').oninput = count;
    $('#cCsv').onchange = async () => {
      const f = $('#cCsv').files[0];
      if (!f) return;
      const txt = await f.text();
      const lines = txt.split(/\r?\n/).map((l) => l.replace(/"/g, '').split(/[;,\t]/)).filter((p) => p[0] && /\d{8,}/.test(p[0].replace(/\D/g, '')));
      $('#cList').value = ($('#cList').value.trim() ? $('#cList').value.trim() + '\n' : '') + lines.map((p) => p[0].trim() + (p[1] ? ',' + p[1].trim() : '')).join('\n');
      count();
    };
    $('#cancel').onclick = closeModal;
    $('#saveC').onclick = async () => {
      read();
      c.name = $('#cName').value.trim() || 'Campanha ' + new Date().toLocaleDateString('pt-BR');
      const seen = new Set();
      const newContacts = parseNumbers($('#cList').value).filter((x) => !seen.has(x.number) && seen.add(x.number));
      if (!newContacts.length) return toast('Adicione contatos válidos');
      const vars = c.variants.filter((v) => (v.kind === 'text' ? String(v.text || '').trim() : v.itemId || v.funnelId));
      if (!vars.length) return toast('Crie pelo menos uma mensagem');
      if (vars.length < c.variants.length) return toast('Tem variação vazia — preencha ou tire (✕)');
      c.variants = vars;
      // compatibilidade (celular / versões antigas): o alvo principal é a variação A quando ela é do acervo
      const v0 = vars[0];
      c.targetType = v0.kind === 'funnel' ? 'funnel' : v0.kind === 'item' ? 'item' : '';
      c.targetId = v0.kind === 'funnel' ? v0.funnelId : v0.kind === 'item' ? v0.itemId : '';
      const changed = JSON.stringify(newContacts) !== JSON.stringify(c.contacts);
      c.contacts = newContacts;
      if (changed && c.progress > c.contacts.length) c.progress = c.contacts.length;
      c.minDelay = Math.max(5, Number($('#cMin').value) || 40);
      c.maxDelay = Math.max(c.minDelay, Number($('#cMax').value) || c.minDelay);
      c.pauseEvery = Math.max(0, Number($('#cPe').value) || 0);
      c.pauseMinutes = Math.max(1, Number($('#cPm').value) || 10);
      const idx = DB.campaigns.findIndex((x) => x.id === c.id);
      if (idx >= 0) DB.campaigns[idx] = c;
      else DB.campaigns.push(c);
      await persist('campaigns');
      closeModal();
      toast('Campanha salva. Clique em Iniciar quando quiser.');
      renderCampaigns();
    };
  }


  // ------------------------------------------------------------ CELULAR (controle remoto)
  function bgMsg(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: (chrome.runtime.lastError || {}).message || 'sem resposta' })));
  }
  async function renderMobile() {
    const st = await bgMsg({ type: 'remote:status' });
    const s = (st.ok && st.data) || {};
    const appUrl = s.appUrl || '';
    let h = `<h1>Celular</h1><p class="sub">Controle a ZapFunil pelo iPhone: mande funis e mensagens, pare remarketing, agende e pause campanhas. O Mac precisa estar ligado com o WhatsApp Web aberto (é ele quem envia).</p>`;
    if (!s.configured) h += `<div class="empty">Controle remoto não configurado nesta versão.</div>`;
    else if (!s.logged) {
      h += `<div class="section"><h3>1. Conectar sua conta</h3>
        <p class="hint">Crie a conta uma única vez (só você pode ter conta neste projeto). Use a mesma no iPhone.</p>
        <div class="row2"><div><label>E-mail</label><input type="text" id="mEmail" autocomplete="username" placeholder="voce@email.com"></div>
        <div><label>Senha (mín. 8 caracteres)</label><input type="password" id="mPass" autocomplete="current-password"></div></div>
        <div class="bar" style="margin-top:12px"><button class="btn" id="mLogin">Entrar</button><button class="btn sec" id="mSignup">Criar conta (primeira vez)</button></div>
        <div class="hint" id="mMsg"></div></div>`;
    } else {
      h += `<div class="section"><h3>✅ Conectado como ${esc(s.email || '')}</h3>
        <p class="hint">A aba do WhatsApp Web envia o status para o celular e recebe os comandos a cada poucos segundos.</p>
        <button class="btn sec" id="mLogout">Desconectar</button></div>`;
    }
    h += `<div class="section"><h3>2. Abrir no iPhone</h3>
      ${appUrl ? `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap"><div id="qr" style="background:#fff;padding:10px;border-radius:10px"></div>
      <div><p class="hint" style="font-size:13px;line-height:1.7">1. Aponte a câmera do iPhone para o QR code (ou abra <b>${esc(appUrl)}</b> no Safari).<br>
      2. Toque em <b>Compartilhar</b> (quadrado com seta) → <b>Adicionar à Tela de Início</b>.<br>
      3. Abra o ícone ⚡ ZapFunil e entre com o mesmo e-mail e senha.</p></div></div>` : '<p class="hint">O link do app aparece aqui.</p>'}</div>`;
    $('#main').innerHTML = h;
    if (appUrl && window.qrcode) {
      const qr = qrcode(0, 'M');
      qr.addData(appUrl);
      qr.make();
      $('#qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0 });
    }
    const msg = (t, bad) => { const m = $('#mMsg'); if (m) { m.textContent = t; m.style.color = bad ? 'var(--red)' : ''; } };
    const go = async (type) => {
      const email = $('#mEmail').value.trim(), password = $('#mPass').value;
      if (!email || password.length < 8) return msg('Informe e-mail e senha (mín. 8 caracteres).', true);
      msg('Aguarde…');
      const r = await bgMsg({ type, email, password });
      if (!r.ok) return msg(/already|registered|fechado|dono/i.test(r.error) ? 'Já existe uma conta neste projeto. Use "Entrar".' : /confirm/i.test(r.error) ? 'Confirme seu e-mail (link que chegou na sua caixa) e clique em Entrar.' : /invalid/i.test(r.error) ? 'E-mail ou senha incorretos.' : r.error, true);
      if (type === 'remote:signup' && r.data && !r.data.confirmed) return msg('Conta criada! Abra o e-mail de confirmação que o Supabase mandou, clique no link e depois volte aqui e clique em Entrar.');
      toast('Conectado!');
      renderMobile();
    };
    if ($('#mLogin')) $('#mLogin').onclick = () => go('remote:login');
    if ($('#mSignup')) $('#mSignup').onclick = () => go('remote:signup');
    if ($('#mLogout')) $('#mLogout').onclick = async () => { await bgMsg({ type: 'remote:logout' }); renderMobile(); };
  }

  // ------------------------------------------------------------ BUSCA GERAL (⌘K / Ctrl+K)
  let gq = '';
  let beforeSearch = null;
  function renderSearch() {
    const q = ZF.normalizeText(gq).trim();
    const hit = (...parts) => ZF.normalizeText(parts.join(' ')).includes(q);
    const itemName = (id) => (DB.items.find((x) => x.id === id) || {}).name || '';
    const groups = [];
    if (q) {
      const its = DB.items.filter((i) => hit(i.name, i.text, i.caption, i.shortcut, i.folder, i.filename, ZF.typeLabel(i.type)));
      if (its.length) groups.push(['💬 Mensagens, áudios e mídias', its.map((i) => ({ icon: ZF.typeIcon(i.type), name: i.name, sub: (i.shortcut ? '/' + i.shortcut + ' · ' : '') + (folderOf(i) ? '📁 ' + folderOf(i) + ' · ' : '') + (i.type === 'text' ? (i.text || '').slice(0, 90) : ZF.typeLabel(i.type) + (i.caption ? ' · ' + i.caption.slice(0, 60) : '')), act: 'item:' + i.id }))]);
      const fs = DB.funnels.filter((f) => hit(f.name, f.shortcut, f.folder, f.steps.map((st) => itemName(st.itemId)).join(' ')));
      if (fs.length) groups.push(['🔁 Funis', fs.map((f) => ({ icon: '🔁', name: f.name, sub: (f.shortcut ? '/' + f.shortcut + ' · ' : '') + (folderOf(f) ? '📁 ' + folderOf(f) + ' · ' : '') + f.steps.length + ' etapa(s)', act: 'funnel:' + f.id }))]);
      const ge = (DB.gSchedules || []).filter((x) => { const p = postOf(x.postId); return p && hit(p.name, (p.parts || []).map((y) => y.text || '').join(' '), gTargetsLabel(x.targets)); });
      if (ge.length) groups.push(['👥 Envios de grupo', ge.map((x) => { const p = postOf(x.postId); return { icon: '📨', name: p.name, sub: gTargetsLabel(x.targets) + ' · ' + repeatLabel(x) + (postHasMention(p) ? ' · @ todos' : ''), act: 'genv:' + x.id }; })]);
      const rs = DB.remarketing.filter((r) => hit(r.name, r.stages.map((x) => targetName(x.targetType, x.targetId)).join(' ')));
      if (rs.length) groups.push(['🔔 Remarketing', rs.map((r) => ({ icon: '🔔', name: r.name, sub: RM_MODE[r.mode || 'no_reply'].label + ' · ' + r.stages.length + ' etapa(s)' + (r.enabled ? '' : ' · pausada'), act: 'rmkt:' + r.id }))]);
      const ts = DB.triggers.filter((t) => hit(t.name, (t.keywords || []).join(' '), targetName(t.targetType, t.targetId)));
      if (ts.length) groups.push(['🎯 Gatilhos', ts.map((t) => ({ icon: '🎯', name: t.name || (t.keywords || []).join(', '), sub: (MATCH[t.match] || '') + ' ' + (t.keywords || []).join(', ') + ' → ' + targetName(t.targetType, t.targetId), act: 'trig:' + t.id }))]);
      const ss = DB.schedules.filter((x) => hit(x.numbers.join(' '), x.useName, targetName(x.targetType, x.targetId)));
      if (ss.length) groups.push(['⏰ Agendamentos', ss.map((x) => ({ icon: '⏰', name: fmtDate(x.at) + ' → ' + targetName(x.targetType, x.targetId), sub: x.numbers.slice(0, 3).join(', '), act: 'sch:' + x.id }))]);
      const cs = DB.campaigns.filter((c) => hit(c.name, targetName(c.targetType, c.targetId)));
      if (cs.length) groups.push(['🚀 Campanhas', cs.map((c) => ({ icon: '🚀', name: c.name, sub: (c.progress || 0) + '/' + c.contacts.length + ' · ' + targetName(c.targetType, c.targetId), act: 'camp:' + c.id }))]);
      const contacts = new Map();
      (DB.rmktQueue || []).forEach((e) => { if (hit(e.name, e.chatId)) contacts.set(e.chatId, { name: e.name, n: (contacts.get(e.chatId) || {}).n + 1 || 1 }); });
      if (contacts.size) groups.push(['👤 Contatos no remarketing', Array.from(contacts.entries()).slice(0, 30).map(([id, c]) => ({ icon: '👤', name: c.name || id.replace(/@.*/, ''), sub: id.replace(/@.*/, '') + ' · ' + c.n + ' registro(s)', act: 'view:remarketing' }))]);
    }
    const total = groups.reduce((a, g) => a + g[1].length, 0);
    let h = `<h1>Buscar</h1><p class="sub">${q ? total + ' resultado(s) para <b>' + esc(gq) + '</b>' : 'Digite no campo 🔎 à esquerda. Busca em mensagens, funis, remarketing, gatilhos, agendamentos, campanhas e contatos.'}</p>`;
    if (q && !total) h += '<div class="empty">Nada encontrado.</div>';
    groups.forEach(([title, rows]) => {
      h += `<div class="srch-group">${title} (${rows.length})</div><div class="list">`;
      rows.forEach((r) => {
        h += `<div class="lrow card" style="cursor:pointer" data-go="${esc(r.act)}"><span class="licon">${r.icon}</span><div class="lmain"><div class="lname">${esc(r.name)}</div><div class="lsub">${esc(r.sub)}</div></div><div class="lact"><button class="btn sm sec" type="button">Abrir</button></div></div>`;
      });
      h += '</div>';
    });
    $('#main').innerHTML = h;
    $$('[data-go]').forEach((row) => (row.onclick = () => {
      const [k, id] = row.dataset.go.split(/:(.*)/s);
      // vai para a tela certa e abre o editor (ao salvar, você continua nela)
      leaveSearch();
      if (k === 'item') {
        const it = DB.items.find((x) => x.id === id);
        if (!it) return;
        if (!folderMatch(it, curFolder)) curFolder = '';
        setView('items', it.type === 'image' || it.type === 'video' ? 'media' : it.type);
        return editItem(it);
      }
      if (k === 'funnel') {
        const f = DB.funnels.find((x) => x.id === id);
        if (f && !folderMatch(f, curFolder)) curFolder = '';
        setView('funnels');
        return f && editFunnel(f);
      }
      if (k === 'rmkt') { setView('remarketing'); return editRemarketing(DB.remarketing.find((x) => x.id === id)); }
      if (k === 'trig') { setView('triggers'); return editTrigger(DB.triggers.find((x) => x.id === id)); }
      if (k === 'sch') { setView('schedules'); return editSchedule(DB.schedules.find((x) => x.id === id)); }
      if (k === 'genv') { gTab = 'envios'; setView('groups'); return gWizard(DB.gSchedules.find((x) => x.id === id)); }
      if (k === 'camp') return setView('campaigns');
      if (k === 'view') return setView(id);
    }));
  }
  function leaveSearch() {
    gq = '';
    $('#gsearch').value = '';
  }
  $('#gsearch').addEventListener('input', () => {
    gq = $('#gsearch').value;
    if (gq.trim()) {
      if (view !== 'search') beforeSearch = [view, filter];
      view = 'search';
      $$('#nav a').forEach((a) => a.classList.remove('on'));
      renderSearch();
    } else if (view === 'search') {
      const b = beforeSearch || ['items', filter];
      setView(b[0], b[1]);
    }
  });
  $('#gsearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { leaveSearch(); $('#gsearch').dispatchEvent(new Event('input')); $('#gsearch').blur(); }
    if (e.key === 'Enter') { const first = $('[data-go]'); if (first) first.click(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#gsearch').focus();
      $('#gsearch').select();
    }
  });
  // clicar no menu sai da busca
  $$('#nav a').forEach((a) => a.addEventListener('click', () => { if (gq) leaveSearch(); }, true));

  // ------------------------------------------------------------ RELATÓRIO
  let repDays = (() => { try { return Number(localStorage.getItem('zfRepDays')) || 30; } catch (e) { return 30; } })();
  const SRC_LABEL = { manual: '👆 Manual (você clicou)', gatilho: '🎯 Gatilhos', remarketing: '🔔 Remarketing', agendamento: '⏰ Agendamentos', campanha: '🚀 Campanhas', celular: '📱 Pelo celular', grupo: '👥 Grupos' };
  function repDaysList(n) {
    const out = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) out.push(ZF.dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12).getTime()));
    return out;
  }
  function repAggregate(keys) {
    const st = DB.stats || {};
    const a = { ok: 0, fail: 0, cancel: 0, msgs: 0, replied: 0, optout: 0, src: {}, top: {}, types: {}, chats: new Set(), perDay: [] };
    keys.forEach((k) => {
      const d = st[k] || {};
      ['ok', 'fail', 'cancel', 'msgs', 'replied', 'optout'].forEach((f) => (a[f] += d[f] || 0));
      ['src', 'top', 'types'].forEach((f) => Object.entries(d[f] || {}).forEach(([x, n]) => (a[f][x] = (a[f][x] || 0) + n)));
      (d.chats || []).forEach((c) => a.chats.add(c));
      a.perDay.push({ k, ok: d.ok || 0, fail: d.fail || 0, msgs: d.msgs || 0, chats: (d.chats || []).length, replied: d.replied || 0 });
    });
    return a;
  }
  function renderReport() {
    const keys = repDaysList(repDays);
    const a = repAggregate(keys);
    const prev = repAggregate(repDaysList(repDays * 2).slice(0, repDays));
    const since = Object.keys(DB.stats || {}).filter((k) => /^\d{4}-/.test(k)).sort()[0];
    const pct = (x, y) => (y ? Math.round((x / y) * 100) + '%' : '–');
    const diff = (cur, old) => (old ? (cur >= old ? '▲ ' : '▼ ') + Math.abs(Math.round(((cur - old) / old) * 100)) + '% vs período anterior' : '');
    const fmtD = (k) => k.slice(8, 10) + '/' + k.slice(5, 7);
    const rm = a.src.remarketing || 0;
    let h = `<h1>Relatório</h1><p class="sub">O que a ZapFunil enviou por você. ${since ? 'Contando desde ' + fmtD(since) + '/' + since.slice(0, 4) + '.' : 'Começa a contar a partir de agora.'} Funis e mensagens soltas contam como “envios”; cada mensagem/áudio/mídia dentro deles conta em “mensagens”.</p>
      <div class="bar"><div class="seg" style="margin-left:0">${[7, 30, 90].map((n) => `<button type="button" data-rd="${n}" class="${repDays === n ? 'on' : ''}">${n} dias</button>`).join('')}<button type="button" data-rd="1" class="${repDays === 1 ? 'on' : ''}">Hoje</button></div>
      <span class="grow"></span><button class="btn sec sm" id="repCsv">Exportar CSV</button></div>
      <div class="kpis">
        <div class="kpi"><span>Envios concluídos</span><b>${a.ok}</b><small>${diff(a.ok, prev.ok)}</small></div>
        <div class="kpi"><span>Mensagens enviadas</span><b>${a.msgs}</b><small>${diff(a.msgs, prev.msgs)}</small></div>
        <div class="kpi"><span>Contatos alcançados</span><b>${a.chats.size}</b><small>${diff(a.chats.size, prev.chats.size)}</small></div>
        <div class="kpi"><span>Responderam ao remarketing</span><b>${a.replied}</b><small>${rm ? pct(a.replied, rm) + ' de ' + rm + ' envios de rmkt' : ''}</small></div>
        <div class="kpi"><span>Falhas</span><b style="${a.fail ? 'color:var(--red)' : ''}">${a.fail}</b><small>${a.ok + a.fail ? pct(a.fail, a.ok + a.fail) + ' dos envios' : ''}${a.cancel ? ' · ' + a.cancel + ' cancelado(s)' : ''}</small></div>
        <div class="kpi"><span>Pediram pra sair</span><b>${a.optout}</b><small>descadastro do remarketing</small></div>
      </div>`;
    if (repDays > 1) {
      const max = Math.max(1, ...a.perDay.map((d) => d.ok + d.fail));
      h += `<div class="section"><h3>Envios por dia</h3><div class="chart">${a.perDay.map((d) => `<div class="col" title="${fmtD(d.k)}: ${d.ok} envio(s), ${d.msgs} mensagem(ns), ${d.chats} contato(s)${d.fail ? ', ' + d.fail + ' falha(s)' : ''}${d.replied ? ', ' + d.replied + ' resposta(s) no rmkt' : ''}"><i class="f" style="height:${(d.fail / max) * 100}%"></i><i style="height:${(d.ok / max) * 100}%"></i></div>`).join('')}</div>
        <div class="chart-x"><span>${fmtD(keys[0])}</span><span>${fmtD(keys[Math.floor(keys.length / 2)])}</span><span>hoje</span></div><div class="hint">Passe o mouse nas barras para ver o dia. Vermelho = falhas.</div></div>`;
    }
    const hbars = (obj, label, limit) => {
      const rows = Object.entries(obj).sort((x, y) => y[1] - x[1]).slice(0, limit || 10);
      if (!rows.length) return '<div class="hint">Nada ainda.</div>';
      const max = rows[0][1] || 1;
      return rows.map(([k, n]) => `<div class="hbar"><span class="l" title="${esc(label(k))}">${esc(label(k))}</span><span class="t"><i style="width:${(n / max) * 100}%"></i></span><span class="n">${n}</span></div>`).join('');
    };
    h += `<div class="rep2"><div class="section"><h3>De onde vieram os envios</h3>${hbars(a.src, (k) => SRC_LABEL[k] || k)}</div>
      <div class="section"><h3>Tipos de mensagem</h3>${hbars(a.types, (k) => ZF.typeIcon(k) + ' ' + ZF.typeLabel(k))}</div></div>
      <div class="section"><h3>Mais enviados</h3>${hbars(a.top, (k) => k, 12)}</div>`;
    const camps = DB.campaigns.filter((c) => c.sent || c.failed);
    if (camps.length) h += `<div class="section"><h3>Campanhas (total)</h3><table><tr><th>Campanha</th><th>Enviados</th><th>Falhas</th><th>Status</th></tr>${camps.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.sent || 0}</td><td>${c.failed || 0}</td><td>${statusTag(c.status)}</td></tr>`).join('')}</table></div>`;
    const q = DB.rmktQueue || [];
    h += `<div class="section"><h3>Remarketing agora</h3><p class="hint">👥 ${q.filter((e) => e.status === 'waiting' || e.status === 'sending').length} na fila · ✅ ${q.filter((e) => e.status === 'replied').length} responderam · ${q.filter((e) => e.status === 'done').length} concluíram · ${Object.keys(DB.rmktBlock || {}).length} descadastrados (contagem da fila atual)</p></div>`;
    $('#main').innerHTML = h;
    $$('[data-rd]').forEach((b) => (b.onclick = () => {
      repDays = Number(b.dataset.rd);
      try { localStorage.setItem('zfRepDays', String(repDays)); } catch (e) {}
      renderReport();
    }));
    $('#repCsv').onclick = () => {
      const all = repDaysList(Math.max(repDays, 1));
      const rows = [['dia', 'envios', 'mensagens', 'contatos', 'falhas', 'cancelados', 'respostas_rmkt', 'descadastros']].concat(all.map((k) => {
        const d = (DB.stats || {})[k] || {};
        return [k, d.ok || 0, d.msgs || 0, (d.chats || []).length, d.fail || 0, d.cancel || 0, d.replied || 0, d.optout || 0];
      }));
      const a2 = document.createElement('a');
      a2.href = URL.createObjectURL(new Blob(['﻿' + rows.map((r) => r.join(';')).join('\n')], { type: 'text/csv' }));
      a2.download = 'zapfunil-relatorio-' + ZF.dayKey() + '.csv';
      a2.click();
    };
  }

  // ------------------------------------------------------------ HISTÓRICO
  function renderHistory() {
    let h = `<h1>Histórico</h1><p class="sub">Últimos 500 envios (manuais, gatilhos, agendamentos e campanhas).</p>
      <div class="bar"><span class="grow"></span><button class="btn sec" id="clrH">Limpar histórico</button></div>`;
    if (!DB.history.length) h += '<div class="empty">Nada enviado ainda.</div>';
    else {
      h += '<table><tr><th>Quando</th><th>Contato</th><th>O quê</th><th>Origem</th><th>Resultado</th></tr>';
      DB.history.forEach((x) => {
        h += `<tr><td>${fmtDate(x.t)}</td><td>${esc(x.name || '')} <span class="hint">${esc((x.chatId || '').replace(/@.*/, ''))}</span></td><td>${esc(x.what)}</td><td>${esc(x.source || '')}</td>
          <td>${x.ok ? '<span class="tag">OK</span>' : `<span class="tag err">${esc(x.err || 'falha')}</span>`}</td></tr>`;
      });
      h += '</table>';
    }
    $('#main').innerHTML = h;
    $('#clrH').onclick = async () => {
      if (!confirm('Limpar histórico?')) return;
      DB.history = [];
      await persist('history');
      renderHistory();
    };
  }

  // ------------------------------------------------------------ CONFIGURAÇÕES
  function renderSettings() {
    const s = DB.settings;
    const ab = Object.assign({}, ZF.DEFAULT_SETTINGS.autoBackup, s.autoBackup || {});
    $('#main').innerHTML = `<h1>Configurações</h1><p class="sub">Ajuste a simulação humana e faça backup dos seus dados.</p>
      <div class="section" style="${s.automationsPaused ? 'background:var(--yel-soft)' : ''}"><h3>${s.automationsPaused ? '⏸ Automações PAUSADAS' : '▶ Automações LIGADAS'}</h3>
        <p class="hint">Liga/desliga de uma vez gatilhos, remarketing, agendamentos e campanhas. Envio manual pelo painel ⚡ continua funcionando. Também dá pra trocar pelo botão "Auto" no WhatsApp.</p>
        <button class="btn ${s.automationsPaused ? '' : 'yel'}" id="togAuto">${s.automationsPaused ? '▶ Ligar automações' : '⏸ Pausar todas as automações'}</button></div>
      <div class="section"><h3>💬 No WhatsApp Web</h3>
        <label class="inline"><input type="checkbox" id="sConfirm" ${s.confirmSend !== false ? 'checked' : ''}> Pedir confirmação antes de enviar (barra e sugestões)</label><br>
        <label class="inline"><input type="checkbox" id="sSuggest" ${s.suggestOnType !== false ? 'checked' : ''}> Mostrar sugestões enquanto digito na caixa de mensagem</label>
        <div class="hint">A barra com seus funis e mensagens fica logo abaixo da caixa de mensagem. Dá pra esconder pelo ▾ e mostrar de novo pelo painel ⚡.</div></div>
      <div class="section"><h3>⌨️ Digitação simulada (mensagens)</h3>
        <div class="row3"><div><label>Velocidade (caracteres/s)</label><input type="number" id="sCps" min="1" value="${s.typingCps}"></div>
        <div><label>Mínimo (s)</label><input type="number" id="sTmin" min="0" step="0.5" value="${s.typingMin}"></div>
        <div><label>Máximo (s)</label><input type="number" id="sTmax" min="1" value="${s.typingMax}"></div></div></div>
      <div class="section"><h3>🎙️ Gravação simulada (áudios)</h3>
        <div class="row2"><div><label>"Gravando" = duração do áudio ×</label><input type="number" id="sRf" min="0.1" step="0.1" value="${s.recordingFactor}"></div>
        <div><label>Máximo gravando (s)</label><input type="number" id="sRmax" min="2" value="${s.recordingMax}"></div></div>
        <div class="hint">Ex: fator 1 e áudio de 20s → aparece "gravando áudio…" por 20s antes de enviar.</div></div>
      <div class="section"><h3>🚫 Descadastro (remarketing)</h3>
        <label>Se o lead mandar uma destas (separe por vírgula), ele sai de todos os remarketings e não entra mais</label>
        <input type="text" id="sOpt" value="${esc(s.optOutWords || '')}">
        <div class="hint">${Object.keys(DB.rmktBlock || {}).length} contato(s) descadastrado(s). <a href="#" id="clrBlock">Liberar todos</a></div></div>
      <div class="section"><h3>🔀 Variações de mensagem</h3>
        <p class="hint">Escreva <b>{oi}</b> numa mensagem e, a cada envio, sai uma das opções abaixo (ex.: "Opa", "Olá"…). Com a primeira letra maiúscula, <b>{Oi}</b>, a opção sai com letra maiúscula. Deixa as mensagens diferentes umas das outras.</p>
        <div id="varList"></div>
        <button class="btn sec" id="varAdd" type="button">+ Nova variação</button></div>
      <div class="section"><h3>🧰 Painel</h3>
        <div class="row2"><div><label>Tempo para desfazer exclusão (segundos)</label><input type="number" id="sUndo" min="0" max="60" value="${undoSecs()}"><div class="hint">Depois de excluir aparece "↶ Desfazer". 0 = volta a pedir confirmação antes de excluir.</div></div>
        <div><label>Relatório guarda (dias)</label><input type="number" id="sStatsDays" min="7" max="730" value="${s.statsDays || 120}"></div></div></div>
      <button class="btn" id="saveSet">Salvar configurações</button>
      <div class="section" style="margin-top:16px"><h3>💾 Backup</h3>
        <p class="hint">Exporta tudo (mensagens, áudios, mídias, funis, remarketing, gatilhos, agendamentos, campanhas e relatório) num arquivo .json. Use para levar para outro computador.</p>
        <div class="bar"><button class="btn sec" id="exp">Exportar backup</button>
        <label class="btn sec" style="margin:0">Importar backup<input type="file" id="imp" accept=".json" hidden></label></div>
        <h3 style="margin-top:18px">🔄 Backup automático</h3>
        <p class="hint">Salva sozinho em <b>Downloads/ZapFunil-backups</b> (com o Chrome aberto). Apaga os mais antigos e mantém só os últimos que você escolher.</p>
        <label class="inline"><input type="checkbox" id="abOn" ${ab.enabled ? 'checked' : ''}> Ligado</label>
        <div class="row3"><div><label>A cada</label><select id="abEvery">${[[1, 'todo dia'], [3, '3 dias'], [7, 'semana'], [14, '2 semanas'], [30, 'mês']].map(([v, t]) => `<option value="${v}" ${Number(ab.everyDays) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div><label>Manter os últimos</label><input type="number" id="abKeep" min="1" max="30" value="${ab.keep}"></div>
        <div><label>Mídias</label><select id="abMedia"><option value="1" ${ab.includeMedia ? 'selected' : ''}>com áudios/vídeos/imagens</option><option value="0" ${ab.includeMedia ? '' : 'selected'}>sem mídias (arquivo leve)</option></select></div></div>
        <div class="bar" style="margin-top:10px"><button class="btn sec" id="abNow">Fazer backup agora</button><span class="hint" id="abInfo"></span></div></div>
      <div class="section"><h3>ℹ️ Como usar</h3><div class="hint" style="font-size:13px;line-height:1.6">
        1. Crie mensagens, áudios, mídias e documentos.<br>2. Monte funis juntando os itens com intervalos.<br>
        3. No WhatsApp Web, clique no botão ⚡ (canto inferior direito), abra uma conversa e clique no item/funil.<br>
        4. Atalho rápido: na caixa de mensagem digite <b>/atalho</b> e aperte <b>Tab</b>.<br>
        5. Gatilhos, agendamentos e campanhas rodam sozinhos enquanto o WhatsApp Web estiver aberto.<br>
        Variáveis: {nome} {primeiro_nome} {Saudacao} {saudacao} {data} {hora}, suas variações 🔀 ({oi}, {show}…) e texto aleatório direto na mensagem {opção1|opção2}.</div></div>`;
    // ----- variações
    let vars = JSON.parse(JSON.stringify(s.variations || []));
    const drawVars = () => {
      $('#varList').innerHTML = vars.map((v, i) => `<div class="row2 varrow" data-i="${i}" style="align-items:end;margin-bottom:10px">
          <div><label>Nome (use na mensagem)</label><input type="text" class="vk" value="${esc(v.key)}" placeholder="ex: oi"></div>
          <div><label>Opções (uma por linha)</label><textarea class="vo" style="min-height:64px">${esc((v.options || []).join('\n'))}</textarea></div>
          <div style="grid-column:1/-1;display:flex;gap:10px;align-items:center"><span class="hint vp">Exemplo: ${esc(ZF.applyVars('{' + v.key + '}', { name: 'Maria' }))}</span><button type="button" class="btn sec sm vdel" style="margin-left:auto">Apagar</button></div>
        </div>`).join('') || '<p class="hint">Nenhuma variação. Clique em "+ Nova variação".</p>';
      $$('#varList .vdel').forEach((b) => (b.onclick = () => { collectVars(); vars.splice(Number(b.closest('.varrow').dataset.i), 1); drawVars(); }));
    };
    const collectVars = () => {
      vars = $$('#varList .varrow').map((r) => ({
        key: $('.vk', r).value.trim().replace(/^\{|\}$/g, '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''),
        options: $('.vo', r).value.split(/\n|\s*;\s*/).map((x) => x.trim()).filter(Boolean)
      }));
    };
    drawVars();
    $('#varAdd').onclick = () => { collectVars(); vars.push({ key: '', options: [] }); drawVars(); const r = $$('#varList .varrow').pop(); if (r) $('.vk', r).focus(); };
    $('#saveSet').onclick = async () => {
      collectVars();
      const reserved = ['nome', 'primeiro_nome', 'saudacao', 'data', 'hora', 'numero'];
      const keys = vars.map((v) => v.key);
      const bad = vars.find((v) => !v.key || !v.options.length || reserved.includes(v.key) || keys.indexOf(v.key) !== keys.lastIndexOf(v.key));
      if (bad) return toast(!bad.key ? 'Dê um nome para cada variação' : !bad.options.length ? 'A variação {' + bad.key + '} está sem opções' : reserved.includes(bad.key) ? '{' + bad.key + '} já é uma variável do sistema, use outro nome' : 'Nome repetido: {' + bad.key + '}');
      DB.settings = Object.assign({}, DB.settings, {
        variations: vars,
        typingCps: Math.max(1, Number($('#sCps').value) || 18),
        typingMin: Math.max(0, Number($('#sTmin').value) || 0),
        typingMax: Math.max(1, Number($('#sTmax').value) || 9),
        recordingFactor: Math.max(0.1, Number($('#sRf').value) || 1),
        recordingMax: Math.max(2, Number($('#sRmax').value) || 30),
        optOutWords: $('#sOpt').value,
        undoSeconds: Math.max(0, Math.min(60, Math.round(Number($('#sUndo').value)) || 0)),
        statsDays: Math.max(7, Math.min(730, Math.round(Number($('#sStatsDays').value)) || 120)),
        confirmSend: $('#sConfirm').checked,
        suggestOnType: $('#sSuggest').checked
      });
      if (DB.settings.typingMin > DB.settings.typingMax) DB.settings.typingMin = DB.settings.typingMax;
      await persist('settings');
      ZF.setVariations(DB.settings.variations);
      drawVars();
      toast('Configurações salvas');
    };
    $('#togAuto').onclick = async () => {
      DB.settings = Object.assign({}, DB.settings, { automationsPaused: !DB.settings.automationsPaused });
      await persist('settings');
      renderSettings();
    };
    $('#clrBlock').onclick = async (e) => {
      e.preventDefault();
      if (!confirm('Liberar todos os contatos descadastrados? Eles voltam a poder entrar em remarketing.')) return;
      await ZF.save({ rmktBlock: {} });
      await reload();
      renderSettings();
    };
    // backup automático: salva na hora que você muda
    const abInfo = async () => {
      const d = await chrome.storage.local.get(['autoBackupInfo']);
      const i = d.autoBackupInfo || {};
      const el = $('#abInfo');
      if (!el) return;
      let t = i.at ? 'Último: ' + fmtDate(i.at) + (i.size ? ' · ' + (i.size / 1048576).toFixed(1) + ' MB' : '') : 'Nenhum backup automático ainda.';
      if (i.error && (!i.at || i.errorAt > i.at)) t += ' · ⚠️ último erro: ' + i.error;
      el.textContent = t;
    };
    abInfo();
    const abSave = async () => {
      DB.settings = Object.assign({}, DB.settings, { autoBackup: {
        enabled: $('#abOn').checked,
        everyDays: Number($('#abEvery').value) || 7,
        keep: Math.max(1, Math.min(30, Math.round(Number($('#abKeep').value)) || 4)),
        includeMedia: $('#abMedia').value === '1'
      } });
      await persist('settings');
      toast('Backup automático ' + (DB.settings.autoBackup.enabled ? 'ligado' : 'desligado'));
    };
    ['#abOn', '#abEvery', '#abKeep', '#abMedia'].forEach((k) => ($(k).onchange = abSave));
    $('#abNow').onclick = async () => {
      const b = $('#abNow');
      b.disabled = true;
      b.textContent = 'Salvando…';
      const r = await bgMsg({ type: 'backup:now' });
      b.disabled = false;
      b.textContent = 'Fazer backup agora';
      if (r && r.ok) toast('Backup salvo em Downloads/ZapFunil-backups ✅');
      else toast('Não consegui: ' + ((r && r.error) || 'erro'));
      abInfo();
    };
    $('#exp').onclick = async () => {
      const data = await chrome.storage.local.get(['items', 'funnels', 'triggers', 'schedules', 'campaigns', 'settings', 'remarketing', 'rmktBlock', 'stats', 'gLists', 'gPosts', 'gSchedules', 'gAuto']);
      data.items = await ZF.fullItems(data.items || []); // backup com as mídias dentro (formato de sempre)
      data.__zapfunil = 1;
      data.exportedAt = new Date().toISOString();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      a.download = 'zapfunil-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
    };
    $('#imp').onchange = async () => {
      const f = $('#imp').files[0];
      if (!f) return;
      let data;
      try {
        data = JSON.parse(await f.text());
      } catch (e) {
        return toast('Arquivo inválido');
      }
      if (!data.__zapfunil) return toast('Esse arquivo não é um backup do ZapFunil');
      const replace = confirm('OK = SUBSTITUIR tudo pelo backup\nCancelar = JUNTAR com o que já existe');
      const out = {};
      // backup "sem mídias": aproveita o áudio/vídeo/imagem que já existe aqui (mesmo id)
      if (Array.isArray(data.items)) data.items = data.items.map((x) => {
        if (!x.noMedia) return x;
        const mine = DB.items.find((y) => y.id === x.id);
        const c = Object.assign({}, x);
        delete c.noMedia;
        if (mine && mine.data) c.data = mine.data;
        else if (mine && mine.hasMedia) Object.assign(c, { hasMedia: true, mediaKb: mine.mediaKb });
        return c;
      }).filter((x) => x.type === 'text' || x.data || x.hasMedia);
      for (const k of ['items', 'funnels', 'triggers', 'schedules', 'campaigns', 'remarketing', 'gLists', 'gPosts', 'gSchedules']) {
        const inc = data[k] || [];
        if (replace) out[k] = inc;
        else {
          const ids = new Set(DB[k].map((x) => x.id));
          out[k] = DB[k].concat(inc.filter((x) => !ids.has(x.id)));
        }
      }
      if (data.gAuto && (replace || !Object.keys(DB.gAuto || {}).length)) out.gAuto = data.gAuto;
      // relatório: junta os dias (fica com o maior de cada dia)
      if (data.stats && typeof data.stats === 'object') {
        const st = replace ? {} : JSON.parse(JSON.stringify(DB.stats || {}));
        for (const [k, v] of Object.entries(data.stats)) if (!st[k] || (v && (v.ok || 0) > (st[k].ok || 0))) st[k] = v;
        out.stats = st;
      }
      // campanhas importadas nunca começam rodando
      out.campaigns = out.campaigns.map((c) => (c.status === 'running' ? Object.assign({}, c, { status: 'paused' }) : c));
      if (data.settings) out.settings = Object.assign({}, DB.settings, data.settings);
      out.rmktBlock = replace ? data.rmktBlock || {} : Object.assign({}, DB.rmktBlock, data.rmktBlock || {});
      await ZF.save(out);
      await reload();
      toast('Backup importado!');
      renderSettings();
    };
  }

  // ------------------------------------------------------------ início
  let liveT = null;
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    // só as chaves de dados; aplica o valor novo direto (antes recarregava tudo, inclusive todos os vídeos, a cada mudança)
    const keys = Object.keys(changes).filter((k) => ZF.KEYS.includes(k) && !pending[k]);
    if (!keys.length || !DB) return;
    for (const k of keys) {
      const v = changes[k].newValue;
      if (k === 'settings') {
        DB.settings = Object.assign({}, ZF.DEFAULT_SETTINGS, v || {});
        ZF.setVariations(DB.settings.variations);
      } else DB[k] = v || (ZF.OBJ_KEYS.includes(k) ? {} : []);
    }
    // atualiza telas "ao vivo" sem atrapalhar quem está editando
    if ($('#modal').classList.contains('hidden') && ['campaigns', 'schedules', 'history', 'remarketing', 'report', 'groups'].includes(view) && keys.some((k) => ['campaigns', 'schedules', 'history', 'rmktQueue', 'stats', 'gSchedules'].includes(k))) {
      clearTimeout(liveT);
      liveT = setTimeout(render, view === 'report' ? 1500 : 0);
    }
  });

  (async () => {
    await reload();
    let [v, f] = (location.hash.slice(1) || 'items:text').split(':');
    if (v === 'search') v = 'items';
    setView(v || 'items', f || 'text');
    window.addEventListener('hashchange', () => {
      const [v2, f2] = (location.hash.slice(1) || 'items:text').split(':');
      const cur = view + (view === 'items' ? ':' + filter : '');
      if (location.hash.slice(1) !== cur) setView(v2 || 'items', f2 || filter);
    });
    // campanhas: atualiza contador "próximo às" a cada 5s
    setInterval(() => {
      if (view === 'campaigns' && $('#modal').classList.contains('hidden')) render();
    }, 5000);
  })();
})();
