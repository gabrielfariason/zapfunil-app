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
  async function persist(key) {
    await ZF.save({ [key]: DB[key] });
  }
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
  const VAR_BTNS = `<div class="vars">
    <button type="button" data-ins="{nome}">{nome}</button>
    <button type="button" data-ins="{primeiro_nome}">{primeiro_nome}</button>
    <button type="button" data-ins="{Saudacao}">{Saudacao}</button>
    <button type="button" data-ins="{saudacao}">{saudacao}</button>
    <button type="button" data-ins="{data}">{data}</button>
    <button type="button" data-ins="{hora}">{hora}</button>
    <button type="button" data-ins="{Oi|Olá|E aí}">{Oi|Olá|E aí} (aleatório)</button>
  </div>`;
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
    const fn = { mobile: renderMobile, items: renderItems, funnels: renderFunnels, remarketing: renderRemarketing, triggers: renderTriggers, schedules: renderSchedules, campaigns: renderCampaigns, history: renderHistory, settings: renderSettings }[view];
    fn();
  }

  // Move um registro para cima/baixo dentro do grupo visível (respeita a ordem do array)
  async function moveIn(key, id, dir, sameGroup) {
    const arr = DB[key];
    const i = arr.findIndex((x) => x.id === id);
    if (i < 0) return;
    let j = i + dir;
    while (j >= 0 && j < arr.length && !sameGroup(arr[j])) j += dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    await persist(key);
  }

  // ------------------------------------------------------------ ITENS
  const FILTER_INFO = {
    text: { title: 'Mensagens', sub: 'Textos prontos com variáveis. Envie com 1 clique ou digitando /atalho + Tab no WhatsApp.', types: ['text'], newType: 'text' },
    audio: { title: 'Áudios', sub: 'Áudios enviados como se fossem gravados na hora (com "gravando áudio…" antes).', types: ['audio'], newType: 'audio' },
    media: { title: 'Mídias', sub: 'Imagens e vídeos com legenda.', types: ['image', 'video'], newType: 'image' },
    document: { title: 'Documentos', sub: 'PDFs, planilhas e qualquer arquivo.', types: ['document'], newType: 'document' }
  };

  function renderItems() {
    const info = FILTER_INFO[filter];
    const items = DB.items.filter((i) => info.types.includes(i.type));
    let h = `<h1>${info.title}</h1><p class="sub">${info.sub} A ordem aqui (↑↓) é a ordem no painel ⚡ do WhatsApp.</p>
      <div class="bar"><input type="search" id="q" placeholder="Buscar…" style="max-width:320px"><span class="grow"></span>
      <button class="btn" id="newItem">+ Novo</button></div>`;
    if (!items.length) h += `<div class="empty">Nada aqui ainda. Clique em <b>+ Novo</b>.</div>`;
    else {
      h += '<div class="grid" id="grid">';
      items.forEach((i) => {
        let preview = '';
        if (i.type === 'text') preview = `<div class="body">${esc(i.text)}</div>`;
        else if (i.type === 'audio') preview = `<audio controls preload="none" src="${i.data}"></audio>`;
        else if (i.type === 'image') preview = `<img src="${i.data}">` + (i.caption ? `<div class="body">${esc(i.caption)}</div>` : '');
        else if (i.type === 'video') preview = `<video src="${i.data}" controls preload="metadata"></video>` + (i.caption ? `<div class="body">${esc(i.caption)}</div>` : '');
        else preview = `<div class="body">📎 ${esc(i.filename || 'arquivo')}</div>` + (i.caption ? `<div class="body">${esc(i.caption)}</div>` : '');
        const meta = [ZF.typeLabel(i.type)];
        if (i.type === 'audio') meta.push(ZF.fmtDuration(i.duration));
        if (i.data) meta.push(dataUrlSizeKb(i.data) + ' KB');
        h += `<div class="card" data-search="${esc(ZF.normalizeText([i.name, i.text, i.caption, i.shortcut].join(' ')))}">
          <h3>${ZF.typeIcon(i.type)} ${esc(i.name)} ${i.shortcut ? `<span class="tag">/${esc(i.shortcut)}</span>` : ''}</h3>
          <div class="meta">${meta.join(' · ')}</div>${preview}
          <div class="actions"><button class="btn sm sec" data-up="${i.id}" title="Mover para cima">↑</button><button class="btn sm sec" data-down="${i.id}" title="Mover para baixo">↓</button>
          <button class="btn sm sec" data-edit="${i.id}">Editar</button>
          <button class="btn sm sec" data-dup="${i.id}">Duplicar</button>
          <button class="btn sm red" data-del="${i.id}">Excluir</button></div></div>`;
      });
      h += '</div>';
    }
    $('#main').innerHTML = h;
    $('#newItem').onclick = () => editItem(null, info.newType);
    const q = $('#q');
    if (q) q.oninput = () => {
      const v = ZF.normalizeText(q.value);
      $$('#grid .card').forEach((c) => (c.style.display = c.dataset.search.includes(v) ? '' : 'none'));
    };
    $$('[data-edit]').forEach((b) => (b.onclick = () => editItem(DB.items.find((i) => i.id === b.dataset.edit))));
    const inGroup = (x) => info.types.includes(x.type);
    $$('[data-up]').forEach((b) => (b.onclick = async () => { await moveIn('items', b.dataset.up, -1, inGroup); renderItems(); }));
    $$('[data-down]').forEach((b) => (b.onclick = async () => { await moveIn('items', b.dataset.down, 1, inGroup); renderItems(); }));
    $$('[data-dup]').forEach((b) => (b.onclick = async () => {
      const src = DB.items.find((i) => i.id === b.dataset.dup);
      DB.items.push(Object.assign({}, src, { id: ZF.uid(), name: src.name + ' (cópia)', shortcut: '' }));
      await persist('items');
      renderItems();
    }));
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const it = DB.items.find((i) => i.id === b.dataset.del);
      const used = DB.funnels.filter((f) => f.steps.some((s) => s.itemId === it.id)).map((f) => f.name);
      if (!confirm('Excluir "' + it.name + '"?' + (used.length ? '\n\nEle é usado nos funis: ' + used.join(', ') + ' (essas etapas serão puladas).' : ''))) return;
      DB.items = DB.items.filter((i) => i.id !== it.id);
      await persist('items');
      renderItems();
    }));
  }

  function editItem(item, newType) {
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
      <div id="fBody"></div>
      <div class="modal-foot"><button class="btn sec" id="cancel">Cancelar</button><button class="btn" id="saveItem">Salvar</button></div>`);
    if (isNew) $('#fType').value = item.type;
    let pending = item.data ? { data: item.data, mime: item.mime, duration: item.duration, filename: item.filename } : null;

    const body = () => {
      const t = item.type;
      let h = '';
      if (t === 'text') {
        h = `<label>Mensagem</label><textarea id="fText" placeholder="{Saudacao}, {primeiro_nome}! Tudo bem?">${esc(item.text || '')}</textarea>${VAR_BTNS}
          <div class="hint">Formatação do WhatsApp funciona: *negrito*, _itálico_, ~riscado~.</div>`;
      } else {
        const accept = { audio: 'audio/*,.ogg,.opus,.mp3,.m4a,.wav', image: 'image/*', video: 'video/*', document: '*/*' }[t];
        h = `<label>Arquivo</label><input type="file" id="fFile" accept="${accept}">
          <div id="fPrev" class="hint">${pending ? 'Arquivo atual: ' + esc(pending.filename || ZF.typeLabel(t)) + ' (' + dataUrlSizeKb(pending.data) + ' KB)' : 'Nenhum arquivo.'}</div>`;
        if (t === 'audio') {
          h += `<div class="rec" id="recBox"><button class="btn sec" id="recBtn" type="button">🎙️ Gravar agora</button><span id="recInfo" class="hint"></span></div>
            <label class="inline"><input type="checkbox" id="fAsFile" ${item.asFile ? 'checked' : ''}> Enviar como arquivo de música (não como áudio de voz)</label>`;
        } else {
          h += `<label>Legenda (opcional)</label><textarea id="fCaption" style="min-height:70px">${esc(item.caption || '')}</textarea>${VAR_BTNS}`;
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
      if (!item.name) return toast('Dê um nome ao item');
      if (item.shortcut) {
        const dupe = DB.items.concat(DB.funnels).find((x) => x.id !== item.id && x.shortcut && ZF.normalizeText(x.shortcut) === ZF.normalizeText(item.shortcut));
        if (dupe) return toast('Atalho já usado em "' + dupe.name + '"');
      }
      if (item.type === 'text') {
        item.text = $('#fText').value;
        if (!item.text.trim()) return toast('Escreva a mensagem');
        delete item.data;
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
        return toast('Erro ao salvar: ' + e.message);
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
      total += Number(st.delay) || 0;
      const it = DB.items.find((i) => i.id === st.itemId);
      if (!it || st.simulate === false) return;
      if (it.type === 'text') total += Math.min(s.typingMax, Math.max(s.typingMin, (it.text || '').length / s.typingCps));
      else if (it.type === 'audio') total += Math.min(s.recordingMax, Math.max(2, (it.duration || 5) * s.recordingFactor));
      else total += 1.5;
    });
    return total;
  }
  function renderFunnels() {
    let h = `<h1>Funis</h1><p class="sub">Sequências de mensagens, áudios e mídias com intervalos, digitação/gravação simulada e espera pela resposta do lead. No painel ⚡ os funis aparecem primeiro, nesta ordem (↑↓).</p>
      <div class="bar"><span class="grow"></span><button class="btn" id="newF">+ Novo funil</button></div>`;
    if (!DB.funnels.length) h += `<div class="empty">Nenhum funil ainda.</div>`;
    else {
      h += '<div class="grid">';
      DB.funnels.forEach((f) => {
        const steps = f.steps.map((s, i) => {
          if (s.kind === 'wait_reply') return `${i + 1}. ⏳ Aguardar resposta`;
          const it = DB.items.find((x) => x.id === s.itemId);
          return `${i + 1}. ${s.delay ? '⏱ ' + fmtDelay(s.delay) + ' → ' : ''}${it ? ZF.typeIcon(it.type) + ' ' + esc(it.name) : '<i>(item apagado)</i>'}`;
        });
        h += `<div class="card"><h3>🔁 ${esc(f.name)} ${f.shortcut ? `<span class="tag">/${esc(f.shortcut)}</span>` : ''}</h3>
          <div class="meta">${f.steps.length} etapa(s) · ~${fmtTotal(funnelTime(f))} do início ao fim</div>
          <div class="body">${steps.join('<br>')}</div>
          <div class="actions"><button class="btn sm sec" data-up="${f.id}" title="Mover para cima">↑</button><button class="btn sm sec" data-down="${f.id}" title="Mover para baixo">↓</button>
          <button class="btn sm sec" data-edit="${f.id}">Editar</button>
          <button class="btn sm sec" data-dup="${f.id}">Duplicar</button>
          <button class="btn sm red" data-del="${f.id}">Excluir</button></div></div>`;
      });
      h += '</div>';
    }
    $('#main').innerHTML = h;
    $('#newF').onclick = () => editFunnel(null);
    $$('[data-edit]').forEach((b) => (b.onclick = () => editFunnel(DB.funnels.find((f) => f.id === b.dataset.edit))));
    $$('[data-up]').forEach((b) => (b.onclick = async () => { await moveIn('funnels', b.dataset.up, -1, () => true); renderFunnels(); }));
    $$('[data-down]').forEach((b) => (b.onclick = async () => { await moveIn('funnels', b.dataset.down, 1, () => true); renderFunnels(); }));
    $$('[data-dup]').forEach((b) => (b.onclick = async () => {
      const f = DB.funnels.find((x) => x.id === b.dataset.dup);
      DB.funnels.push(JSON.parse(JSON.stringify(Object.assign({}, f, { id: ZF.uid(), name: f.name + ' (cópia)', shortcut: '' }))));
      await persist('funnels');
      renderFunnels();
    }));
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const f = DB.funnels.find((x) => x.id === b.dataset.del);
      if (!confirm('Excluir o funil "' + f.name + '"?')) return;
      DB.funnels = DB.funnels.filter((x) => x.id !== f.id);
      await persist('funnels');
      renderFunnels();
    }));
  }

  function editFunnel(f) {
    const isNew = !f;
    f = f ? JSON.parse(JSON.stringify(f)) : { id: ZF.uid(), name: '', shortcut: '', steps: [] };
    if (!DB.items.length) return toast('Crie primeiro mensagens/áudios/mídias para montar o funil');
    openModal(`<h2>${isNew ? 'Novo funil' : 'Editar funil'}</h2>
      <div class="row2"><div><label>Nome</label><input type="text" id="fName" value="${esc(f.name)}" placeholder="Ex: Funil de boas-vindas"></div>
      <div><label>Atalho (opcional)</label><input type="text" id="fShort" value="${esc(f.shortcut || '')}"></div></div>
      <label>Etapas</label><div id="steps"></div>
      <div class="bar"><button class="btn sec sm" id="addStep">+ Adicionar envio</button><button class="btn sec sm" id="addWait">+ Aguardar resposta do lead</button></div>
      <div class="hint">"Esperar" = quanto tempo esperar antes de mandar essa etapa (em segundos, minutos ou horas). A digitação/gravação simulada acontece depois da espera.</div>
      <div class="modal-foot"><button class="btn sec" id="cancel">Cancelar</button><button class="btn" id="saveF">Salvar</button></div>`);
    const itemOpts = (sel) => DB.items.map((i) => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${ZF.typeIcon(i.type)} ${esc(i.name)}</option>`).join('');
    const collect = () => {
      $$('#steps .step').forEach((row, i) => {
        const st = f.steps[i];
        if (st.kind === 'wait_reply') {
          st.timeoutMin = Number($('.tmo', row).value) || 0;
          st.onTimeout = $('.ont', row).value;
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
        if (st.kind === 'wait_reply') {
          row.innerHTML = `<span class="num">${i + 1}</span> ⏳ Aguardar resposta por até <input type="number" class="tmo" min="0" value="${st.timeoutMin || 0}"> min (0 = sem limite). Se não responder:
            <select class="ont" style="flex:0;min-width:120px"><option value="continue" ${st.onTimeout !== 'stop' ? 'selected' : ''}>continuar</option><option value="stop" ${st.onTimeout === 'stop' ? 'selected' : ''}>parar funil</option></select>`;
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
        $('#steps').appendChild(row);
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
      f.steps.push({ kind: 'wait_reply', timeoutMin: 0, onTimeout: 'continue' });
      draw();
    };
    $('#cancel').onclick = closeModal;
    $('#saveF').onclick = async () => {
      collect();
      f.name = $('#fName').value.trim();
      f.shortcut = $('#fShort').value.trim().replace(/^\//, '').replace(/\s+/g, '');
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
        if (e.status === 'waiting') next = e.dueAt ? fmtDate(e.dueAt) : (e.mode === 'inactive' ? 'esperando você responder o lead' : '-');
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
      if (!confirm('Excluir a regra "' + r.name + '"?' + (n ? '\n\n' + n + ' contato(s) na fila dela serão cancelados.' : ''))) return;
      DB.remarketing = DB.remarketing.filter((x) => x.id !== r.id);
      await persist('remarketing');
      await updateQueue((qq) => qq.map((e) => (e.ruleId === r.id && (e.status === 'waiting' || e.status === 'sending') ? Object.assign({}, e, { status: 'cancelled', reason: 'regra apagada', endedAt: Date.now() }) : e)));
      renderRemarketing();
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
      $('#rStageHint').textContent = m === 'inactive'
        ? 'Cada tempo conta a partir da sua última mensagem sem resposta.'
        : 'Etapa 1: tempo depois do funil. Demais etapas: tempo depois da etapa anterior. Só envia se o lead não respondeu.';
    };
    $('#rMode').onchange = syncMode;
    syncMode();
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
        row.innerHTML = `<span class="num">${i + 1}</span> Sem resposta por <input type="number" class="dl" min="0" step="any" value="${+((st.delay || 0) / UNIT[u]).toFixed(2)}">
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
    $('#rAdd').onclick = () => { collect(); r.stages.push({ delay: 86400, delayUnit: 'd', targetType: '', targetId: '' }); draw(); };
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
      const zero = r.stages.findIndex((x) => x.delay < 60);
      if (zero >= 0) return toast('Etapa ' + (zero + 1) + ': use pelo menos 1 minuto de espera');
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
        n.dueAt = r.mode === 'inactive' && !e.lastFromMe ? null : e.baseAt + st.delay * 1000;
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
      if (!confirm('Excluir gatilho?')) return;
      DB.triggers = DB.triggers.filter((t) => t.id !== b.dataset.del);
      await persist('triggers');
      renderTriggers();
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
        h += `<tr><td>${fmtDate(s.at)}</td><td>${esc(s.numbers.slice(0, 3).join(', '))}${s.numbers.length > 3 ? ' +' + (s.numbers.length - 3) : ''}</td>
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
      if (!confirm('Excluir agendamento?')) return;
      DB.schedules = DB.schedules.filter((s) => s.id !== b.dataset.del);
      await persist('schedules');
      renderSchedules();
    }));
  }
  function editSchedule(s) {
    if (!DB.items.length && !DB.funnels.length) return toast('Crie um item ou funil primeiro');
    const isNew = !s;
    s = s ? Object.assign({}, s) : { id: ZF.uid(), numbers: [], at: Date.now() + 3600000, repeat: 'none', targetType: 'funnel', targetId: '', status: 'pending', useName: '' };
    openModal(`<h2>${isNew ? 'Novo agendamento' : 'Editar agendamento'}</h2>
      <label>Números (um por linha, com DDD)</label><textarea id="sNums" placeholder="11999998888">${esc(s.numbers.join('\n'))}</textarea>
      <div class="hint">Números brasileiros sem 55 recebem o 55 automaticamente.</div>
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
          <div class="meta">${esc(targetName(c.targetType, c.targetId))} · intervalo ${c.minDelay}–${c.maxDelay}s${c.pauseEvery ? ` · pausa ${c.pauseMinutes}min a cada ${c.pauseEvery}` : ''}</div>
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
      const rows = [['numero', 'nome', 'status', 'erro', 'horario']].concat((c.results || []).map((r) => [r.number, r.name, r.ok ? 'enviado' : 'falha', r.err || '', fmtDate(r.t)]));
      const csv = rows.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(';')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
      a.download = 'campanha-' + c.name.replace(/\W+/g, '-') + '.csv';
      a.click();
    }));
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Excluir campanha?')) return;
      DB.campaigns = DB.campaigns.filter((c) => c.id !== b.dataset.del);
      await persist('campaigns');
      renderCampaigns();
    }));
  }
  function editCampaign(c) {
    if (!DB.items.length && !DB.funnels.length) return toast('Crie um item ou funil primeiro');
    const isNew = !c;
    c = c ? Object.assign({}, c) : { id: ZF.uid(), name: '', contacts: [], targetType: 'funnel', targetId: '', minDelay: 40, maxDelay: 90, pauseEvery: 25, pauseMinutes: 10, status: 'draft', progress: 0, results: [] };
    openModal(`<h2>${isNew ? 'Nova campanha' : 'Editar campanha'}</h2>
      <label>Nome</label><input type="text" id="cName" value="${esc(c.name)}" placeholder="Ex: Remarketing Black Friday">
      <label>Contatos – um por linha: <code>numero,nome</code></label><textarea id="cList" style="min-height:150px" placeholder="11999998888,Maria\n21988887777,João">${esc(c.contacts.map((x) => x.number + (x.name ? ',' + x.name : '')).join('\n'))}</textarea>
      <div class="bar" style="margin-top:6px"><input type="file" id="cCsv" accept=".csv,.txt" style="max-width:260px"><span class="hint" id="cCount"></span></div>
      <div class="hint">Aceita CSV (número na 1ª coluna, nome na 2ª). Números repetidos são removidos.</div>
      <label>Enviar</label><select id="cTarget">${targetOptions(c.targetType, c.targetId)}</select>
      <div class="row2"><div><label>Intervalo mínimo entre contatos (s)</label><input type="number" id="cMin" min="5" value="${c.minDelay}"></div>
      <div><label>Intervalo máximo (s)</label><input type="number" id="cMax" min="5" value="${c.maxDelay}"></div></div>
      <div class="row2"><div><label>Pausa longa a cada X envios (0 = nunca)</label><input type="number" id="cPe" min="0" value="${c.pauseEvery}"></div>
      <div><label>Duração da pausa (min)</label><input type="number" id="cPm" min="1" value="${c.pauseMinutes}"></div></div>
      <div class="modal-foot"><button class="btn sec" id="cancel">Cancelar</button><button class="btn" id="saveC">Salvar</button></div>`);
    const count = () => {
      const seen = new Set();
      const n = parseNumbers($('#cList').value).filter((x) => !seen.has(x.number) && seen.add(x.number)).length;
      $('#cCount').textContent = n + ' contato(s) válido(s)';
    };
    count();
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
      c.name = $('#cName').value.trim() || 'Campanha ' + new Date().toLocaleDateString('pt-BR');
      const seen = new Set();
      const newContacts = parseNumbers($('#cList').value).filter((x) => !seen.has(x.number) && seen.add(x.number));
      if (!newContacts.length) return toast('Adicione contatos válidos');
      const changed = JSON.stringify(newContacts) !== JSON.stringify(c.contacts);
      c.contacts = newContacts;
      if (changed && c.progress > c.contacts.length) c.progress = c.contacts.length;
      Object.assign(c, parseTarget($('#cTarget').value));
      if (!c.targetId) return toast('Escolha o que enviar');
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
      <button class="btn" id="saveSet">Salvar configurações</button>
      <div class="section" style="margin-top:16px"><h3>💾 Backup</h3>
        <p class="hint">Exporta tudo (mensagens, áudios, mídias, funis, remarketing, gatilhos, agendamentos e campanhas) num arquivo .json. Use para levar para outro computador.</p>
        <div class="bar"><button class="btn sec" id="exp">Exportar backup</button>
        <label class="btn sec" style="margin:0">Importar backup<input type="file" id="imp" accept=".json" hidden></label></div></div>
      <div class="section"><h3>ℹ️ Como usar</h3><div class="hint" style="font-size:13px;line-height:1.6">
        1. Crie mensagens, áudios, mídias e documentos.<br>2. Monte funis juntando os itens com intervalos.<br>
        3. No WhatsApp Web, clique no botão ⚡ (canto inferior direito), abra uma conversa e clique no item/funil.<br>
        4. Atalho rápido: na caixa de mensagem digite <b>/atalho</b> e aperte <b>Tab</b>.<br>
        5. Gatilhos, agendamentos e campanhas rodam sozinhos enquanto o WhatsApp Web estiver aberto.<br>
        Variáveis: {nome} {primeiro_nome} {Saudacao} {saudacao} {data} {hora} e texto aleatório {opção1|opção2}.</div></div>`;
    $('#saveSet').onclick = async () => {
      DB.settings = Object.assign({}, DB.settings, {
        typingCps: Math.max(1, Number($('#sCps').value) || 18),
        typingMin: Math.max(0, Number($('#sTmin').value) || 0),
        typingMax: Math.max(1, Number($('#sTmax').value) || 9),
        recordingFactor: Math.max(0.1, Number($('#sRf').value) || 1),
        recordingMax: Math.max(2, Number($('#sRmax').value) || 30),
        optOutWords: $('#sOpt').value,
        confirmSend: $('#sConfirm').checked,
        suggestOnType: $('#sSuggest').checked
      });
      if (DB.settings.typingMin > DB.settings.typingMax) DB.settings.typingMin = DB.settings.typingMax;
      await persist('settings');
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
    $('#exp').onclick = async () => {
      const data = await chrome.storage.local.get(['items', 'funnels', 'triggers', 'schedules', 'campaigns', 'settings', 'remarketing', 'rmktBlock']);
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
      for (const k of ['items', 'funnels', 'triggers', 'schedules', 'campaigns', 'remarketing']) {
        const inc = data[k] || [];
        if (replace) out[k] = inc;
        else {
          const ids = new Set(DB[k].map((x) => x.id));
          out[k] = DB[k].concat(inc.filter((x) => !ids.has(x.id)));
        }
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
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    const keys = Object.keys(changes).filter((k) => k !== 'engineLock' && k !== 'panelOpen');
    if (!keys.length) return;
    await reload();
    // atualiza telas "ao vivo" sem atrapalhar quem está editando
    if ($('#modal').classList.contains('hidden') && ['campaigns', 'schedules', 'history', 'remarketing'].includes(view) && keys.some((k) => ['campaigns', 'schedules', 'history', 'rmktQueue'].includes(k))) render();
  });

  (async () => {
    await reload();
    const [v, f] = (location.hash.slice(1) || 'items:text').split(':');
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
