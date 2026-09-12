/* ================= Ollama GUI — app ================= */
(() => {
  'use strict';

  // ---------------- helpers ----------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const nowISO = () => new Date().toISOString();
  const esc3 = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapeHtml = (s) => esc3(s).replace(/"/g, '&quot;');
  const timeAgo = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString();
  };
  const fmtBytes = (n) => {
    if (!n) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i > 1 ? 2 : 0) + ' ' + u[i];
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function toast(msg, type = '') {
    const t = el('div', 'toast ' + type, escapeHtml(msg));
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2600);
    setTimeout(() => t.remove(), 2950);
  }

  // ---------------- state ----------------
  const S = {
    conversations: [],
    conv: null,
    models: [],
    model: localStorage.getItem('gui_model') || '',
    memory: { notes: [], learned: [] },
    config: { ollamaBase: '', autoTitle: true, autoMemory: true },
    token: localStorage.getItem('gui_token') || '',
    theme: localStorage.getItem('gui_theme') || 'dark',
    mode: 'chat',
    routing: false,
    streaming: false,
    abort: null,
    editingIndex: -1,
    search: '',
    params: { temperature: 0.8, top_p: 0.9, top_k: 40, num_ctx: 4096, seed: null },
    stats: { start: 0, chars: 0, tokens: 0, model: '' },
    lastLearnAt: 0,
  };

  const DEFAULTS = { temperature: 0.8, top_p: 0.9, top_k: 40, num_ctx: 4096, seed: null };

  // ---------------- API ----------------
  class Api401 extends Error {}
  async function api(path, { method = 'GET', body } = {}) {
    const opt = { method, headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    if (S.token) opt.headers['Authorization'] = 'Bearer ' + S.token;
    const res = await fetch(path, opt);
    if (res.status === 401) throw new Api401('auth');
    if (!res.ok) {
      let e = 'Request failed (' + res.status + ')';
      try { const j = await res.json(); if (j && j.error) e = String(j.error).slice(0, 300); } catch {}
      throw new Error(e);
    }
    return res.json();
  }
  function fetchStream(path, body, signal) { // returns fetch with auth headers
    const opt = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    if (signal) opt.signal = signal;
    if (S.token) opt.headers['Authorization'] = 'Bearer ' + S.token;
    return fetch(path, opt);
  }

  // ---------------- markdown ----------------
  const PB = '\uE000', PE = '\uE001';
  const COMMENTS = {
    js: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', typescript: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/',
    go: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', rust: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/',
    c: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', cpp: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/',
    java: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', python: '#[^\\n]*', bash: '#[^\\n]*', sql: '--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', yaml: '#[^\\n]*'
  };
  const LANG_KEYWORDS = {
    js: 'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|this|null|undefined|true|false|delete|void|yield|static|super',
    typescript: 'interface|type|enum|namespace|declare|readonly|public|private|protected|abstract|implements|as|satisfies|keyof|typeof|extends|const|let|var|function|return|if|else|for|while|switch|case|new|class|import|export|from|default|async|await|try|catch|throw|this|null|undefined|true|false|static|super',
    python: 'def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|lambda|pass|yield|async|await|None|True|False|and|or|not|in|is|global|nonlocal|del|self|break|continue',
    go: 'func|package|import|return|if|else|for|range|switch|case|break|continue|defer|go|chan|struct|interface|map|type|var|const|select|default|goto',
    rust: 'fn|let|mut|pub|impl|trait|struct|enum|match|use|crate|mod|return|if|else|for|while|loop|break|continue|async|await|move|ref|type|where|unsafe|const|static|true|false',
    c: 'int|char|float|double|void|long|short|unsigned|signed|struct|union|enum|typedef|return|if|else|for|while|do|switch|case|break|continue|static|const|extern|sizeof|NULL|include|define',
    cpp: 'class|public|private|protected|virtual|template|typename|namespace|using|new|delete|this|override|final|auto|constexpr|int|char|float|double|void|long|short|unsigned|signed|struct|enum|typedef|return|if|else|for|while|do|switch|case|break|continue|static|const|extern|NULL',
    java: 'class|interface|public|private|protected|static|final|void|int|long|double|float|boolean|char|byte|short|new|return|if|else|for|while|do|switch|case|break|continue|throw|try|catch|finally|import|package|extends|implements|this|super|null|true|false|enum',
    bash: 'echo|if|then|else|elif|fi|for|while|do|done|function|return|local|export|read|cd|case|esac|exit|true|false|source|set|unset|shift',
    sql: 'SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|ORDER|BY|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|AS|AND|OR|NOT|NULL|PRIMARY|KEY|FOREIGN|INDEX|WITH|CASE|WHEN|THEN|ELSE|END|CAST|COALESCE|BEGIN|COMMIT|ROLLBACK',
    yaml: 'true|false|null|yes|no|on|off'
  };

  function highlight(lang, code) {
    const e = esc3(code);
    const parts = [];
    if (COMMENTS[lang]) parts.push('(?<c>' + COMMENTS[lang] + ')');
    parts.push('(?<s>"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\\\n])*`)');
    parts.push('(?<n>\\b\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b)');
    parts.push('(?<i>\\b[A-Za-z_$][\\w$]*\\b)');
    const rx = new RegExp(parts.join('|'), 'g');
    const kws = new Set((LANG_KEYWORDS[lang] || LANG_KEYWORDS.js).split('|'));
    let out = '', last = 0, m;
    while ((m = rx.exec(e))) {
      out += e.slice(last, m.index);
      const g = m.groups;
      if (g.c !== undefined) out += '<span class="c">' + g.c + '</span>';
      else if (g.s !== undefined) out += '<span class="s">' + g.s + '</span>';
      else if (g.n !== undefined) out += '<span class="n">' + g.n + '</span>';
      else if (g.i !== undefined) out += kws.has(g.i) ? '<span class="k">' + g.i + '</span>' : g.i;
      last = rx.lastIndex;
    }
    return out + e.slice(last);
  }

  let codeStore = [];
  function extractCodes(src) {
    src = src.replace(/```([\w.+#-]*)[^\n]*\n?([\s\S]*?)```/g, (m, lang, c) => {
      codeStore.push({ type: 'block', lang, code: c.replace(/\n$/, '') });
      return PB + 'B' + (codeStore.length - 1) + PE;
    });
    src = src.replace(/`([^`\n]+)`/g, (m, c) => {
      codeStore.push({ type: 'inline', code: c });
      return PB + 'I' + (codeStore.length - 1) + PE;
    });
    return src;
  }
  function inlineMd(t) {
    return t
      .replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  }
  function renderCodeBlock(lang, code) {
    const name = (lang || 'code').slice(0, 24);
    return '\n<div class="code-block"><div class="code-head"><span>' + escapeHtml(name) + '</span><button class="copy-btn" data-copy type="button">Copy</button></div><pre class="hl"><code>' + highlight(lang, code) + '</code></pre></div>\n';
  }
  function mdToHtml(src) {
    if (!src) return '';
    codeStore = [];
    let s = extractCodes(String(src));
    let esc = escapeHtml(s);
    esc = esc.replace(new RegExp(PB + 'I(\\d+)' + PE, 'g'), (m, i) => '<code>' + escapeHtml(codeStore[+i].code) + '</code>');
    esc = esc.replace(/^(#{1,6})\s+(.+)$/gm, (m, h, t) => '\n<h' + h.length + '>' + inlineMd(t) + '</h' + h.length + '>\n');
    esc = esc.replace(/^[ \t]*(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/gm, '\n<hr>\n');
    let out = '', inList = null, para = [];
    const closeList = () => { if (inList) { out += '</' + inList + '>\n'; inList = null; } };
    const flushP = () => { if (para.length) { out += '<p>' + para.map(p => inlineMd(p)).join('<br>') + '</p>\n'; para = []; } };
    for (const raw of esc.split('\n')) {
      const line = raw;
      const ulm = line.match(/^[ \t]*[-*+][ \t]+(.*)$/);
      const olm = line.match(/^[ \t]*\d+[.)][ \t]+(.*)$/);
      const qm = line.match(/^[ \t]*&gt;[ \t]?(.*)$/);
      if (!line.trim()) { flushP(); closeList(); continue; }
      if (ulm) { flushP(); if (inList !== 'ul') { closeList(); out += '<ul>\n'; inList = 'ul'; } out += '<li>' + inlineMd(ulm[1]) + '</li>\n'; continue; }
      if (olm) { flushP(); if (inList !== 'ol') { closeList(); out += '<ol>\n'; inList = 'ol'; } out += '<li>' + inlineMd(olm[1]) + '</li>\n'; continue; }
      if (qm) { flushP(); closeList(); out += '<blockquote>' + inlineMd(qm[1]) + '</blockquote>\n'; continue; }
      if (/^<h\d/.test(line) || /^<hr>$/.test(line)) { flushP(); closeList(); out += line + '\n'; continue; }
      para.push(line);
    }
    flushP(); closeList();
    out = out.replace(new RegExp(PB + 'B(\\d+)' + PE, 'g'), (m, i) => renderCodeBlock(codeStore[+i].lang, codeStore[+i].code));
    return out;
  }

  // ---------------- theme ----------------
  function applyTheme() { document.documentElement.setAttribute('data-theme', S.theme); $('#themeToggle').checked = S.theme === 'light'; }

  // ---------------- connection + loaders ----------------
  async function refreshHealth() {
    try {
      const h = await api('/api/health');
      Object.assign(S.config, h.config || {});
      S.addresses = h.addresses || null;
      S.authRequired = h.gui && h.gui.auth;
      const c = $('#conn');
      c.classList.toggle('ok', h.ollama.ok);
      c.classList.toggle('err', !h.ollama.ok);
      const txt = h.ollama.ok ? 'Ollama ' + (h.ollama.version || 'online') : 'Ollama offline — ' + (h.ollama.error || '');
      $('#connText').textContent = txt.slice(0, 48);
      $('#pillDot').classList.toggle('ok', h.ollama.ok);
      $('#pillDot').classList.toggle('err', !h.ollama.ok);
      $('#pillText').textContent = h.ollama.ok ? (h.ollama.version || 'online') : 'offline';
      updateUrlPanel();
      applyConfigToUI();
    } catch (e) {
      if (e instanceof Api401) throw e;
      $('#conn').classList.remove('ok'); $('#conn').classList.add('err');
      $('#pillDot').classList.remove('ok'); $('#pillDot').classList.add('err');
      $('#pillText').textContent = 'error';
      $('#connText').textContent = 'GUI error';
    }
  }

  function updateUrlPanel() {
    const a = S.addresses || {};
    const set = (id, v) => { const e = $('#' + id); if (e) e.value = v || '—'; };
    set('urlLocal', a.local);
    set('urlLan', a.lan);
    set('urlCustom', a.custom);
    const lanRow = $('#urlLanRow'), customRow = $('#urlCustomRow');
    if (lanRow) lanRow.classList.toggle('hidden', !a.lan);
    if (customRow) customRow.classList.toggle('hidden', !a.custom);
    const need = $('#needsTokenHint');
    if (need) need.style.display = S.authRequired ? 'block' : 'none';
    const warn = $('#urlWarn');
    if (warn) warn.style.display = (a.custom && !a.lan) ? 'block' : 'none';
  }

  async function refreshModels() {
    try {
      S.models = await api('/api/models');
    } catch (e) {
      if (e instanceof Api401) throw e;
      S.models = [];
    }
    popModelSelect();
    if (S.models.length) $('#modelChip').textContent = S.model;
  }

  function popModelSelect() {
    const sel = $('#modelSelect');
    sel.innerHTML = '';
    if (!S.models.length) { sel.innerHTML = '<option value="">no models</option>'; return; }
    if (!S.models.some(m => m.name === S.model)) {
      const preferred = (S.config.defaultModels || []).find(dm => S.models.some(m => m.name === dm));
      S.model = preferred || S.models[0].name;
      localStorage.setItem('gui_model', S.model);
    }
    S.models.forEach(m => { const o = el('option', '', escapeHtml(m.name)); o.value = m.name; if (m.name === S.model) o.selected = true; sel.appendChild(o); });
  }
  function applyDefaultModel() {
    const defs = S.config.defaultModels || [];
    const installed = S.models.map(m => m.name);
    if (S.model && installed.includes(S.model)) return;
    const pref = defs.find(d => installed.includes(d)) || installed[0];
    if (pref) { S.model = pref; localStorage.setItem('gui_model', pref); popModelSelect(); }
  }

  async function loadConversations() {
    try { S.conversations = (await api('/api/conversations')).conversations || []; }
    catch (e) { if (e instanceof Api401) throw e; S.conversations = []; }
    renderConvList();
  }
  async function loadMemory() {
    try { S.memory = await api('/api/memory'); }
    catch (e) { if (e instanceof Api401) throw e; S.memory = { notes: [], learned: [] }; }
    $('#learnedCount').textContent = S.memory.learned.length ? '(' + S.memory.learned.length + ')' : '';
    const total = S.memory.notes.length + S.memory.learned.length;
    const badge = $('#memBadge');
    if (badge) { badge.textContent = total ? total + ' 🧠' : ''; badge.title = total + ' memory entries'; }
  }

  // ---------------- conversation list ----------------
  function renderConvList() {
    const nav = $('#convList');
    nav.innerHTML = '';
    const q = S.search.trim().toLowerCase();
    const list = S.conversations.filter(c =>
      !q || (c.title + ' ' + (c.model || '')).toLowerCase().includes(q));
    const cnt = $('#convCount'); if (cnt) cnt.textContent = S.conversations.length;
    if (!list.length) {
      nav.appendChild(el('div', 'conv-meta', '<div class="mem-empty">' + (q ? 'No matches' : 'No conversations yet — start one!') + '</div>'));
      return;
    }
    for (const c of list) {
      const item = el('div', 'conv-item' + (S.conv && S.conv.id === c.id ? ' active' : ''));
      item.title = c.title;
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.innerHTML = '<div class="conv-title">' + escapeHtml(c.title) + '</div>' +
        '<div class="conv-meta">' + (c.messageCount || 0) + ' msgs · ' + timeAgo(c.updatedAt) +
        (c.model ? ' · <span style="font-family:monospace;font-size:10px">' + escapeHtml(c.model) + '</span>' : '') + '</div>' +
        '<button class="conv-del" title="Delete chat">✕</button>';
      const pick = () => { if (document.activeElement === item) selectConversation(c.id); };
      item.addEventListener('click', (e) => { if (e.target.classList.contains('conv-del')) return; selectConversation(c.id); });
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
      item.querySelector('.conv-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this conversation?')) return;
        await api('/api/conversations/' + c.id, { method: 'DELETE' }).catch(() => {});
        S.conversations = S.conversations.filter(x => x.id !== c.id);
        if (S.conv && S.conv.id === c.id) { S.conv = null; showEmpty('chat'); }
        renderConvList();
      });
      nav.appendChild(item);
    }
  }

  async function newConversation() {
    if (S.streaming) stopStream();
    try {
      const { id } = await api('/api/conversations', { method: 'POST', body: { model: S.model } });
      await selectConversation(id, { fresh: true });
    } catch (e) { toast(e.message, 'err'); }
  }

  async function selectConversation(id, { fresh } = {}) {
    if (S.streaming) stopStream();
    clearEditing();
    try {
      const r = await api('/api/conversations/' + id);
      S.conv = (r && r.conversation) || r;
    } catch (e) { toast(e.message, 'err'); return; }
    S.model = S.conv.model || S.model;
    $('#modelSelect').value = S.model;
    $('#modelChip').textContent = S.model;
    localStorage.setItem('gui_model', S.model);
    $('#statChip').textContent = '';
    refreshChatSettingsPanel();
    renderChat();
    renderConvList();
    updateComposerChip();
  }

  // ---------------- chat rendering ----------------
  function showEmpty() {
    $('#chat').innerHTML = '';
    $('#emptyState').classList.remove('hidden');
  }
  function hideEmpty() {
    $('#emptyState').classList.add('hidden');
  }

  function renderChat() {
    $('#chat').innerHTML = '';
    if (S.conv && S.conv.messages.length) {
      hideEmpty();
      S.conv.messages.forEach((m, i) => $('#chat').appendChild(buildMessageEl(m, i)));
    } else {
      showEmpty();
    }
    scrollBottom(true);
  }

  function buildMessageEl(m, i) {
    const wrap = el('div', 'msg ' + (m.role === 'user' ? 'user' : 'assistant'));
    wrap.dataset.idx = i;
    const av = el('div', 'msg-avatar', m.role === 'user' ? '🙂' : '🦙');
    const body = el('div', 'msg-body');
    const bubble = el('div', 'bubble msg-content' + (m.type === 'image' ? ' image-bubble' : '') + (m.toolcall || m.toolResult ? ' tool-bubble' : '') + (m.agent ? ' agent-bubble' : '') + (!m.content && m.role === 'user' ? ' placeholder' : ''));
    if (m.type === 'image') {
      if (m.images && m.images.length) {
        const img = el('img', 'gen-img');
        img.src = m.images[0];
        img.alt = m.prompt || m.content || 'generated image';
        bubble.appendChild(img);
        if (String(m.prompt || '').trim()) bubble.appendChild(el('div', 'img-caption', '🎨 ' + escapeHtml(m.prompt)));
      } else if (m.generating) {
        bubble.appendChild(el('div', 'img-pending', '<span class="gen-dot"></span><span class="gen-dot"></span><span class="gen-dot"></span><em>&nbsp;Generating image…</em>'));
      } else if (m.error) {
        const e = el('div', 'err-msg', '⚠ ' + escapeHtml(m.error));
        bubble.appendChild(e);
      }
    } else if (m.toolcall) {
      const c = el('div', 'tool-card ok');
      c.innerHTML = '<span class="tool-tag">' + escapeHtml(m.toolcall.name) + '</span><code>' + escapeHtml(m.toolcall.arg) + '</code>';
      bubble.appendChild(c);
    } else if (m.toolResult) {
      const d = el('details', 'tool-result ' + (m.ok ? 'ok' : 'err'));
      d.innerHTML = '<summary>' + (m.ok ? '✓ result' : '✕ error') + '</summary><pre class="tool-out">' + escapeHtml(m.content) + '</pre>';
      bubble.appendChild(d);
    } else {
      if (m.content) bubble.innerHTML = mdToHtml(m.content);
      else if (m.role === 'user') bubble.textContent = '…';
    }
    const tools = el('div', 'msg-tools');
    const addTool = (label, fn) => {
      const b = el('button', 'tool-btn', label);
      b.addEventListener('click', fn);
      tools.appendChild(b);
    };
    if (m.type === 'image') {
      if (m.images && m.images.length) {
        addTool('⭳ Save', () => saveGeneratedImage(m.images[0]));
        addTool('↻ Again', () => sendImagePrompt(m.prompt || m.content));
      }
    } else if (m.toolcall || m.toolResult) {
      // tool cards get delete only
    } else if (m.role === 'user') {
      addTool('✎ Edit', () => editMessage(i));
      addTool('⧉ Copy', () => copyText(m.content));
    } else {
      addTool('↻ Retry', () => regenerate(i));
      addTool('⧉ Copy', () => copyText(m.content));
    }
    if (m.content && m.type !== 'image') addTool('＋ Insert', () => insertAfter(i));
    addTool('🗑 Del', () => deleteMessagesFrom(i));
    body.appendChild(bubble);
    if (m.role === 'assistant' && m.stats && m.type === 'image' && !m.error) body.appendChild(statLine(m.stats));
    wrap.appendChild(av); wrap.appendChild(body); wrap.appendChild(tools);
    return wrap;
  }

  function statLine(st) {
    const div = el('div', 'stats-line');
    const tok = st.eval_count != null ? st.eval_count : '—';
    const dur = st.eval_duration / 1e9;
    const tps = dur > 0 && st.eval_count ? (st.eval_count / dur).toFixed(1) : '—';
    if (st.model) div.appendChild(el('span', '', escapeHtml(st.model)));
    div.appendChild(el('span', '', tok + ' tokens'));
    if (tps !== '—') div.appendChild(el('span', '', tps + ' tok/s'));
    if (dur) div.appendChild(el('span', '', dur.toFixed(1) + 's'));
    const pt = st.prompt_eval_count != null ? ('prompt ' + st.prompt_eval_count) : '';
    if (pt) div.appendChild(el('span', '', pt));
    return div;
  }

  function renderBubble(idx) {
    const wrap = $('#chat').querySelector('[data-idx="' + idx + '"]');
    if (!wrap) return;
    const m = S.conv.messages[idx];
    const b = wrap.querySelector('.msg-content');
    if (m.type === 'image') return;
    if (m.content) { b.classList.remove('placeholder'); b.innerHTML = mdToHtml(m.content); }
    else if (m.role === 'user') { b.classList.add('placeholder'); b.textContent = '…'; }
    if (S.streaming && idx === S.conv.messages.length - 1) b.appendChild(el('span', 'cursor'));
  }

  // ---------------- scrolling ----------------
  function nearBottom() {
    const a = $('#chatArea');
    return a.scrollHeight - a.scrollTop - a.clientHeight < 140;
  }
  function scrollBottom(force) {
    const a = $('#chatArea');
    if (force || nearBottom()) a.scrollTop = a.scrollHeight;
  }

  // ---------------- composer ----------------
  function autoGrow() {
    const t = $('#input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 220) + 'px';
  }
  function clearEditing() { S.editingIndex = -1; updateComposerChip(); }
  function updateComposerChip() {
    const chip = $('#composerChip');
    chip.innerHTML = '';
    if (S.editingIndex >= 0) chip.appendChild(el('span', 'mem-chip', '<span>✎ Editing message #' + (S.editingIndex + 1) + '</span> <button title="cancel" data-cancel>✕</button>'));
    const cancel = chip.querySelector('[data-cancel]');
    if (cancel) cancel.addEventListener('click', () => { clearEditing(); $('#input').value = ''; $('#input').focus(); });
  }

  function editMessage(idx) {
    const m = S.conv.messages[idx];
    if (!m || m.role !== 'user') return;
    $('#input').value = m.content;
    S.editingIndex = idx;
    updateComposerChip();
    autoGrow();
    $('#input').focus();
  }
  function insertAfter(idx) {
    S.conv.messages.splice(idx + 1, 0, { role: 'user', content: '', createdAt: nowISO() });
    S.editingIndex = idx + 1;
    $('#input').value = '';
    $('#input').focus();
    updateComposerChip();
    renderChat();
    scrollBottom(true);
  }
  function deleteMessagesFrom(idx) {
    if (!confirm('Delete this message and everything after it?')) return;
    S.conv.messages = S.conv.messages.slice(0, idx);
    saveConv();
    renderChat();
  }
  async function regenerate(idx) {
    if (S.streaming) return;
    S.conv.messages = S.conv.messages.slice(0, idx);
    renderChat();
    await streamAssistant();
    saveConv();
  }
  function copyTextAlternative(text) { // returns Promise<boolean>; works without secure context
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.readOnly = true;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch {}
        ta.remove();
        return ok;
      } catch { return false; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(fallback);
    }
    return Promise.resolve(fallback());
  }
  function copyText(text) {
    copyTextAlternative(text).then(ok => toast(ok ? 'Copied' : 'Copy failed', ok ? 'ok' : 'err'));
  }

  // ---------------- image generation ----------------------------
  function setGen(label) {
    $('#genInd').classList.toggle('hidden', !label);
    if (label) $('#genInd em').textContent = label;
  }

  function saveGeneratedImage(dataUrl) {
    const a = el('a');
    a.href = dataUrl;
    a.download = 'generated-' + Date.now() + '.png';
    document.body.appendChild(a); a.click();
    setTimeout(() => a.remove(), 400);
    toast('Image saved', 'ok');
  }

  async function sendImage(opts = {}) {
    if (S.streaming) return;
    const prompt = String(opts.prompt == null ? $('#input').value : opts.prompt).trim();
    if (!prompt) return;
    const model = S.config.imageModel || '';
    if (!model) { toast('Set an image model in Settings → General', 'err'); openModal('modalSettings'); return; }
    if (!S.conv) await ensureConversation();
    const conv = S.conv;
    if (!opts.regen) { // regeneration reuses the existing user message
      conv.messages.push({ role: 'user', content: prompt, createdAt: nowISO() });
      $('#input').value = ''; autoGrow();
    }
    conv.messages.push({ role: 'assistant', type: 'image', prompt, images: [], generating: true, createdAt: nowISO(), stats: null });
    conv.updatedAt = nowISO();
    hideEmpty(); renderChat();
    S.streaming = true;
    S.abort = new AbortController();
    setSendingState(true);
    setGen('Generating image…');
    const idx = conv.messages.length - 1;
    try {
      const res = await fetchStream('/api/image', { prompt, model }, S.abort.signal);
      if (res.status === 401) { toast('Auth required', 'err'); showLogin(); return; }
      const j = await res.json();
      if (!res.ok || !j.image) throw new Error((j && j.error) || 'Image generation failed');
      conv.messages[idx].images = [j.image];
      conv.messages[idx].stats = { model: j.model, prompt: j.prompt };
      conv.messages[idx].generating = false;
    } catch (e) {
      conv.messages[idx].generating = false;
      if (e.name === 'AbortError') { conv.messages[idx].error = 'Cancelled'; toast('Stopped', 'err'); }
      else { conv.messages[idx].error = e.message; toast(e.message, 'err'); }
    } finally {
      S.streaming = false;
      setSendingState(false);
      S.abort = null;
      setGen('');
      renderChat(); scrollBottom(true);
      await saveConv();
      renderConvList();
    }
  }
  async function sendImagePrompt(prompt) {
    if (S.streaming) return;
    await sendImage({ prompt: String(prompt || ''), regen: true });
  }

  // The "brain" — ask the active model whether this is an image request or chat.
  async function smartSend() {
    if (S.streaming || S.routing) return;
    const content = $('#input').value.trim();
    if (!content) return;
    S.routing = true;
    S.abort = new AbortController();
    setSendingState(true);
    setGen('Thinking…');
    let action = 'chat';
    let aborted = false;
    try {
      const r = await fetchStream('/api/route', { text: content, model: S.model || '' }, S.abort.signal);
      if (r.status === 401) { toast('Auth required', 'err'); showLogin(); }
      else {
        const j = await r.json();
        if (r.ok && j.action === 'image') action = 'image';
      }
    } catch (e) {
      if (e.name === 'AbortError') aborted = true;
    } finally { S.abort = null; }
    S.routing = false;
    setGen('');
    setSendingState(false);
    if (aborted) return;
    if (action === 'image') await sendImage();
    else if (S.mode === 'agent') await agentSend();
    else await sendMessage();
  }

  // ---------------- agent (coding mode) ----------------
  function setMode(m) {
    S.mode = m;
    $('#modeChat').classList.toggle('active', m === 'chat');
    $('#modeAgent').classList.toggle('active', m === 'agent');
    metaToolUI();
    $('#input').placeholder = m === 'agent'
      ? 'Describe a coding task…  (Enter to send)'
      : 'Message your model…  (Ctrl+Enter to send)';
    $('#input').focus();
  }
  function metaToolUI() {
    const ws = S.config.workspace || '';
    $('#agentChip').textContent = '📁 ' + (ws ? ws.split(/[\\/]/).pop() : 'no workspace');
    $('#agentChip').classList.toggle('hidden', S.mode !== 'agent');
  }

  function agentCard(st, ev) {
    const c = el('div', 'tool-card ' + ev);
    c.innerHTML = '<span class="tool-tag">' + escapeHtml(st.name) + '</span><code>' + escapeHtml(st.arg) + '</code>';
    if (ev === 'running') {
      c.appendChild(el('span', 'tool-badge', 'running…'));
    } else {
      const d = el('details');
      d.innerHTML = '<summary class="tool-summary">' + (st.ok ? '✓ ok' : '✕ error') + (st.code != null && !st.ok ? ' (exit ' + st.code + ')' : '') + '</summary>';
      const pre = el('pre', 'tool-out', escapeHtml(st.output || ''));
      d.appendChild(pre);
      c.appendChild(d);
    }
    return c;
  }

  async function agentSend() {
    if (S.streaming || S.routing) return;
    if (!S.config.workspace) { toast('Agent needs a workspace — open Settings → General', 'err'); openModal('modalSettings'); return; }
    const content = $('#input').value.trim();
    if (!content) return;
    const model = (S.conv && S.conv.model) || S.model;
    if (!model) { toast('Pick a model first', 'err'); return; }
    if (!S.conv) await ensureConversation();
    const conv = S.conv;
    conv.messages.push({ role: 'user', content, createdAt: nowISO() });
    $('#input').value = ''; autoGrow();
    conv.messages.push({ role: 'assistant', content: '', agent: true, createdAt: nowISO(), stats: null });
    conv.updatedAt = nowISO();
    hideEmpty(); renderChat();
    const idx = conv.messages.length - 1;
    const wrap = $('#chat').querySelector('[data-idx="' + idx + '"]');
    const bodyEl = wrap.querySelector('.msg-body');
    const b = wrap.querySelector('.msg-content');
    b.appendChild(el('span', 'cursor'));
    const stepsBox = el('div', 'agent-steps');
    bodyEl.appendChild(stepsBox);
    scrollBottom(true);

    S.streaming = true;
    S.abort = new AbortController();
    setSendingState(true);
    setGen('Coding…');
    const steps = [];
    let liveText = '';
    let lastR = 0;
    let readErr = null;
    try {
      const res = await fetchStream('/api/agent', { model, messages: conv.messages }, S.abort.signal);
      if (res.status === 401) { toast('Auth required', 'err'); showLogin(); return; }
      if (!res.ok) { let m = 'Agent request failed'; try { const j = await res.json(); if (j.error) m = String(j.error); } catch {} throw new Error(m); }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, sep); buf = buf.slice(sep + 2);
          let ev = '';
          for (const line of block.split('\n')) { if (line.startsWith('event:')) { ev = line.slice(6).trim(); break; } }
          let j; try { const dl = block.split('\n').find(l => l.startsWith('data:')); j = dl ? JSON.parse(dl.slice(5).trim()) : null; } catch { continue; }
          if (!j) continue;
          if (ev === 'delta') {
            liveText += j.text || '';
            conv.messages[idx].content = liveText;
            const nowMs = Date.now();
            if (nowMs - lastR > 40) { lastR = nowMs; renderBubble(idx); scrollBottom(); }
          } else if (ev === 'tool') {
            const st = { name: j.name, arg: j.arg, ok: true, output: '', code: null };
            steps.push(st);
            st.card = agentCard(st, 'running');
            stepsBox.appendChild(st.card);
          } else if (ev === 'tool-result') {
            const st = steps.find(s => s.name === j.name);
            if (st) {
              st.ok = !!j.ok; st.output = j.output || ''; st.code = j.code;
              if (st.card) st.card.replaceWith(agentCard(st, st.ok ? 'ok' : 'err'));
            }
          } else if (ev === 'deps') {
            const stTxt = { installed: '✓ installed', failed: '✕ install failed', ok: '✓ ok' }[j.status] || j.status;
            const d = el('div', 'tool-card tool-card-deps ' + (j.status === 'failed' ? 'err' : j.status === 'installed' ? 'ok' : ''));
            d.innerHTML = '<span class="tool-tag">deps</span><code>' + escapeHtml(String(j.lang || '') + ' · ' + String(j.manifest || '')) + '</code><span class="tool-summary">' + stTxt + '</span>';
            if (j.detail) {
              const dd = el('details');
              dd.appendChild(el('pre', 'tool-out', escapeHtml(String(j.detail || ''))));
              d.appendChild(dd);
            }
            stepsBox.appendChild(d);
          } else if (ev === 'done') {
            if (j.text != null) liveText = j.text;
            conv.messages[idx].content = liveText;
          } else if (ev === 'error') {
            throw new Error(j.message || 'Agent error');
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') { conv.messages[idx].content = liveText + (liveText.trim() ? '\n\n_Stopped._' : '_Stopped._'); }
      else { readErr = e.message; conv.messages[idx].content = liveText; }
    }
    const cursor = b.querySelector('.cursor');
    if (cursor) cursor.remove();
    stepsBox.remove();
    S.streaming = false;
    setSendingState(false);
    S.abort = null;
    setGen('');

    if (readErr) {
      conv.messages[idx].content = liveText || '';
      b.innerHTML = '<span class="err-msg">⚠ ' + escapeHtml(readErr) + '</span>';
    } else {
      const stepsMsgs = [];
      for (const st of steps) {
        stepsMsgs.push({ role: 'assistant', content: '', toolcall: { name: st.name, arg: st.arg }, createdAt: nowISO() });
        stepsMsgs.push({ role: 'user', content: '[Tool result]\n' + (st.output || ''), toolResult: true, ok: st.ok !== false, createdAt: nowISO() });
      }
      conv.messages.splice(idx, 1);
      conv.messages.push(...stepsMsgs);
      conv.messages.push({ role: 'assistant', content: liveText, agent: true, stats: { model }, createdAt: nowISO() });
    }
    renderChat(); scrollBottom(true);
    await saveConv();
    renderConvList();
  }

  function renderRecommendedModels() {
    const defs = S.config.defaultModels || [];
    if (!defs.length) return;
    const installed = new Set(S.models.map(m => m.name));
    const missing = defs.filter(d => !installed.has(d));
    if (!missing.length) return;
    const box = el('div', 'rec-box');
    box.innerHTML = '<div class="rec-title">⭐ Recommended models (defaults) — not installed</div>';
    missing.forEach(d => {
      const row = el('div', 'rec-row');
      row.innerHTML = '<code>' + escapeHtml(d) + '</code>';
      const b = el('button', 'btn btn-ghost btn-xs', 'Pull');
      b.addEventListener('click', () => { $('#pullName').value = d; pullModel(d); });
      row.appendChild(b);
      box.appendChild(row);
    });
    $('#modelList').appendChild(box);
  }
  function refreshChatSettingsPanel() {
    applyParamsToPanel(mergeParams(S.conv ? S.conv.params : S.params));
    updateStatsParams();
    $('#systemInput').value = S.conv ? (S.conv.system || '') : '';
    $('#useMemory').checked = S.conv ? S.conv.useMemory !== false : true;
  }
  function mergeParams(p) { return Object.assign({}, DEFAULTS, (p || {})); }
  function applyParamsToPanel(p) {
    $$('.param').forEach(row => {
      const key = row.dataset.key;
      const v = p[key];
      const inp = row.querySelector('input');
      if (v != null) inp.value = v;
      row.querySelector('output').textContent = key === 'seed' ? (v == null ? 'random' : v) : (v != null ? v : DEFAULTS[key]);
    });
    $('#ctxChip').textContent = 'ctx ' + (p.num_ctx || DEFAULTS.num_ctx);
  }
  function readParamsFromPanel() {
    const p = {};
    $$('.param').forEach(row => { p[row.dataset.key] = parseFloat(row.querySelector('input').value); });
    if (p.seed === 0) p.seed = null;
    return p;
  }
  const saveParamsDebounced = debounce(() => {
    if (!S.conv) return;
    S.conv.params = readParamsFromPanel();
    S.conv.params.seed = S.conv.params.seed || null;
    updateStatsParams();
    api('/api/conversations/' + S.conv.id, { method: 'PATCH', body: { params: S.conv.params } }).catch(() => {});
  }, 350);
  function updateStatsParams() {
    $('#modelChip').textContent = S.model || '';
    const p = mergeParams(S.conv ? S.conv.params : S.params);
    $('#ctxChip').textContent = 'ctx ' + (p.num_ctx != null ? p.num_ctx : DEFAULTS.num_ctx);
  }
  const saveSystemDebounced = debounce(() => {
    if (!S.conv) return;
    S.conv.system = $('#systemInput').value;
    api('/api/conversations/' + S.conv.id, { method: 'PATCH', body: { system: S.conv.system } }).catch(() => {});
  }, 500);

  // ---------------- memory block ----------------
  function getMemoryBlock() {
    const items = [...S.memory.notes, ...S.memory.learned].filter(n => n.enabled !== false).slice(0, 30);
    if (!items.length) return null;
    return 'Facts about the user / knowledge to use when answering:\n' + items.map(n => '• ' + n.text).join('\n');
  }

  // ---------------- build prompt + stream ----------------
  function buildPromptMessages(conv) {
    const msgs = [];
    const mem = conv.useMemory !== false ? getMemoryBlock() : null;
    if (mem) msgs.push({ role: 'system', content: mem });
    if (conv.system && conv.system.trim()) msgs.push({ role: 'system', content: conv.system });
    for (const m of conv.messages) {
      if (m.type === 'image') continue; // skip generated images
      if (!String(m.content || '').trim()) continue; // skip empty placeholders
      msgs.push({ role: m.role, content: m.content });
    }
    return msgs;
  }
  function currentOptions() {
    const p = mergeParams(S.conv.params);
    const o = {};
    if (p.temperature != null) o.temperature = p.temperature;
    if (p.top_p != null) o.top_p = p.top_p;
    if (p.top_k != null) o.top_k = p.top_k;
    if (p.num_ctx != null) o.num_ctx = p.num_ctx;
    if (p.seed != null) o.seed = p.seed;
    return o;
  }

  async function sendMessage(opts = {}) {
    if (S.streaming) return;
    if (!S.model && !opts.replay) { toast('Pick a model first', 'err'); return; }
    let content = $('#input').value.trim();
    if (!opts.replay && !content && S.editingIndex < 0) return;

    if (!S.conv) await ensureConversation();
    const conv = S.conv;
    conv.updatedAt = nowISO();
    if (!opts.replay) {
      if (S.editingIndex >= 0) {
        const idx = Math.min(S.editingIndex, conv.messages.length - 1);
        if (!content) {
          clearEditing();
          conv.messages = conv.messages.filter(m => m.role === 'assistant' || String(m.content || '').trim());
          saveConv();
          $('#input').value = ''; autoGrow(); renderChat();
          return;
        }
        conv.messages[idx].content = content;
        conv.messages = conv.messages.slice(0, idx + 1);
        clearEditing();
      } else {
        conv.messages.push({ role: 'user', content, createdAt: nowISO() });
      }
      $('#input').value = '';
      autoGrow();
    }
    hideEmpty();
    renderChat();
    await streamAssistant();
    await saveConv();
    if (S.conv.messages.filter(m => m.role === 'user').length === 1 && S.config.autoTitle) maybeAutoTitle();
    if (S.config.autoMemory && conv.useMemory !== false) maybeAutoLearn();
    renderConvList();
  }

  async function ensureConversation() {
    const { id } = await api('/api/conversations', { method: 'POST', body: { model: S.model } });
    const r = await api('/api/conversations/' + id);
    S.conv = (r && r.conversation) || r;
    if (S.conv) {
      S.conv.params = readParamsFromPanel();
      S.conv.system = $('#systemInput').value;
      S.conv.useMemory = $('#useMemory').checked;
    }
    await loadConversations();
  }

  async function saveConv(extra) {
    if (!S.conv) return;
    const dropEmpty = (m) => m.role === 'assistant' || String(m.content || '').trim();
    S.conv.messages = S.conv.messages.filter(dropEmpty);
    const body = { messages: S.conv.messages, title: S.conv.title };
    api('/api/conversations/' + S.conv.id, { method: 'PATCH', body }).catch(() => {});
    const sum = S.conversations.find(c => c.id === S.conv.id);
    if (sum) { sum.messageCount = S.conv.messages.length; sum.updatedAt = nowISO(); sum.title = S.conv.title; }
  }

  async function streamAssistant() {
    const conv = S.conv;
    const model = conv.model || S.model;
    if (!model) { toast('Pick a model first', 'err'); return; }
    conv.messages.push({ role: 'assistant', content: '', createdAt: nowISO(), stats: null });
    const idx = conv.messages.length - 1;
    renderChat();
    const lastWrap = $('#chat').querySelector('[data-idx="' + idx + '"]');
    const b = lastWrap.querySelector('.msg-content');
    b.appendChild(el('span', 'cursor'));
    scrollBottom(true);

    S.streaming = true;
    S.abort = new AbortController();
    setSendingState(true);
    S.stats = { start: performance.now(), chars: 0, tokens: 0, model };

    const payload = { model, messages: buildPromptMessages(conv), options: currentOptions() };
    let res;
    try {
      res = await fetchStream('/api/chat', payload, S.abort.signal);
    } catch (e) {
      if (e.name !== 'AbortError') { appendStreamError(idx, 'Cannot reach server: ' + e.message); }
      finalizeStream(idx);
      return;
    }
    if (res.status === 401) { finalizeStream(idx); toast('Access token required', 'err'); showLogin(); return; }
    if (!res.ok) {
      let msg = 'Request failed';
      try { const j = await res.json(); if (j.error) msg = String(j.error).slice(0, 300); } catch {}
      appendStreamError(idx, msg);
      finalizeStream(idx);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', lastR = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, sep); buf = buf.slice(sep + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let j; try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (!j) continue;
            if (j.message && j.message.content) {
              conv.messages[idx].content += j.message.content;
              S.stats.chars += j.message.content.length;
              const nowMs = Date.now();
              if (nowMs - lastR > 40) { lastR = nowMs; renderBubble(idx); scrollBottom(); }
            }
            if (j.done) {
              conv.messages[idx].stats = j;
              if (j.eval_count) S.stats.tokens = j.eval_count;
              renderStats();
            }
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') appendStreamError(idx, 'Stream interrupted');
    }
    finalizeStream(idx);
  }

  function finalizeStream(idx) {
    S.streaming = false;
    setSendingState(false);
    if (S.conv && S.conv.messages[idx]) {
      const wrap = $('#chat').querySelector('[data-idx="' + idx + '"]');
      if (!wrap.querySelector('.err-msg') && !S.conv.messages[idx].content.trim()) {
        wrap.querySelector('.msg-content').innerHTML = '<span class="err-msg">⚠ (empty reply — model returned nothing)</span>';
      } else {
        renderBubble(idx);
      }
    }
    S.abort = null;
    renderStats();
    scrollBottom(true);
  }

  function appendStreamError(idx, msg) {
    const wrap = $('#chat').querySelector('[data-idx="' + idx + '"]');
    if (wrap) { const b = wrap.querySelector('.msg-content'); b.innerHTML = '<span class="err-msg">⚠ ' + escapeHtml(msg) + '</span>'; }
    toast(msg, 'err');
  }

  function setSendingState(on) {
    $('#btnSend').disabled = on;
    $('#btnStop').classList.toggle('hidden', !on);
    $('#genInd').classList.toggle('hidden', !on);
    $('#input').disabled = on;
  }
  function stopStream() { if (S.abort) { S.abort.abort(); S.abort = null; } }

  function renderStats() {
    const st = S.stats;
    const toks = st.tokens ? st.tokens + ' tokens' : (st.start ? Math.round(st.chars / 4) + ' tok (est)' : '0 tokens');
    const elps = (performance.now() - st.start) / 1000;
    const speed = elps > 0 && st.chars > 5 ? (st.chars / 4 / elps).toFixed(1) + ' tok/s' : '— tok/s';
    $('#statChip').textContent = toks + ' · ' + speed;
  }

  // ---------------- auto title + learn ----------------
  async function maybeAutoTitle() {
    const c = S.conv; if (!c || c.title !== 'New chat') return;
    try {
      const r = await api('/api/title', { method: 'POST', body: { conversationId: c.id } });
      if (r && r.title) { c.title = r.title; saveConv(); renderConvList(); }
    } catch (e) {}
  }
  async function maybeAutoLearn() {
    const c = S.conv; if (!c || c.messages.length < 4) return;
    if (Date.now() - S.lastLearnAt < 20000) return;
    S.lastLearnAt = Date.now();
    try {
      const r = await api('/api/memory/extract', { method: 'POST', body: { conversationId: c.id } });
      if (r && r.created > 0) { await loadMemory(); toast('🧠 Learned ' + r.created + ' new fact' + (r.created > 1 ? 's' : ''), 'ok'); }
    } catch (e) {}
  }

  // ---------------- model manager ----------------
  function openModal(id) { $('#modalLayer').classList.remove('hidden'); $('#' + id).classList.remove('hidden'); }
  function closeModals() { $$('.modal-wrap').forEach(m => m.classList.add('hidden')); $('#modalLayer').classList.add('hidden'); }

  function renderModelList() {
    const list = $('#modelList');
    list.innerHTML = '';
    renderRecommendedModels();
    if (!S.models.length) {
      list.appendChild(el('div', 'mem-empty', 'No models found. Pull one below — e.g. <code>qwen2.5</code>, <code>llama3.2</code>, <code>mistral</code>.'));
      return;
    }
    for (const m of S.models) {
      const card = el('div', 'model-card');
      const quant = m.details?.quant_level || '';
      const param = m.details?.parameter_size || '';
      const modified = m.modified_at ? ' · ' + timeAgo(m.modified_at) : '';
      card.innerHTML = '<div class="model-info"><div class="model-name">' + escapeHtml(m.name) + '</div>' +
        '<div class="model-detail">' + fmtBytes(m.size) + (param ? ' · ' + escapeHtml(param) : '') + (quant ? ' · ' + escapeHtml(quant) : '') + modified + '</div></div>' +
        '<div class="model-actions">' +
        '<button class="btn btn-ghost btn-xs" data-act="info">Details</button>' +
        '<button class="btn btn-ghost btn-xs" data-act="use">Use</button>' +
        '<button class="btn btn-ghost btn-xs danger" data-act="del" style="color:var(--danger)">Delete</button></div>';
      card.querySelector('[data-act="info"]').addEventListener('click', () => showModelDetail(m.name));
      card.querySelector('[data-act="use"]').addEventListener('click', () => { setModel(m.name); toast('Using ' + m.name, 'ok'); });
      card.querySelector('[data-act="del"]').addEventListener('click', async () => {
        if (!confirm('Delete model ' + m.name + '? This removes it from Ollama.')) return;
        try { await api('/api/model/' + encodeURIComponent(m.name), { method: 'DELETE' }); toast('Deleted ' + m.name, 'ok'); await refreshModels(); renderModelList(); }
        catch (e) { toast(e.message, 'err'); }
      });
      list.appendChild(card);
    }
  }
  async function showModelDetail(name) {
    openModal('modalModelDetail');
    $('#detailTitle').textContent = name;
    $('#detailBody').innerHTML = '<div class="mem-empty">Loading…</div>';
    try {
      const d = await api('/api/model', { method: 'POST', body: { name } });
      let html = '<div class="detail-rows">';
      const rows = [['Model', d.model], ['Family', (d.details?.family || []).join(', ') || '—'], ['Parameters', d.details?.parameter_size || '—'], ['Quantization', d.details?.quant_level || '—'], ['Context length', d.model_info?.['context_length'] || '—'], ['Embedding length', d.model_info?.['embedding_length'] || '—'], ['Parameters (count)', d.model_info?.['general.parameter_count']?.toLocaleString?.() || '—']];
      for (const [k, v] of rows) html += '<div class="detail-row"><b>' + escapeHtml(k) + '</b><span>' + escapeHtml(String(v ?? '—')) + '</span></div>';
      html += '</div><br>';
      if (d.system) html += '<div class="detail-row"><b>System</b></div><pre>' + escapeHtml(d.system) + '</pre>';
      if (d.template) html += '<div class="detail-row" style="margin-top:10px"><b>Template</b></div><pre>' + escapeHtml(d.template) + '</pre>';
      $('#detailBody').innerHTML = html;
    } catch (e) { $('#detailBody').innerHTML = '<span class="err-msg">' + escapeHtml(e.message) + '</span>'; }
  }
  async function pullModel(name) {
    if (!name) return;
    const prog = $('#pullProgress');
    prog.classList.remove('hidden');
    $('#pullBar').style.width = '0%';
    $('#pullStatus').textContent = 'Starting…';
    let done = false;
    try {
      const res = await fetchStream('/api/pull', { name });
      if (res.status === 401) { toast('Auth required', 'err'); return; }
      if (!res.ok) { let e = 'Pull failed'; try { e = (await res.json()).error || e; } catch {} toast(e, 'err'); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', failed = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, sep); buf = buf.slice(sep + 2);
          let isErr = /event:\s*error/.test(block);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let j; try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (!j) continue;
            if (isErr && j.message) { failed = true; $('#pullStatus').textContent = 'Error: ' + j.message; }
            if (j.status === 'success') { done = true; $('#pullBar').style.width = '100%'; }
            else if (j.total) $('#pullBar').style.width = Math.round(j.completed / j.total * 100) + '%';
            $('#pullStatus').textContent = (j.status || '') + (j.completed && j.total ? ' — ' + Math.round(j.completed / j.total * 100) + '%' : '');
          }
        }
      }
      $('#pullStatus').textContent = done && !failed ? 'Done ✔' : $('#pullStatus').textContent;
      if (done) { await refreshModels(); renderModelList(); toast(name + ' ready', 'ok'); setTimeout(() => prog.classList.add('hidden'), 1500); }
    } catch (e) { $('#pullStatus').textContent = 'Error: ' + e.message; }
  }
  function setModel(name) {
    S.model = name;
    localStorage.setItem('gui_model', name);
    popModelSelect();
    $('#modelChip').textContent = name;
    if (S.conv) { S.conv.model = name; api('/api/conversations/' + S.conv.id, { method: 'PATCH', body: { model: name } }).catch(() => {}); }
    updateStatsParams();
  }

  // ---------------- memory UI ----------------
  function renderMemory() {
    const list = $('#memoryList');
    list.innerHTML = '';
    const tab = $('#modalMemory .tab.active').dataset.tab;
    const items = tab === 'learned' ? S.memory.learned : S.memory.notes;
    if (!items.length) {
      list.appendChild(el('div', 'mem-empty', tab === 'learned' ? 'Nothing learned yet — just chat and the app extracts facts automatically (enable Auto-learn).' : 'Add notes you want the assistant to always know.'));
      return;
    }
    items.forEach(item => {
      const row = el('div', 'mem-item');
      const txt = el('div', 'txt', escapeHtml(item.text));
      const sub = el('div', '');
      if (item.tags && item.tags.length) sub.appendChild(el('div', 'tags', item.tags.map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join('')));
      sub.appendChild(el('div', 'meta', (item.learned ? 'learned ' : 'note ') + timeAgo(item.createdAt)));
      const actions = el('div', 'mem-actions');
      const en = el('button', 'tool-btn', item.enabled !== false ? '✓ on' : '✕ off');
      en.title = 'Include in prompts';
      en.addEventListener('click', async () => { item.enabled = item.enabled !== false ? false : true; try { await api('/api/memory/' + item.id, { method: 'PATCH', body: { enabled: item.enabled } }); renderMemory(); } catch (e) { toast(e.message, 'err'); } });
      const edit = el('button', 'tool-btn', '✎');
      edit.addEventListener('click', () => inlineEditMem(row, item));
      const del = el('button', 'tool-btn', '🗑');
      del.addEventListener('click', async () => { try { await api('/api/memory/' + item.id, { method: 'DELETE' }); if (item.learned) S.memory.learned = S.memory.learned.filter(x => x.id !== item.id); else S.memory.notes = S.memory.notes.filter(x => x.id !== item.id); renderMemory(); } catch (e) { toast(e.message, 'err'); } });
      actions.append(en, edit, del);
      const wrapper = el('div', '');
      wrapper.append(txt, sub);
      row.append(wrapper, actions);
      list.appendChild(row);
    });
  }
  function inlineEditMem(row, item) {
    const wrapper = row.querySelector('.txt');
    const input = el('input');
    input.value = item.text;
    input.style.flex = '1';
    const save = async () => {
      const v = input.value.trim(); if (!v) return;
      try { await api('/api/memory/' + item.id, { method: 'PATCH', body: { text: v } }); item.text = v; renderMemory(); } catch (e) { toast(e.message, 'err'); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') renderMemory(); });
    wrapper.replaceWith(input);

    input.focus();
    const btn = el('button', 'tool-btn', 'Save'); btn.addEventListener('click', save);
    row.querySelector('.mem-actions').prepend(btn);
  }

  // ---------------- settings ----------------
  function applyConfigToUI() {
    $('#setOllamaBase').value = S.config.ollamaBase || '';
    $('#setHost').value = S.config.host || '127.0.0.1';
    $('#setPort').value = S.config.port || 8899;
    $('#setToken').value = S.token;
    $('#setCustomUrl').value = S.config.customUrl || '';
    $('#setAutoTitle').checked = !!S.config.autoTitle;
    $('#setAutoMemory').checked = !!S.config.autoMemory;
    $('#autoMemory').checked = !!S.config.autoMemory;
    $('#setImageModel').value = S.config.imageModel || '';
    $('#setDefaultModels').value = (S.config.defaultModels || []).join(', ');
    $('#setWorkspace').value = S.config.workspace || '';
    $('#restartNote').classList.add('hidden');
    $$('.seg-btn').forEach(b => { if (b.dataset.themeV !== undefined) b.classList.toggle('active', b.dataset.themeV === S.theme); });
    if (S.model) $('#modelChip').textContent = S.model;
  }
  async function saveSettings() {
    const body = {
      ollamaBase: $('#setOllamaBase').value.trim(),
      host: $('#setHost').value.trim(),
      port: parseInt($('#setPort').value, 10),
      customUrl: $('#setCustomUrl').value.trim(),
      accessToken: $('#setToken').value.trim(),
      autoTitle: $('#setAutoTitle').checked,
      autoMemory: $('#setAutoMemory').checked,
      imageModel: $('#setImageModel').value.trim(),
      defaultModels: $('#setDefaultModels').value.split(',').map(s => s.trim()).filter(Boolean),
      workspace: $('#setWorkspace').value.trim(),
    };
    try {
      const r = await api('/api/config', { method: 'POST', body });
      Object.assign(S.config, r.config || {});
      S.addresses = r.addresses || S.addresses;
      updateUrlPanel();
      if (body.accessToken) { S.token = body.accessToken; localStorage.setItem('gui_token', S.token); S.authRequired = !!body.accessToken; }
      applyDefaultModel();
      metaToolUI();
      toast(r.needsRestart ? 'Saved — restarting server…' : 'Settings saved', 'ok');
      closeModals();
      if (r.needsRestart) {
        const next = (r.addresses && r.addresses.local) || location.href;
        setTimeout(() => { location.href = next; }, 1400);
      } else refreshHealth();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ---------------- login ----------------
  async function tryLogin() {
    const t = $('#loginToken').value.trim();
    if (!t) return;
    S.token = t;
    localStorage.setItem('gui_token', t);
    try {
      const h = await api('/api/health');
      closeModals();
      Object.assign(S.config, h.config || {});
      applyConfigToUI();
      $('#conn').classList.remove('err'); $('#conn').classList.add('ok');
      $('#connText').textContent = h.ollama.ok ? ('Ollama ' + (h.ollama.version || 'online')) : 'connected';
      refreshModels(); loadConversations(); loadMemory(); renderChat();
      toast('Unlocked', 'ok');
    } catch (e) {
      if (e instanceof Api401) { S.token = ''; localStorage.removeItem('gui_token'); toast('Wrong token', 'err'); }
    }
  }
  function showLogin() { openModal('modalLogin'); $('#loginToken').focus(); $('#modalLogin .modal').classList.remove('hidden'); }

  // ---------------- export / import ----------------
  async function exportData() {
    try {
      const data = await api('/api/export', { method: 'POST' });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = el('a'); a.href = URL.createObjectURL(blob);
      a.download = 'ollama-gui-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('Exported ' + data.conversations.length + ' chats', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  async function importData(file) {
    try {
      const data = JSON.parse(await file.text());
      const r = await api('/api/import', { method: 'POST', body: data });
      await loadConversations(); await loadMemory();
      toast('Imported ' + r.imported + ' conversations', 'ok');
    } catch (e) { toast('Import failed: ' + e.message, 'err'); }
  }

  // ---------------- quick chips ----------------
  const QUICK = [
    'Explain quantum computing simply',
    'Write fizzbuzz in Python',
    'Debug this error: "TypeError: undefined is not a function"',
    'Summarize the key points of the last 3 chapters'
  ];
  function renderQuick() {
    const box = $('#quickStart');
    box.innerHTML = '';
    QUICK.forEach(p => {
      const c = el('button', 'chip', escapeHtml(p));
      c.addEventListener('click', async () => {
        if (!S.model) { toast('Pick a model first', 'err'); openModal('modalModels'); return; }
        $('#input').value = p; autoGrow();
        if (S.conv && S.conv.messages.length) await newConversation();
        await sendMessage();
      });
      box.appendChild(c);
    });
  }

  // ---------------- init + bind ----------------
  async function init() {
    applyTheme();
    bindUI();
    const urlToken = new URLSearchParams(location.search).get('token');
    if (urlToken) { S.token = urlToken; localStorage.setItem('gui_token', urlToken); }
    let authFailed = false;
    const guard = async (p) => { try { await p; } catch (e) { if (e instanceof Api401) authFailed = true; } };
    renderQuick();
    await Promise.all([guard(loadMemory()), guard(refreshHealth()), guard(refreshModels()), guard(loadConversations())]);
    if (authFailed) { showLogin(); return; }
    const first = S.conversations[0];
    if (first) selectConversation(first.id).catch(() => {});
    else showEmpty();
    updateStatsParams();
    applyDefaultModel();
    setMode('chat');
  }

  function bindUI() {
    // sidebar
    $('#btnNewChat').addEventListener('click', newConversation);
    $('#searchInput').addEventListener('input', debounce(e => { S.search = e.target.value; renderConvList(); }, 200));
    $('#btnMemory').addEventListener('click', () => { openModal('modalMemory'); renderMemory(); });
    $('#btnSettings').addEventListener('click', () => { openModal('modalSettings'); applyConfigToUI(); });
    $('#btnMenu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

    // topbar
    $('#modelSelect').addEventListener('change', (e) => {
      if (!S.models.length) { openModal('modalModels'); e.target.value = ''; return; }
      setModel(e.target.value);
    });
    const openModelsModal = () => { openModal('modalModels'); renderModelList(); };
    $('#btnModels').addEventListener('click', openModelsModal);
    $('#btnModelsTop').addEventListener('click', openModelsModal);
    $('#btnConnPill').addEventListener('click', () => {
      openModal('modalSettings'); applyConfigToUI();
      const web = $$('#modalSettings .tab').find(x => x.dataset.sect === 'web');
      if (web) web.click();
    });
    $('#btnChatSettings').addEventListener('click', () => { refreshChatSettingsPanel(); openModal('modalChatSettings'); });
    $('#btnExport').addEventListener('click', exportData);
    $('#btnImport').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importData(f); e.target.value = ''; });
    $('#themeToggle').addEventListener('change', (e) => {
      S.theme = e.target.checked ? 'light' : 'dark';
      localStorage.setItem('gui_theme', S.theme);
      applyTheme();
      $$('.seg-btn').forEach(x => { if (x.dataset.themeV !== undefined) x.classList.toggle('active', x.dataset.themeV === S.theme); });
    });

    // composer
    $('#composer').addEventListener('submit', (e) => { e.preventDefault(); smartSend(); });
    $('#btnSend').addEventListener('click', smartSend);
    $('#btnStop').addEventListener('click', stopStream);
    $('#input').addEventListener('input', autoGrow);
    $('#input').addEventListener('keydown', (e) => {
      if (S.mode === 'agent' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); smartSend(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); smartSend(); }
      if (e.key === 'Escape' && S.streaming) stopStream();
    });

    // mode toggle (chat / agent)
    $('#modeChat').addEventListener('click', () => setMode('chat'));
    $('#modeAgent').addEventListener('click', () => setMode('agent'));

    // bottom bar settings button (under the GUI)
    $('#btnSettingsBottom').addEventListener('click', () => { openModal('modalSettings'); applyConfigToUI(); });

    // params / system
    $$('.param input').forEach(inp => inp.addEventListener('change', () => { const p = readParamsFromPanel(); applyParamsToPanel(p); if (S.conv) S.conv.params = p; S.params = p; saveParamsDebounced(); }));
    $$('.param input').forEach(inp => inp.addEventListener('input', () => { const p = readParamsFromPanel(); applyParamsToPanel(p); }));
    $('#systemInput').addEventListener('input', saveSystemDebounced);
    $('#systemInput').addEventListener('change', () => { if (S.conv) { S.conv.system = $('#systemInput').value; api('/api/conversations/' + S.conv.id, { method: 'PATCH', body: { system: S.conv.system } }).catch(() => {}); } });
    $('#btnClearSystem').addEventListener('click', () => { $('#systemInput').value = ''; saveSystemDebounced(); });
    $('#useMemory').addEventListener('change', (e) => { if (S.conv) { S.conv.useMemory = e.target.checked; api('/api/conversations/' + S.conv.id, { method: 'PATCH', body: { useMemory: e.target.checked } }).catch(() => {}); } });

    // chat area code-copy
    $('#chat').addEventListener('click', (e) => {
      const btn = e.target.closest('.copy-btn');
      if (btn) {
        const text = btn.closest('.code-block').querySelector('pre').innerText;
        copyTextAlternative(text).then(ok => {
          if (ok) {
            toast('Code copied', 'ok');
            btn.textContent = 'Copied ✓';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
          } else {
            toast('Copy failed', 'err');
          }
        });
        return;
      }
    });

    // modals
    $('#modalLayer').addEventListener('click', closeModals);
    $$('.modal-wrap').forEach(w => w.addEventListener('click', (e) => { if (e.target === w) closeModals(); }));
    $$('[data-close]').forEach(b => b.addEventListener('click', () => { $('#modalLayer').classList.add('hidden'); b.closest('.modal-wrap').classList.add('hidden'); }));
    $$('.modal').forEach(m => m.addEventListener('click', (e) => e.stopPropagation()));

    // models modal
    $('#pullForm').addEventListener('submit', (e) => { e.preventDefault(); pullModel($('#pullName').value.trim()); $('#pullName').value = ''; });

    // memory modal
    $('#memoryForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#memoryText').value.trim(); if (!text) return;
      const tags = $('#memoryTags').value.split(',').map(t => t.trim()).filter(Boolean);
      try { await api('/api/memory', { method: 'POST', body: { text, tags } }); $('#memoryText').value = ''; await loadMemory(); renderMemory(); toast('Remembered', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    });
    $$('#modalMemory .tab').forEach(b => b.addEventListener('click', () => { $$('#modalMemory .tab').forEach(x => x.classList.remove('active')); b.classList.add('active'); renderMemory(); }));
    $('#autoMemory').addEventListener('change', async (e) => {
      S.config.autoMemory = e.target.checked;
      try { await api('/api/config', { method: 'POST', body: { autoMemory: e.target.checked } }); toast('Auto-learn ' + (e.target.checked ? 'on' : 'off'), 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    });

    // settings modal — tabs
    $$('#modalSettings .tab').forEach(b => b.addEventListener('click', () => {
      $$('#modalSettings .tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      $$('#modalSettings .tab-section').forEach(s => s.classList.toggle('active', s.dataset.sect === b.dataset.sect));
    }));
    $$('#modalSettings .seg-btn').forEach(b => b.addEventListener('click', () => {
      S.theme = b.dataset.themeV;
      localStorage.setItem('gui_theme', S.theme);
      applyTheme();
      $('#themeToggle').checked = S.theme === 'light';
      $$('.seg-btn').forEach(x => { if (x.dataset.themeV !== undefined) x.classList.toggle('active', x.dataset.themeV === S.theme); });
      toast('Theme: ' + S.theme, 'ok');
    }));
    $$('#modalSettings .chip[data-host]').forEach(b => b.addEventListener('click', () => {
      $('#setHost').value = b.dataset.host;
      $('#restartNote').classList.remove('hidden');
    }));
    $$('.copy-url').forEach(b => b.addEventListener('click', () => {
      const t = $('#' + b.dataset.target);
      if (t && t.value && t.value !== '—') copyText(t.value);
    }));
    $('#btnSaveSettings').addEventListener('click', saveSettings);
    $('#setPort').addEventListener('input', () => $('#restartNote').classList.remove('hidden'));
    $('#setHost').addEventListener('input', () => $('#restartNote').classList.remove('hidden'));
    $('#setCustomUrl').addEventListener('input', () => { S.config.customUrl = $('#setCustomUrl').value.trim(); updateUrlPanel(); });
    $('#btnExportBig').addEventListener('click', exportData);
    $('#btnImportBig').addEventListener('click', () => $('#fileInput').click());
    $('#btnResetData').addEventListener('click', async () => {
      if (!confirm('Delete ALL conversations and memory? This cannot be undone. Export first if unsure.')) return;
      try {
        await api('/api/reset', { method: 'POST' });
        S.conversations = []; S.conv = null; S.memory = { notes: [], learned: [] };
        loadMemory(); renderConvList(); showEmpty(); renderChat();
        toast('All data deleted', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    // login
    $('#btnLogin').addEventListener('click', tryLogin);
    $('#loginToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });

    // shortcuts
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#searchInput').focus(); $('#searchInput').select(); }
      if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newConversation(); }
      if (e.key === 'Escape') {
        if (!$('#modalLayer').classList.contains('hidden')) closeModals();
        else if (S.streaming) stopStream();
        else { $('#sidebar').classList.remove('open'); $('#searchInput').blur(); }
      }
    });
  }

  // ---------------- boot ----------------
  init().catch(e => { console.error(e); toast('Failed to initialise: ' + e.message, 'err'); });
})();