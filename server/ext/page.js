// Roda no contexto da página do WhatsApp Web (world: MAIN), onde o WPP (wa-js) está disponível.
// Faz a ponte entre o content script e o WhatsApp.
(function () {
  'use strict';
  const TAG = 'ZAPFUNIL';

  function post(payload) {
    window.postMessage(Object.assign({ __zf: TAG, dir: 'toContent' }, payload), '*');
  }

  function wid(id) {
    if (!id) return null;
    if (typeof id === 'string') return id;
    return id._serialized || (id.toString && id.toString()) || null;
  }

  function waitReady() {
    return new Promise((resolve) => {
      const check = () => {
        if (window.WPP && WPP.isFullReady) return resolve(true);
        setTimeout(check, 500);
      };
      check();
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // "data:audio/ogg; codecs=opus;base64,..." → "data:audio/ogg;base64,..."
  // (o WhatsApp recusa data URL com parâmetros/espaços: erro invalid_data_url)
  function cleanDataUrl(u) {
    if (typeof u !== 'string') return u;
    const m = /^data:([^,]*),/.exec(u);
    if (!m) return u;
    const parts = m[1].split(';').map((x) => x.trim()).filter(Boolean);
    const b64 = parts.some((x) => x.toLowerCase() === 'base64');
    const type = parts[0] && parts[0].includes('/') ? parts[0].toLowerCase() : 'application/octet-stream';
    return 'data:' + type + (b64 ? ';base64' : '') + u.slice(m[0].length - 1);
  }

  const LABEL = { image: '📷 Foto', video: '🎬 Vídeo', ptt: '🎤 Áudio', audio: '🎵 Áudio', document: '📄 Documento', sticker: '🌟 Figurinha', location: '📍 Localização', vcard: '👤 Contato', multi_vcard: '👤 Contatos', revoked: '🚫 Mensagem apagada', call_log: '📞 Chamada', ciphertext: '⏳ Aguardando mensagem', poll_creation: '📊 Enquete' };
  function labelOf(m) {
    const base = LABEL[m.type] || '• ' + (m.type || 'mensagem');
    const d = Math.round(m.duration || 0);
    const dur = (m.type === 'ptt' || m.type === 'audio' || m.type === 'video') && d ? ' ' + Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0') : '';
    return base + dur;
  }
  function preview(m) {
    if (!m) return '';
    if (m.type === 'chat') return String(m.body || '').slice(0, 120);
    return labelOf(m) + (m.caption ? ': ' + String(m.caption).slice(0, 80) : '');
  }
  function serializeMsg(m) {
    try {
      if (!m || !m.id) return null;
      const out = { id: wid(m.id), fromMe: !!m.id.fromMe, t: m.t || 0, type: m.type, ack: m.ack || 0 };
      if (m.type === 'chat') out.text = String(m.body || '').slice(0, 4000);
      else {
        out.text = m.caption ? String(m.caption).slice(0, 2000) : '';
        out.label = labelOf(m);
        if ((m.type === 'image' || m.type === 'video' || m.type === 'sticker') && typeof m.body === 'string' && /^\/9j\/|^iVBOR/.test(m.body) && m.body.length < 30000) {
          out.thumb = (m.body.startsWith('iVBOR') ? 'data:image/png;base64,' : 'data:image/jpeg;base64,') + m.body;
        }
        if (m.type === 'document') out.file = m.filename || m.caption || 'arquivo';
        if (m.duration) out.duration = Math.round(m.duration);
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  // "marcar todos" sem @ no texto: a menção vai escondida, todo mundo é notificado
  const memberCache = new Map();
  async function mentionList(chatId, opts) {
    if (opts && Array.isArray(opts.mentionIds) && opts.mentionIds.length && /@g\.us$/.test(chatId) && !opts.mentionAll) return opts.mentionIds.map(String);
    if (!opts || !opts.mentionAll || !/@g\.us$/.test(chatId)) return null;
    const c = memberCache.get(chatId);
    if (c && Date.now() - c.at < 10 * 60000) return c.ids;
    let me = '';
    try { me = wid(WPP.conn.getMyUserId()); } catch (e) {}
    const ps = await WPP.group.getParticipants(chatId);
    const ids = (ps || []).map((p) => wid(p.id)).filter((x) => x && x !== me);
    memberCache.set(chatId, { at: Date.now(), ids });
    return ids;
  }

  async function resolveChatId(target) {
    // target pode ser "5511999999999", "5511999999999@c.us" ou id de grupo "...@g.us"
    if (!target) throw new Error('Contato vazio');
    if (/@(c\.us|g\.us|lid|newsletter)$/.test(target)) return target;
    const digits = String(target).replace(/\D/g, '');
    if (digits.length < 8) throw new Error('Número inválido: ' + target);
    const res = await WPP.contact.queryExists(digits + '@c.us');
    if (!res || !res.wid) throw new Error('Número não tem WhatsApp: ' + digits);
    return wid(res.wid);
  }

  // Fotos de perfil: cache de 12h, buscadas aos poucos (no máximo 3 de cada vez)
  const pics = new Map(); // id -> { url, at }
  let picBusy = false;
  async function fillPics(ids) {
    if (picBusy) return;
    picBusy = true;
    try {
      const todo = ids.filter((id) => { const c = pics.get(id); return !c || Date.now() - c.at > 12 * 3600000; }).slice(0, 40);
      for (let i = 0; i < todo.length; i += 3) {
        await Promise.all(todo.slice(i, i + 3).map(async (id) => {
          let url = null;
          try { url = (await WPP.contact.getProfilePictureUrl(id)) || null; } catch (e) {}
          pics.set(id, { url, at: Date.now() });
        }));
      }
    } finally {
      picBusy = false;
    }
  }

  function contactName(chatId) {
    try {
      const c = WPP.whatsapp.ContactStore && WPP.whatsapp.ContactStore.get(chatId);
      if (c) return c.name || c.pushname || c.verifiedName || c.formattedName || '';
    } catch (e) {}
    try {
      const chat = WPP.chat.get(chatId);
      if (chat) return chat.formattedTitle || chat.name || '';
    } catch (e) {}
    return '';
  }

  const methods = {
    async ready() {
      await waitReady();
      return true;
    },
    // Conectar este WhatsApp Web pelo número (código de 8 letras, sem QR Code)
    async linkCode(phone) {
      const t0 = Date.now();
      while (!(window.WPP && WPP.isReady && WPP.conn && WPP.conn.genLinkDeviceCodeForPhoneNumber)) {
        if (Date.now() - t0 > 30000) throw new Error('WhatsApp ainda carregando, tente de novo');
        await sleep(500);
      }
      if (WPP.isFullReady) throw new Error('Este WhatsApp já está conectado');
      const num = String(phone || '').replace(/\D/g, '');
      if (num.length < 10) throw new Error('Número inválido');
      return await WPP.conn.genLinkDeviceCodeForPhoneNumber(num, true);
    },
    async status() {
      return { ready: !!(window.WPP && WPP.isFullReady), version: window.WPP ? WPP.version : null };
    },
    async activeChat() {
      const chat = WPP.chat.getActiveChat();
      if (!chat) return null;
      const id = wid(chat.id);
      return { id, name: contactName(id), isGroup: /@g\.us$/.test(id) };
    },
    async resolve(target) {
      const id = await resolveChatId(target);
      return { id, name: contactName(id) };
    },
    async contactName(chatId) {
      return contactName(chatId);
    },
    async openChat(chatId) {
      await WPP.chat.openChatBottom(chatId);
      return true;
    },
    async typing(chatId, ms) {
      await WPP.chat.markIsComposing(chatId, ms);
      return true;
    },
    async recording(chatId, ms) {
      await WPP.chat.markIsRecording(chatId, ms);
      return true;
    },
    async paused(chatId) {
      try { await WPP.chat.markIsPaused(chatId); } catch (e) {}
      return true;
    },
    async sendText(chatId, text, opts) {
      const o = { createChat: true, linkPreview: true };
      const ml = await mentionList(chatId, opts);
      if (ml) o.mentionedList = ml;
      const r = await WPP.chat.sendTextMessage(chatId, text, o);
      return { id: wid(r && r.id) };
    },
    async sendFile(chatId, dataUrl, opts) {
      const o = Object.assign({ createChat: true }, opts || {});
      const ml = await mentionList(chatId, o);
      delete o.mentionAll;
      delete o.mentionIds;
      if (ml) o.mentionedList = ml;
      if (o.type === 'audio' && o.isPtt) o.waveform = true;
      const r = await WPP.chat.sendFileMessage(chatId, cleanDataUrl(dataUrl), o);
      return { id: wid(r && r.id) };
    },
    // grupos em que você está (para agendar/disparar)
    async listGroups() {
      const chats = await WPP.chat.list({ onlyGroups: true });
      return chats.slice(0, 1000).map((c) => {
        let size = 0;
        try { size = (c.groupMetadata && c.groupMetadata.participants && (c.groupMetadata.participants.length || c.groupMetadata.participants.getModelsArray().length)) || 0; } catch (e) {}
        let ro = false;
        try { ro = !!(c.groupMetadata && c.groupMetadata.announce && !c.groupMetadata.participants.iAmAdmin()); } catch (e) {}
        return { id: wid(c.id), name: c.formattedTitle || c.name || (c.groupMetadata && c.groupMetadata.subject) || '', size, onlyAdmins: ro };
      }).filter((g) => /@g\.us$/.test(g.id));
    },
    // membros de um grupo com número (para disparo no privado). Quem o WhatsApp esconde o número fica de fora.
    async groupMembers(groupId) {
      const ps = (await WPP.group.getParticipants(groupId)) || [];
      let me = '';
      try { me = wid(WPP.conn.getMyUserId()).replace(/@.*/, ''); } catch (e) {}
      const out = [];
      let hidden = 0;
      for (const p of ps) {
        const id = wid(p.id);
        let num = /@c\.us$/.test(id) ? id.replace(/@.*/, '') : '';
        if (!num) {
          try { if (p.phoneNumber) num = wid(p.phoneNumber).replace(/@.*/, ''); } catch (e) {}
        }
        if (!num) {
          try { const e = await WPP.contact.getPnLidEntry(id); if (e && e.phoneNumber && e.phoneNumber.id) num = String(e.phoneNumber.id); } catch (e) {}
        }
        if (me && (num === me || id.replace(/@.*/, '') === me)) continue;
        if (!num) { hidden++; continue; }
        out.push({ number: num, name: contactName(num + '@c.us') || contactName(id) || '', admin: !!(p.isAdmin || p.isSuperAdmin) });
      }
      return { members: out, hidden };
    },
    async listChats() {
      const chats = await WPP.chat.list({ onlyUsers: true });
      return chats.slice(0, 2000).map((c) => {
        const id = wid(c.id);
        return { id, name: contactName(id) };
      });
    },
    async recentChats(n) {
      const chats = await WPP.chat.list({ onlyUsers: true, count: n || 60 });
      return chats.map((c) => {
        const id = wid(c.id);
        let last = null;
        try {
          last = c.msgs && c.msgs.last ? c.msgs.last() : null;
        } catch (e) {}
        const pc = pics.get(id);
        return {
          id,
          name: contactName(id) || c.formattedTitle || '',
          pic: pc && pc.url ? pc.url : null,
          t: c.t || 0,
          unread: c.unreadCount || 0,
          last: last ? { fromMe: !!(last.id && last.id.fromMe), text: preview(last), ack: last.ack || 0 } : null
        };
      });
    },
    async loadPics(ids) {
      fillPics(ids || []).catch(() => {});
      return true;
    },
    // Mensagem da tela (data-id) -> conteúdo para salvar no ZapFunil (baixa a mídia)
    async msgForSave(key) {
      const chat = WPP.chat.getActiveChat();
      if (!chat) throw new Error('Abra a conversa primeiro');
      let arr = [];
      try {
        arr = chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : chat.msgs._models || [];
      } catch (e) {}
      let m = arr.find((x) => x.id && (x.id.id === key || wid(x.id) === key));
      if (!m) {
        const more = await WPP.chat.getMessages(wid(chat.id), { count: 400 });
        m = more.find((x) => x.id && (x.id.id === key || wid(x.id) === key));
      }
      if (!m) throw new Error('Não encontrei essa mensagem. Role a conversa até ela e tente de novo.');
      if (m.isViewOnce) throw new Error('Mensagem de visualização única não pode ser salva');
      const out = { type: m.type, fromMe: !!(m.id && m.id.fromMe), caption: m.caption || '', duration: Math.round(m.duration || 0), filename: m.filename || '' };
      if (m.type === 'chat') {
        out.text = String(m.body || '');
        return out;
      }
      if (!['ptt', 'audio', 'image', 'video', 'document', 'sticker'].includes(m.type)) throw new Error('Esse tipo de mensagem não dá para salvar (' + (LABEL[m.type] || m.type) + ')');
      let blob;
      try {
        blob = await WPP.chat.downloadMedia(wid(m.id));
      } catch (e) {
        throw new Error('Não consegui baixar a mídia (pode ter expirado no WhatsApp). Tente reenviar ou baixar e subir no painel.');
      }
      if (blob.size > 30 * 1024 * 1024) throw new Error('Arquivo grande demais (' + Math.round(blob.size / 1048576) + ' MB). Limite: 30 MB.');
      out.mime = m.mimetype || blob.type || '';
      out.size = blob.size;
      out.data = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(cleanDataUrl(fr.result));
        fr.onerror = () => rej(new Error('Falha ao ler a mídia'));
        fr.readAsDataURL(blob);
      });
      return out;
    },
    async unreadTotal() {
      const chats = await WPP.chat.list({ onlyUsers: true, onlyWithUnreadMessage: true });
      return chats.reduce((s, c) => s + (c.unreadCount > 0 ? c.unreadCount : c.unreadCount < 0 ? 1 : 0), 0);
    },
    async chatMessages(chatId, n) {
      const msgs = await WPP.chat.getMessages(chatId, { count: n || 40 });
      return msgs.map(serializeMsg).filter(Boolean);
    },
    async listLabels() {
      try {
        const labels = await WPP.labels.getAllLabels();
        return labels.map((l) => ({ id: l.id, name: l.name }));
      } catch (e) {
        return [];
      }
    },
    async chatsByLabel(labelId) {
      const chats = await WPP.chat.list({ withLabels: [labelId] });
      return chats.map((c) => {
        const id = wid(c.id);
        return { id, name: contactName(id) };
      });
    }
  };

  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.__zf !== TAG || d.dir !== 'toPage') return;
    const fn = methods[d.method];
    if (!fn) return post({ id: d.id, error: 'Método desconhecido: ' + d.method });
    try {
      if (d.method !== 'ready' && d.method !== 'status' && d.method !== 'linkCode') await waitReady();
      const result = await fn.apply(null, d.args || []);
      post({ id: d.id, result });
    } catch (e) {
      post({ id: d.id, error: (e && (e.message || e.code)) || String(e) });
    }
  });

  // Eventos de mensagens novas (para os gatilhos)
  waitReady().then(() => {
    post({ event: 'ready', data: { version: WPP.version } });
    WPP.on('conn.logout', () => post({ event: 'logout', data: {} }));
    WPP.on('chat.new_message', (msg) => {
      try {
        if (!msg || msg.isNewMsg === false) return;
        const fromMe = !!(msg.id && msg.id.fromMe);
        const chatId = wid(msg.id && msg.id.remote) || wid(msg.from);
        if (!chatId || chatId === 'status@broadcast') return;
        post({
          event: 'message',
          data: {
            chatId,
            fromMe,
            isGroup: /@g\.us$/.test(chatId),
            type: msg.type,
            body: typeof msg.body === 'string' && (msg.type === 'chat') ? msg.body : (msg.caption || ''),
            preview: preview(msg),
            name: contactName(chatId),
            author: /@g\.us$/.test(chatId) && !fromMe ? wid(msg.author) || '' : '',
            authorName: /@g\.us$/.test(chatId) && !fromMe && msg.author ? contactName(wid(msg.author)) || msg.notifyName || '' : '',
            t: msg.t
          }
        });
      } catch (e) {}
    });
    // alguém entrou num grupo (para a mensagem de boas-vindas)
    WPP.on('group.participant_changed', (e) => {
      try {
        if (!e || (e.action !== 'add' && e.action !== 'join')) return;
        const parts = (e.participants || []).map(String);
        post({ event: 'groupJoin', data: { groupId: String(e.groupId), action: e.action, participants: parts, names: parts.map((x) => contactName(x) || '') } });
      } catch (err) {}
    });
  });
})();
