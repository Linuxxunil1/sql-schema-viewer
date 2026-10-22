/* SQL Schema Viewer – Frontend */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* egal */ } },
  };

  const NODE_W = 250, HEAD_H = 34, ROW_H = 22, MAX_COLS = 30;

  const S = {
    me: null, db: null, schema: null, byId: new Map(),
    pos: {}, dir: 'LR', scale: 1, tx: 0, ty: 0,
    selected: null, query: '',
    opt: { views: false, keysOnly: false, isolated: true },
  };

  // ---------- API ----------
  async function api(url, opts = {}) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
    let data = null;
    try { data = await r.json(); } catch { /* leer */ }
    if (r.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('Sitzung abgelaufen'); }
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data;
  }

  // ---------- Login ----------
  const form = $('loginForm');
  form.authType.forEach(r => r.addEventListener('change', () =>
    $('domainRow').classList.toggle('hidden', form.authType.value !== 'ntlm')));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = Object.fromEntries(fd.entries());
    body.encrypt = form.encrypt.checked; body.trustCert = form.trustCert.checked;
    $('loginError').classList.add('hidden');
    $('loginBtn').disabled = true; $('loginBtn').textContent = 'Verbinde …';
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify(body) });
      store.set('lastLogin', { server: body.server, port: body.port, instance: body.instance, database: body.database,
        authType: body.authType, domain: body.domain, user: body.user, encrypt: body.encrypt, trustCert: body.trustCert });
      form.password.value = '';
      await startApp();
    } catch (err) {
      $('loginError').textContent = err.message; $('loginError').classList.remove('hidden');
    } finally {
      $('loginBtn').disabled = false; $('loginBtn').textContent = 'Verbinden';
    }
  });

  function showLogin() {
    $('app').classList.add('hidden'); $('login').classList.remove('hidden');
    const last = store.get('lastLogin');
    if (last) {
      for (const [k, v] of Object.entries(last)) {
        const el = form.elements[k];
        if (!el) continue;
        if (el instanceof RadioNodeList) el.value = v; else if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
      }
      $('domainRow').classList.toggle('hidden', form.authType.value !== 'ntlm');
      (last.server ? form.password : form.server).focus();
    } else form.server.focus();
  }

  $('logoutBtn').onclick = async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* egal */ }
    S.schema = null; showLogin();
  };

  // ---------- App-Start ----------
  async function startApp() {
    S.me = await api('/api/me');
    $('whoami').textContent = `${S.me.user} @ ${S.me.server}`;
    $('login').classList.add('hidden'); $('app').classList.remove('hidden');
    const dbs = await api('/api/databases');
    const sel = $('dbSelect');
    sel.innerHTML = dbs.map(d => `<option>${esc(d)}</option>`).join('');
    const pref = S.me.database && dbs.includes(S.me.database) ? S.me.database
      : store.get(`db:${S.me.server}`) && dbs.includes(store.get(`db:${S.me.server}`)) ? store.get(`db:${S.me.server}`)
      : dbs.find(d => !['master', 'tempdb', 'model', 'msdb'].includes(d)) || dbs[0];
    if (pref) { sel.value = pref; await loadDb(pref); }
    else { $('empty').textContent = 'Keine zugreifbaren Datenbanken gefunden.'; $('empty').classList.remove('hidden'); }
  }
  $('dbSelect').onchange = e => loadDb(e.target.value);

  async function loadDb(db) {
    S.db = db; S.selected = null; closeDetails();
    store.set(`db:${S.me.server}`, db);
    $('loading').classList.remove('hidden'); $('empty').classList.add('hidden');
    try {
      S.schema = await api(`/api/schema?db=${encodeURIComponent(db)}`);
      S.byId = new Map(S.schema.tables.map(t => [t.id, t]));
      const saved = store.get(posKey());
      S.pos = saved?.pos || {};
      S.dir = saved?.dir || 'LR';
      setLayoutButtons();
      render(true);
    } catch (err) {
      $('empty').textContent = 'Fehler: ' + err.message; $('empty').classList.remove('hidden');
    } finally { $('loading').classList.add('hidden'); }
  }
  const posKey = () => `pos:${S.me.server}:${S.db}`;
  const savePos = () => store.set(posKey(), { pos: S.pos, dir: S.dir });

  // ---------- Sichtbarkeit ----------
  function visibleTables() {
    if (!S.schema) return [];
    const rel = new Set();
    for (const r of S.schema.relations) { rel.add(r.from); rel.add(r.to); }
    return S.schema.tables.filter(t =>
      (S.opt.views || t.kind === 'table') && (S.opt.isolated || rel.has(t.id)));
  }
  function shownColumns(t) {
    const cols = S.opt.keysOnly ? t.columns.filter(c => c.pk || c.fk) : t.columns;
    return { list: cols.slice(0, MAX_COLS), hidden: cols.length - Math.min(cols.length, MAX_COLS) };
  }
  const nodeHeight = t => { const s = shownColumns(t); return HEAD_H + (s.list.length + (s.hidden ? 1 : 0)) * ROW_H + 1; };

  // ---------- Layout ----------
  function autoLayout(tables) {
    const ids = new Set(tables.map(t => t.id));
    const rels = S.schema.relations.filter(r => ids.has(r.from) && ids.has(r.to));
    const linked = new Set(); rels.forEach(r => { linked.add(r.from); linked.add(r.to); });
    const connected = tables.filter(t => linked.has(t.id));
    const isolated = tables.filter(t => !linked.has(t.id));

    let maxX = 0, maxY = 0;
    if (connected.length) {
      const g = new dagre.graphlib.Graph({ multigraph: true });
      g.setGraph({ rankdir: S.dir, nodesep: 36, ranksep: 110, marginx: 40, marginy: 40 });
      g.setDefaultEdgeLabel(() => ({}));
      connected.forEach(t => g.setNode(t.id, { width: NODE_W, height: nodeHeight(t) }));
      rels.forEach(r => { if (r.from !== r.to) g.setEdge(r.to, r.from, {}, r.name); });
      dagre.layout(g);
      g.nodes().forEach(id => {
        const n = g.node(id);
        S.pos[id] = { x: n.x - n.width / 2, y: n.y - n.height / 2 };
        maxX = Math.max(maxX, n.x + n.width / 2); maxY = Math.max(maxY, n.y + n.height / 2);
      });
    }
    // Tabellen ohne Beziehung als Raster darunter bzw. daneben
    if (isolated.length) {
      const cols = Math.max(3, Math.ceil(Math.sqrt(isolated.length * 1.6)));
      const startX = connected.length && S.dir === 'TB' ? maxX + 120 : 40;
      const startY = connected.length && S.dir === 'LR' ? maxY + 120 : 40;
      let rowY = startY, rowH = 0;
      isolated.forEach((t, i) => {
        const c = i % cols;
        if (c === 0 && i) { rowY += rowH + 36; rowH = 0; }
        S.pos[t.id] = { x: startX + c * (NODE_W + 36), y: rowY };
        rowH = Math.max(rowH, nodeHeight(t));
      });
    }
    savePos();
  }

  // ---------- Rendering ----------
  const nodesEl = $('nodes'), edgesEl = $('edges'), world = $('world'), vp = $('viewport');

  function render(fit = false) {
    const tables = visibleTables();
    if (tables.some(t => !S.pos[t.id])) {
      const missing = tables.filter(t => !S.pos[t.id]);
      if (missing.length === tables.length) autoLayout(tables);
      else placeMissing(missing);
    }
    nodesEl.innerHTML = tables.map(nodeHtml).join('');
    renderEdges();
    renderList();
    updateStats(tables);
    $('empty').classList.toggle('hidden', tables.length > 0);
    if (!tables.length) $('empty').textContent = 'Keine Tabellen gefunden.';
    applyHighlight();
    if (fit) fitView();
  }

  function placeMissing(missing) {
    let maxY = 0;
    for (const id in S.pos) {
      const t = S.byId.get(id); if (t) maxY = Math.max(maxY, S.pos[id].y + nodeHeight(t));
    }
    missing.forEach((t, i) => { S.pos[t.id] = { x: 40 + (i % 6) * (NODE_W + 36), y: maxY + 80 + Math.floor(i / 6) * 260 }; });
    savePos();
  }

  function nodeHtml(t) {
    const p = S.pos[t.id], s = shownColumns(t);
    const rows = t.rows == null ? '' : `${t.rows.toLocaleString('de-DE')} Z.`;
    const cols = s.list.map(c => `
      <div class="n-col" data-col="${esc(c.name)}">
        <span class="ic ${c.pk ? 'pk' : c.fk ? 'fk' : ''}">${c.pk ? 'PK' : c.fk ? 'FK' : ''}</span>
        <span class="cn">${esc(c.name)}</span>
        <span class="ct">${esc(c.type)}</span>${c.nullable ? '' : '<span class="nn" title="NOT NULL">*</span>'}
      </div>`).join('');
    const more = s.hidden ? `<div class="n-more">… ${s.hidden} weitere Spalten</div>` : '';
    return `<div class="node ${t.kind}" data-id="${t.id}" style="left:${p.x}px;top:${p.y}px">
      <div class="n-head"><span class="n-title" title="${esc(t.schema)}.${esc(t.name)}">${t.schema !== 'dbo' ? `<small>${esc(t.schema)}.</small>` : ''}${esc(t.name)}</span><span class="n-rows">${t.kind === 'view' ? 'VIEW' : rows}</span></div>
      ${cols}${more}</div>`;
  }

  // Ankerpunkt (y) einer Spalte innerhalb der Tabelle
  function colY(t, colName) {
    const idx = shownColumns(t).list.findIndex(c => c.name === colName);
    return idx < 0 ? HEAD_H / 2 : HEAD_H + idx * ROW_H + ROW_H / 2;
  }

  function edgeGeometry(r) {
    const a = S.byId.get(r.from), b = S.byId.get(r.to);   // a = Kind (FK), b = Eltern (PK)
    const pa = S.pos[r.from], pb = S.pos[r.to];
    const ya = pa.y + colY(a, r.fromCols[0]), yb = pb.y + colY(b, r.toCols[0]);
    if (r.from === r.to) {
      const x = pa.x + NODE_W, d = 40 + Math.abs(ya - yb) * 0.15;
      return { d: `M${x},${ya} C${x + d},${ya} ${x + d},${yb} ${x},${yb}`, ax: x, ay: ya, adir: 1, bx: x, by: yb, bdir: 1 };
    }
    const ca = pa.x + NODE_W / 2, cb = pb.x + NODE_W / 2;
    let ax, bx, adir, bdir;
    if (Math.abs(ca - cb) < NODE_W * 0.6) { ax = pa.x + NODE_W; bx = pb.x + NODE_W; adir = 1; bdir = 1; }
    else if (ca < cb) { ax = pa.x + NODE_W; bx = pb.x; adir = 1; bdir = -1; }
    else { ax = pa.x; bx = pb.x + NODE_W; adir = -1; bdir = 1; }
    const k = Math.max(50, Math.min(160, Math.abs(bx - ax) * 0.45));
    return { d: `M${ax},${ya} C${ax + adir * k},${ya} ${bx + bdir * k},${yb} ${bx},${yb}`, ax, ay: ya, adir, bx, by: yb, bdir };
  }

  // Krähenfuß (n-Seite) und Strich (1-Seite)
  const crowFoot = (x, y, dir) => `M${x + dir * 12},${y} L${x},${y - 6} M${x + dir * 12},${y} L${x},${y} M${x + dir * 12},${y} L${x},${y + 6} M${x + dir * 15},${y - 6} L${x + dir * 15},${y + 6}`;
  const oneMark = (x, y, dir) => `M${x + dir * 8},${y - 6} L${x + dir * 8},${y + 6} M${x + dir * 13},${y - 6} L${x + dir * 13},${y + 6}`;

  function renderEdges() {
    const vis = new Set(visibleTables().map(t => t.id));
    const rels = S.schema.relations.filter(r => vis.has(r.from) && vis.has(r.to));
    let out = '';
    for (const r of rels) {
      const g = edgeGeometry(r);
      out += `<g data-rel="${esc(r.name)}" data-from="${r.from}" data-to="${r.to}"><title>${esc(r.name)}</title>
        <path class="e" d="${g.d}"/>
        <path class="mk" d="${crowFoot(g.ax, g.ay, g.adir)}"/>
        <path class="mk" d="${oneMark(g.bx, g.by, g.bdir)}"/></g>`;
    }
    edgesEl.innerHTML = out;
  }

  function updateEdgesFor(id) {
    for (const g of edgesEl.querySelectorAll(`g[data-from="${id}"], g[data-to="${id}"]`)) {
      const r = S.schema.relations.find(x => x.name === g.dataset.rel);
      const geo = edgeGeometry(r), [e, m1, m2] = g.querySelectorAll('path');
      e.setAttribute('d', geo.d);
      m1.setAttribute('d', crowFoot(geo.ax, geo.ay, geo.adir));
      m2.setAttribute('d', oneMark(geo.bx, geo.by, geo.bdir));
    }
  }

  function updateStats(tables) {
    const t = tables.filter(x => x.kind === 'table').length, v = tables.length - t;
    const vis = new Set(tables.map(x => x.id));
    const r = S.schema.relations.filter(x => vis.has(x.from) && vis.has(x.to)).length;
    $('stats').textContent = `${t} Tabellen${v ? ` · ${v} Views` : ''} · ${r} Beziehungen`;
  }

  // ---------- Seitenliste & Suche ----------
  function matches(t) {
    const q = S.query;
    if (!q) return false;
    return t.name.toLowerCase().includes(q) || `${t.schema}.${t.name}`.toLowerCase().includes(q) ||
      t.columns.some(c => c.name.toLowerCase().includes(q));
  }

  function renderList() {
    const tables = visibleTables().filter(t => !S.query || matches(t));
    let html = '', last = null;
    for (const t of tables) {
      if (t.schema !== last) { html += `<div class="tl-schema">${esc(t.schema)}</div>`; last = t.schema; }
      html += `<div class="tl-item ${t.kind} ${S.selected === t.id ? 'sel' : ''}" data-id="${t.id}">
        <span class="nm">${esc(t.name)}</span><span class="muted">${t.columns.length}</span></div>`;
    }
    $('tableList').innerHTML = html || '<p class="muted" style="padding:8px">Keine Treffer</p>';
  }
  $('tableList').addEventListener('click', e => {
    const it = e.target.closest('.tl-item'); if (it) { select(it.dataset.id); centerOn(it.dataset.id); }
  });

  let searchT;
  $('search').addEventListener('input', e => {
    clearTimeout(searchT);
    searchT = setTimeout(() => { S.query = e.target.value.trim().toLowerCase(); renderList(); applyHighlight(); }, 120);
  });
  $('search').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const first = visibleTables().find(matches);
      if (first) { select(first.id); centerOn(first.id); }
    }
  });

  // ---------- Optionen ----------
  $('optViews').onchange = e => { S.opt.views = e.target.checked; render(); };
  $('optKeysOnly').onchange = e => { S.opt.keysOnly = e.target.checked; render(); };
  $('optIsolated').onchange = e => { S.opt.isolated = e.target.checked; render(); };
  document.querySelectorAll('[data-layout]').forEach(b => b.onclick = () => {
    S.dir = b.dataset.layout; setLayoutButtons(); autoLayout(visibleTables()); render(true);
  });
  function setLayoutButtons() { document.querySelectorAll('[data-layout]').forEach(b => b.classList.toggle('active', b.dataset.layout === S.dir)); }
  $('fitBtn').onclick = fitView;

  // ---------- Auswahl & Hervorhebung ----------
  function select(id) {
    S.selected = id; applyHighlight(); renderList();
    if (id) openDetails(S.byId.get(id)); else closeDetails();
  }

  function applyHighlight() {
    const sel = S.selected;
    const nb = new Set();
    if (sel) {
      nb.add(sel);
      S.schema.relations.forEach(r => { if (r.from === sel) nb.add(r.to); if (r.to === sel) nb.add(r.from); });
    }
    for (const n of nodesEl.children) {
      const id = n.dataset.id, t = S.byId.get(id);
      n.classList.toggle('sel', id === sel);
      n.classList.toggle('dim', !!sel && !nb.has(id));
      n.classList.toggle('match', !!S.query && matches(t) && id !== sel);
      n.querySelectorAll('.n-col').forEach(c => c.classList.toggle('hl', !!S.query && c.dataset.col.toLowerCase().includes(S.query)));
    }
    for (const g of [...edgesEl.children]) {
      const on = sel && (g.dataset.from === sel || g.dataset.to === sel);
      g.querySelectorAll('path').forEach(p => { p.classList.toggle('hl', !!on); p.classList.toggle('dim', !!sel && !on); });
      if (on) edgesEl.appendChild(g);  // nach vorn
    }
  }

  // ---------- Detailansicht ----------
  function openDetails(t) {
    $('details').classList.remove('hidden');
    $('dSchema').textContent = t.schema + (t.kind === 'view' ? ' · View' : '');
    $('dName').textContent = t.name;
    $('dMeta').textContent = `${t.columns.length} Spalten` + (t.rows != null ? ` · ${t.rows.toLocaleString('de-DE')} Zeilen` : '');
    $('dCols').innerHTML = t.columns.map(c => `<tr>
      <td>${esc(c.name)}${c.pk ? '<span class="tag pk">PK</span>' : ''}${c.fk ? '<span class="tag fk">FK</span>' : ''}${c.identity ? '<span class="tag id">IDENTITY</span>' : ''}</td>
      <td class="t">${esc(c.type)}${c.nullable ? ' NULL' : ' NOT NULL'}${c.default ? `<br>= ${esc(c.default)}` : ''}</td></tr>`).join('');
    const out = S.schema.relations.filter(r => r.from === t.id), inc = S.schema.relations.filter(r => r.to === t.id && r.from !== t.id);
    const li = (r, other, dir) => {
      const o = S.byId.get(other) || { schema: '?', name: other };
      return `<li data-goto="${other}"><div class="dir">${dir}</div><strong>${esc(o.schema)}.${esc(o.name)}</strong><br>
        <code>${esc((dir.startsWith('ver') ? r.fromCols : r.toCols).join(', '))} → ${esc((dir.startsWith('ver') ? r.toCols : r.fromCols).join(', '))}</code>
        <div class="dir">${esc(r.name)}${r.onDelete !== 'NO_ACTION' ? ` · ON DELETE ${esc(r.onDelete)}` : ''}</div></li>`;
    };
    $('dRels').innerHTML = out.map(r => li(r, r.to, 'verweist auf')).join('') + inc.map(r => li(r, r.from, 'wird referenziert von')).join('')
      || '<li class="muted" style="cursor:default">Keine Fremdschlüssel</li>';
  }
  function closeDetails() { $('details').classList.add('hidden'); }
  $('dClose').onclick = () => select(null);
  $('dRels').addEventListener('click', e => {
    const li = e.target.closest('[data-goto]'); if (!li) return;
    const id = li.dataset.goto, t = S.byId.get(id);
    if (t.kind === 'view' && !S.opt.views) { S.opt.views = true; $('optViews').checked = true; render(); }
    select(id); centerOn(id);
  });

  // ---------- Datenvorschau ----------
  $('previewBtn').onclick = async () => {
    const t = S.byId.get(S.selected); if (!t) return;
    $('pvTitle').textContent = `${t.schema}.${t.name} – erste 100 Zeilen`;
    $('pvBody').innerHTML = '<p class="muted" style="padding:16px">Lade …</p>';
    $('previewDlg').showModal();
    try {
      const d = await api(`/api/preview?db=${encodeURIComponent(S.db)}&id=${t.id}&top=100`);
      if (!d.rows.length) { $('pvBody').innerHTML = '<p class="muted" style="padding:16px">Keine Daten vorhanden.</p>'; return; }
      $('pvBody').innerHTML = `<table class="grid"><thead><tr>${d.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
        d.rows.map(r => `<tr>${r.map(v => v == null ? '<td class="null">NULL</td>' : `<td title="${esc(v)}">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    } catch (err) { $('pvBody').innerHTML = `<p class="error" style="margin:16px">${esc(err.message)}</p>`; }
  };

  // ---------- Zoom & Pan ----------
  function applyTransform() {
    world.style.transform = `translate(${S.tx}px,${S.ty}px) scale(${S.scale})`;
    vp.style.backgroundSize = `${22 * S.scale}px ${22 * S.scale}px`;
    vp.style.backgroundPosition = `${S.tx}px ${S.ty}px`;
    $('zoomLbl').textContent = Math.round(S.scale * 100) + '%';
  }
  function zoomAt(f, cx, cy) {
    const ns = Math.min(2.5, Math.max(0.1, S.scale * f));
    S.tx = cx - (cx - S.tx) * (ns / S.scale); S.ty = cy - (cy - S.ty) * (ns / S.scale); S.scale = ns;
    applyTransform();
  }
  function bounds() {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const t of visibleTables()) {
      const p = S.pos[t.id]; if (!p) continue;
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x + NODE_W); y2 = Math.max(y2, p.y + nodeHeight(t));
    }
    return x1 === Infinity ? null : { x1, y1, x2, y2 };
  }
  function fitView() {
    const b = bounds(); if (!b) return;
    const w = vp.clientWidth, h = vp.clientHeight, pad = 40;
    S.scale = Math.min(1.2, Math.max(0.1, Math.min((w - pad * 2) / (b.x2 - b.x1), (h - pad * 2) / (b.y2 - b.y1))));
    S.tx = (w - (b.x2 - b.x1) * S.scale) / 2 - b.x1 * S.scale;
    S.ty = (h - (b.y2 - b.y1) * S.scale) / 2 - b.y1 * S.scale;
    applyTransform();
  }
  function centerOn(id) {
    const p = S.pos[id], t = S.byId.get(id); if (!p) return;
    if (S.scale < 0.6) S.scale = 0.8;
    S.tx = vp.clientWidth / 2 - (p.x + NODE_W / 2) * S.scale;
    S.ty = vp.clientHeight / 2 - (p.y + Math.min(nodeHeight(t), 300) / 2) * S.scale;
    world.style.transition = 'transform .3s'; applyTransform();
    setTimeout(() => world.style.transition = '', 320);
  }
  $('zoomIn').onclick = () => zoomAt(1.2, vp.clientWidth / 2, vp.clientHeight / 2);
  $('zoomOut').onclick = () => zoomAt(1 / 1.2, vp.clientWidth / 2, vp.clientHeight / 2);
  vp.addEventListener('wheel', e => {
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    else { S.tx -= e.deltaX; S.ty -= e.deltaY; applyTransform(); }
  }, { passive: false });

  // Pan (Hintergrund) und Tabellen ziehen (Kopfzeile)
  let drag = null;
  vp.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const head = e.target.closest('.n-head'), node = e.target.closest('.node');
    if (node) {
      const id = node.dataset.id;
      drag = { type: head ? 'node' : 'click', id, el: node, sx: e.clientX, sy: e.clientY, ox: S.pos[id].x, oy: S.pos[id].y, moved: false };
    } else {
      drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: S.tx, oy: S.ty, moved: false };
      vp.classList.add('panning');
    }
    vp.setPointerCapture(e.pointerId);
  });
  vp.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.type === 'pan') { S.tx = drag.ox + dx; S.ty = drag.oy + dy; applyTransform(); }
    else if (drag.type === 'node' && drag.moved) {
      const p = S.pos[drag.id];
      p.x = Math.round(drag.ox + dx / S.scale); p.y = Math.round(drag.oy + dy / S.scale);
      drag.el.style.left = p.x + 'px'; drag.el.style.top = p.y + 'px';
      updateEdgesFor(drag.id);
    }
  });
  vp.addEventListener('pointerup', () => {
    if (!drag) return;
    vp.classList.remove('panning');
    if (!drag.moved) {
      if (drag.type === 'pan') select(null);
      else select(drag.id === S.selected ? null : drag.id);
    } else if (drag.type === 'node') savePos();
    drag = null;
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('previewDlg').open) select(null);
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('search').focus(); }
  });

  // ---------- SVG-Export ----------
  $('exportBtn').onclick = () => {
    const b = bounds(); if (!b) return;
    const pad = 30, W = b.x2 - b.x1 + pad * 2, H = b.y2 - b.y1 + pad * 2, ox = pad - b.x1, oy = pad - b.y1;
    const trunc = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif" font-size="12">
<rect width="100%" height="100%" fill="#ffffff"/><g transform="translate(${ox},${oy})">`;
    for (const g of edgesEl.children) for (const p of g.querySelectorAll('path')) s += `<path d="${p.getAttribute('d')}" fill="none" stroke="#8a94a6" stroke-width="1.4"/>`;
    for (const t of visibleTables()) {
      const p = S.pos[t.id], h = nodeHeight(t), sc = shownColumns(t), col = t.kind === 'view' ? '#7a4fc4' : '#2f6fdb';
      s += `<g transform="translate(${p.x},${p.y})"><rect width="${NODE_W}" height="${h}" rx="6" fill="#fff" stroke="#c9ced6"/>
        <rect width="${NODE_W}" height="${HEAD_H}" rx="6" fill="${col}" fill-opacity=".1"/><rect width="${NODE_W}" height="3" fill="${col}"/>
        <text x="10" y="22" font-weight="600" fill="#1c2330">${esc(trunc((t.schema !== 'dbo' ? t.schema + '.' : '') + t.name, 32))}</text>`;
      sc.list.forEach((c, i) => {
        const y = HEAD_H + i * ROW_H + 15;
        s += `<text x="10" y="${y}" font-size="9.5" font-weight="700" fill="${c.pk ? '#b7791f' : '#2f6fdb'}">${c.pk ? 'PK' : c.fk ? 'FK' : ''}</text>
          <text x="36" y="${y}" fill="#1c2330">${esc(trunc(c.name, 22))}</text>
          <text x="${NODE_W - 10}" y="${y}" text-anchor="end" font-family="Consolas, monospace" font-size="11" fill="#6b7484">${esc(trunc(c.type, 16))}</text>`;
      });
      if (sc.hidden) s += `<text x="10" y="${HEAD_H + sc.list.length * ROW_H + 15}" font-style="italic" fill="#6b7484">… ${sc.hidden} weitere Spalten</text>`;
      s += '</g>';
    }
    s += '</g></svg>';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' }));
    a.download = `${S.db}-schema.svg`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // ---------- Init ----------
  api('/api/me').then(startApp).catch(showLogin);
})();
