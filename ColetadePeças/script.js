/* Inventário da Sala de Robótica – SENAI
 * Catálogo oficial: data.json (publicado no GitHub Pages)
 * Alterações feitas no aparelho ficam no localStorage até serem exportadas/publicadas.
 */
(() => {
  'use strict';

  // ---------- utilidades ----------
  const LS_KEY = 'inventario-robotica-v1';
  const LS_BACKUP = 'inventario-robotica-v1-backup';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const now = () => new Date().toISOString();
  const clone = o => JSON.parse(JSON.stringify(o));
  const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
  const STATUS_TXT = { pendente: 'Pendente', conferida: 'Conferida', divergente: 'Divergente' };

  let state = emptyState();   // dados de trabalho
  let base = null;            // "atualizadoEm" do data.json publicado em que estes dados se baseiam
  let dirty = false;          // há alterações ainda não publicadas?
  let remote = null;          // último data.json publicado lido da rede
  let view = 'local';
  let editingCode = null;     // código original da peça em edição (null = nova)
  let codigoTocado = false;

  // --- modo planilha (Google Sheets via Apps Script) ---
  const CFG = window.INVENTARIO_CONFIG || {};
  const SYNC = !!CFG.apiUrl;
  const SENHA_KEY = 'inventario-senha-v1';
  let lastSynced = { pecas: [], locais: [], categorias: [] }; // último estado confirmado pela planilha
  let rev = 0, syncing = false, syncTimer = null, syncState = 'ok', lastOkAt = null, skipTyped = null;

  function emptyState() {
    return {
      versao: 1, atualizadoEm: now(), urlSite: '',
      locais: [], categorias: [{ nome: 'Outros', prefixo: 'OUT' }], pecas: []
    };
  }

  // ---------- persistência ----------
  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ data: state, base, dirty, lastSynced })); }
    catch (e) { toast('Atenção: não foi possível salvar neste navegador (modo privado?). Baixe o data.json para não perder dados.'); }
  }
  function touch() { state.atualizadoEm = now(); dirty = true; rev++; persist(); render(); if (SYNC) scheduleSync(600); }
  function backup() {
    try { localStorage.setItem(LS_BACKUP, JSON.stringify({ data: state, base, dirty })); } catch (e) { /* ignora */ }
  }

  // ---------- modelo ----------
  const find = code => state.pecas.find(p => norm(p.codigo) === norm(code));
  const statusOf = p => p.contada == null ? 'pendente' : (p.contada === p.quantidade ? 'conferida' : 'divergente');
  const toInt = v => { const n = parseInt(String(v).trim(), 10); return Number.isFinite(n) && n >= 0 ? n : null; };

  function makePrefix(nome) {
    return norm(nome).replace(/[^a-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X');
  }
  function ensureLocal(nome) {
    nome = String(nome ?? '').trim().replace(/\s*[>›]\s*/g, ' > ');
    if (!nome) return '';
    const ex = state.locais.find(l => norm(l) === norm(nome));
    if (ex) return ex;
    state.locais.push(nome);
    return nome;
  }
  function ensureCategoria(nome, prefixo) {
    nome = String(nome ?? '').trim();
    if (!nome) return 'Outros';
    const ex = state.categorias.find(c => norm(c.nome) === norm(nome));
    if (ex) return ex.nome;
    state.categorias.push({ nome, prefixo: (prefixo || makePrefix(nome)).toUpperCase() });
    return nome;
  }
  function prefixOf(catNome) {
    const c = state.categorias.find(c => norm(c.nome) === norm(catNome));
    return c ? c.prefixo : makePrefix(catNome);
  }
  function nextCode(prefixo) {
    let max = 0;
    const re = new RegExp('^' + prefixo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)$', 'i');
    state.pecas.forEach(p => { const m = re.exec(p.codigo); if (m) max = Math.max(max, parseInt(m[1], 10)); });
    return prefixo + '-' + String(max + 1).padStart(3, '0');
  }
  function cleanPiece(p) {
    return {
      codigo: String(p.codigo ?? '').trim(),
      nome: String(p.nome ?? '').trim(),
      quantidade: toInt(p.quantidade) ?? 0,
      local: ensureLocal(p.local) || '(sem local)',
      categoria: ensureCategoria(p.categoria),
      obs: String(p.obs ?? '').trim(),
      contada: p.contada == null || p.contada === '' ? null : toInt(p.contada),
      contadaEm: p.contadaEm || null,
      editadoEm: p.editadoEm || null
    };
  }

  // Mescla outro catálogo neste: por peça, vale a alteração mais recente.
  function mergeData(inc) {
    let add = 0, upd = 0;
    (inc.locais || []).forEach(ensureLocal);
    (inc.categorias || []).forEach(c => ensureCategoria(c.nome, c.prefixo));
    for (const raw of inc.pecas || []) {
      const ip = cleanPiece(raw);
      if (!ip.codigo) continue;
      const p = find(ip.codigo);
      if (!p) { state.pecas.push(ip); add++; continue; }
      let changed = false;
      if ((ip.editadoEm || '') > (p.editadoEm || '')) {
        ['nome', 'quantidade', 'local', 'categoria', 'obs'].forEach(f => { p[f] = ip[f]; });
        p.editadoEm = ip.editadoEm; changed = true;
      }
      if ((ip.contadaEm || '') > (p.contadaEm || '')) {
        p.contada = ip.contada; p.contadaEm = ip.contadaEm; changed = true;
      }
      if (changed) upd++;
    }
    return { add, upd };
  }

  // ---------- carregamento ----------
  async function init() {
    document.querySelectorAll('[data-sync-only]').forEach(b => { b.hidden = !SYNC; });
    document.querySelectorAll('.ajuda-sync').forEach(b => { b.hidden = !SYNC; });
    document.querySelectorAll('.ajuda-legacy').forEach(b => { b.hidden = SYNC; });
    try { remote = await (await fetch('data.json', { cache: 'no-store' })).json(); } catch (e) { remote = null; }

    if (SYNC) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { /* ignora */ }
      if (saved && saved.data && Array.isArray(saved.data.pecas)) {
        state = saved.data;
        if (saved.lastSynced) lastSynced = saved.lastSynced;
      }
      render();
      const ok = await syncNow(true);
      if (ok && state.pecas.length === 0 && remote && remote.pecas && remote.pecas.length) {
        let recusou = false;
        try { recusou = !!localStorage.getItem('inventario-oferta-recusada'); } catch (e) { /* ignora */ }
        if (!recusou) {
          if (confirm(`A planilha está vazia. Enviar para ela as ${remote.pecas.length} peça(s) do data.json?`)) {
            const u = state.urlSite; state = normalizeState(remote); state.urlSite = u; touch();
          } else { try { localStorage.setItem('inventario-oferta-recusada', '1'); } catch (e) { /* ignora */ } }
        }
      }
      startSyncLoops();
      handleHash();
      return;
    }

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { /* ignora */ }

    if (saved && saved.data && Array.isArray(saved.data.pecas)) {
      state = saved.data; base = saved.base; dirty = !!saved.dirty;
      if (dirty && remote && remote.atualizadoEm === state.atualizadoEm) { dirty = false; base = remote.atualizadoEm; }
      if (!dirty && remote && remote.atualizadoEm !== base) { state = normalizeState(remote); base = remote.atualizadoEm; }
    } else if (remote) {
      state = normalizeState(remote); base = remote.atualizadoEm; dirty = false;
    } else {
      toast('Não foi possível ler o data.json. Abra o site pelo link do GitHub Pages (não direto do arquivo).');
    }
    persist();
    render();
    handleHash();
  }
  function normalizeState(d) {
    const s = emptyState();
    s.atualizadoEm = d.atualizadoEm || now();
    s.urlSite = d.urlSite || '';
    state = s; // ensure* funcionam sobre "state"
    (d.categorias || []).forEach(c => ensureCategoria(c.nome, c.prefixo));
    (d.locais || []).forEach(ensureLocal);
    s.pecas = (d.pecas || []).map(cleanPiece).filter(p => p.codigo);
    return s;
  }

  // ---------- filtros ----------
  function filtered() {
    const terms = norm($('#busca').value).split(/\s+/).filter(Boolean);
    const fl = $('#fLocal').value, fc = $('#fCat').value, fs = $('#fStatus').value;
    return state.pecas.filter(p => {
      if (fl && !(p.local === fl || p.local.startsWith(fl + ' > '))) return false;
      if (fc && p.categoria !== fc) return false;
      if (fs && statusOf(p) !== fs) return false;
      if (terms.length) {
        const hay = norm([p.codigo, p.nome, p.categoria, p.local, p.obs].join(' | '));
        if (!terms.every(t => hay.includes(t))) return false;
      }
      return true;
    }).sort((a, b) => collator.compare(a.codigo, b.codigo));
  }

  // ---------- renderização ----------
  function fillSelect(sel, items, firstLabel, keep = true) {
    const cur = sel.value;
    sel.innerHTML = (firstLabel != null ? `<option value="">${esc(firstLabel)}</option>` : '') +
      items.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if (keep && items.includes(cur)) sel.value = cur;
  }

  function render() {
    // filtros
    const locais = [...state.locais].sort(collator.compare);
    fillSelect($('#fLocal'), locais, 'Todos os locais');
    fillSelect($('#fCat'), state.categorias.map(c => c.nome).sort(collator.compare), 'Todas as categorias');

    // resumo
    const all = state.pecas;
    const ok = all.filter(p => statusOf(p) === 'conferida').length;
    const dv = all.filter(p => statusOf(p) === 'divergente').length;
    const pend = all.length - ok - dv;
    const pct = all.length ? Math.round(((ok + dv) / all.length) * 100) : 0;
    $('#sTipos').textContent = all.length;
    $('#sUn').textContent = all.reduce((s, p) => s + p.quantidade, 0);
    $('#sOk').textContent = ok;
    $('#sDiv').textContent = dv;
    $('#sPct').textContent = pct + '%';
    $('#barOk').style.width = (all.length ? ok / all.length * 100 : 0) + '%';
    $('#barDiv').style.width = (all.length ? dv / all.length * 100 : 0) + '%';
    $('#sPend').textContent = `${pend} pendente(s) · ${ok} conferida(s) · ${dv} divergente(s)`;

    // guarda contagens digitadas e ainda não salvas (a tela é redesenhada ao sincronizar)
    const typed = {};
    document.querySelectorAll('#lista .card').forEach(c => {
      const i = c.querySelector('.count-row input');
      if (i && i.value !== i.defaultValue) typed[c.dataset.code] = i.value;
    });

    // lista
    const list = filtered();
    $('#info').textContent = all.length === 0 ? '' : `${list.length} de ${all.length} peça(s)`;
    const box = $('#lista');
    if (!list.length) {
      box.innerHTML = `<div class="vazio">${all.length ? 'Nenhuma peça encontrada com esses filtros.' : 'Nenhuma peça cadastrada ainda. Toque em “+ Nova peça”.'}</div>`;
    } else if (view === 'local') {
      const groups = new Map();
      list.forEach(p => { if (!groups.has(p.local)) groups.set(p.local, []); groups.get(p.local).push(p); });
      box.innerHTML = [...groups.keys()].sort(collator.compare).map(loc => {
        const items = groups.get(loc);
        const feitas = items.filter(p => p.contada != null).length;
        return `<section class="grupo"><h2><span>${esc(loc.replace(/ > /g, ' › '))}</span><small>${feitas}/${items.length} contadas</small></h2>
          <div class="cards">${items.map(cardHtml).join('')}</div></section>`;
      }).join('');
    } else {
      box.innerHTML = `<div class="cards">${list.map(cardHtml).join('')}</div>`;
    }
    document.querySelectorAll('#lista .card').forEach(c => {
      const code = c.dataset.code;
      if (code in typed && code !== skipTyped) c.querySelector('.count-row input').value = typed[code];
    });
    skipTyped = null;
    $('#mnDesfazer').disabled = !hasBackup();
    renderBanner();
    updateStatus();
  }

  function cardHtml(p) {
    const st = statusOf(p);
    return `<article class="card s-${st}" data-code="${esc(p.codigo)}">
      <div class="card-top"><span class="code">${esc(p.codigo)}</span><span class="badge">${STATUS_TXT[st]}</span></div>
      <h3>${esc(p.nome)}</h3>
      <p class="meta">${esc(p.categoria)} · ${esc(p.local.replace(/ > /g, ' › '))}</p>
      <div class="qty">Esperado: <b>${p.quantidade}</b></div>
      <div class="count-row">
        <input type="number" min="0" step="1" inputmode="numeric" placeholder="Contado" aria-label="Quantidade contada de ${esc(p.codigo)}" value="${p.contada ?? ''}">
        <button class="btn small" type="button" data-act="save">Salvar</button>
        <button class="btn small" type="button" data-act="ok" title="A quantidade contada bate com a esperada">✓ Bate</button>
      </div>
      <div class="actions">
        <button class="btn small" type="button" data-act="detail">Detalhes</button>
        <button class="btn small" type="button" data-act="edit">Editar</button>
      </div>
    </article>`;
  }

  function renderBanner() {
    const el = $('#banner');
    if (SYNC) { el.hidden = true; return; } // no modo planilha o estado aparece no topo
    let html = '';
    if (dirty && remote && remote.atualizadoEm !== base && remote.atualizadoEm !== state.atualizadoEm) {
      html = `<div class="banner-in"><span><b>O catálogo publicado mudou</b> e você também tem alterações neste aparelho. Junte as duas versões para não perder nada.</span>
        <button class="btn small" data-b="merge" type="button">Mesclar com o publicado</button></div>`;
      el.className = 'banner';
    } else if (dirty) {
      html = `<div class="banner-in"><span><b>Alterações só neste aparelho.</b> O grupo só vai ver depois que o <code>data.json</code> atualizado for publicado.</span>
        <button class="btn small" data-b="json" type="button">Baixar data.json</button>
        <button class="btn small ghost" data-b="descartar" type="button">Descartar alterações</button></div>`;
      el.className = 'banner';
    }
    el.hidden = !html;
    el.innerHTML = html;
  }

  // ---------- ações em peças ----------
  function setCount(code, val) {
    const p = find(code); if (!p) return;
    const n = (val === '' || val == null) ? null : toInt(val);
    if (val !== '' && val != null && n == null) { toast('Digite um número inteiro (0 ou mais).'); return; }
    p.contada = n; p.contadaEm = now(); // mesmo ao zerar, registra o momento (para a mesclagem)
    skipTyped = code;
    touch();
    toast(n == null ? 'Contagem removida.' : `${p.codigo}: contado ${n} — ${STATUS_TXT[statusOf(p)].toLowerCase()}.`);
  }

  function deletePiece(code) {
    const p = find(code); if (!p) return;
    if (!confirm(`Excluir a peça ${p.codigo} — ${p.nome}?\n\nEssa ação não pode ser desfeita neste aparelho.`)) return;
    state.pecas = state.pecas.filter(x => x !== p);
    $('#dlgDetalhe').close();
    touch(); toast('Peça excluída.');
  }

  // ---------- formulário ----------
  const NOVO = '__novo__';
  function openForm(code) {
    editingCode = code || null;
    const p = code ? find(code) : null;
    $('#tituloPeca').textContent = p ? 'Editar peça' : 'Nova peça';
    $('#erroPeca').hidden = true;
    fillSelect($('#pCat'), state.categorias.map(c => c.nome), null, false);
    $('#pCat').insertAdjacentHTML('beforeend', `<option value="${NOVO}">+ Nova categoria…</option>`);
    fillSelect($('#pLocal'), [...state.locais].sort(collator.compare), null, false);
    $('#pLocal').insertAdjacentHTML('beforeend', `<option value="${NOVO}">+ Novo local…</option>`);
    if (p) {
      $('#pCat').value = p.categoria; $('#pLocal').value = p.local;
      $('#pCodigo').value = p.codigo; $('#pNome').value = p.nome;
      $('#pQtd').value = p.quantidade; $('#pObs').value = p.obs;
      codigoTocado = true;
    } else {
      const fc = $('#fCat').value || state.categorias[0]?.nome;
      $('#pCat').value = fc; $('#pLocal').value = $('#fLocal').value || state.locais[0] || '';
      $('#pNome').value = ''; $('#pQtd').value = 0; $('#pObs').value = '';
      $('#pCodigo').value = fc ? nextCode(prefixOf(fc)) : '';
      codigoTocado = false;
    }
    $('#dlgDetalhe').close();
    $('#dlgPeca').showModal();
    $('#pNome').focus();
  }

  function onSelectNovo(sel, tipo) {
    if (sel.value !== NOVO) return false;
    if (tipo === 'cat') {
      const nome = (prompt('Nome da nova categoria:') || '').trim();
      if (nome) {
        const pref = (prompt('Prefixo do código (3 letras):', makePrefix(nome)) || makePrefix(nome)).trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || makePrefix(nome);
        const real = ensureCategoria(nome, pref);
        sel.insertAdjacentHTML('afterbegin', `<option value="${esc(real)}">${esc(real)}</option>`);
        sel.value = real;
      } else sel.selectedIndex = 0;
    } else {
      const nome = (prompt('Nome do novo local (use > para sub-local, ex.: Armário 03 > Gaveta 01):') || '').trim();
      if (nome) {
        const real = ensureLocal(nome);
        if (![...sel.options].some(o => o.value === real)) sel.insertAdjacentHTML('afterbegin', `<option value="${esc(real)}">${esc(real)}</option>`);
        sel.value = real;
      } else sel.selectedIndex = 0;
    }
    return true;
  }

  function submitForm(ev) {
    ev.preventDefault();
    const err = msg => { const e = $('#erroPeca'); e.textContent = msg; e.hidden = false; };
    const codigo = $('#pCodigo').value.trim().toUpperCase().replace(/\s+/g, '-');
    const nome = $('#pNome').value.trim();
    const qtd = toInt($('#pQtd').value);
    if (!codigo || !nome) return err('Preencha código e nome.');
    if (qtd == null) return err('A quantidade deve ser um número inteiro (0 ou mais).');
    const dup = find(codigo);
    if (dup && norm(dup.codigo) !== norm(editingCode || '')) return err(`O código ${codigo} já existe (${dup.nome}). Use outro código.`);
    if ($('#pCat').value === NOVO || $('#pLocal').value === NOVO) return err('Escolha a categoria e o local.');
    const dados = { nome, quantidade: qtd, local: $('#pLocal').value, categoria: $('#pCat').value, obs: $('#pObs').value.trim() };
    if (editingCode) {
      const p = find(editingCode);
      Object.assign(p, dados, { codigo, editadoEm: now() });
    } else {
      state.pecas.push({ codigo, ...dados, contada: null, contadaEm: null, editadoEm: now() });
    }
    $('#dlgPeca').close();
    touch();
    toast(editingCode ? 'Peça atualizada.' : 'Peça cadastrada.');
  }

  // ---------- QR e etiquetas ----------
  function siteBase() {
    const u = (state.urlSite || '').trim();
    return u ? u.replace(/#.*$/, '') : location.origin + location.pathname;
  }
  function pieceUrl(code) { return siteBase() + '#/peca/' + encodeURIComponent(code); }
  function qrSvg(text) {
    try {
      const q = new QRCodeLib(-1, 0); // tipo automático, correção nível M
      q.addData(text); q.make();
      const n = q.getModuleCount(); let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
    } catch (e) { return ''; }
  }
  function printLabels(list) {
    if (!list.length) { toast('Nenhuma peça para imprimir.'); return; }
    if (list.length > 60 && !confirm(`Imprimir ${list.length} etiquetas?`)) return;
    $('#printArea').innerHTML = list.map(p => `<div class="etq"><div class="q">${qrSvg(pieceUrl(p.codigo))}</div>
      <div class="t"><div class="c">${esc(p.codigo)}</div><div class="n">${esc(p.nome)}</div><div class="l">${esc(p.local.replace(/ > /g, ' › '))}</div></div></div>`).join('');
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 60);
  }

  // ---------- detalhes ----------
  function openDetail(code) {
    const p = find(code); if (!p) { toast('Peça não encontrada: ' + code); return; }
    const st = statusOf(p);
    $('#detalheBody').innerHTML = `
      <div class="det-head">
        <div class="qr" title="Aponte a câmera do celular">${qrSvg(pieceUrl(p.codigo))}</div>
        <div>
          <span class="code">${esc(p.codigo)}</span> <span class="badge">${STATUS_TXT[st]}</span>
          <h2 style="margin:6px 0 0">${esc(p.nome)}</h2>
        </div>
      </div>
      <dl class="det-list">
        <dt>Categoria</dt><dd>${esc(p.categoria)}</dd>
        <dt>Local</dt><dd>${esc(p.local.replace(/ > /g, ' › '))}</dd>
        <dt>Esperado</dt><dd><b>${p.quantidade}</b></dd>
        <dt>Contado</dt><dd>${p.contada == null ? '—' : p.contada}${p.contada != null && p.contadaEm ? ` <small class="muted">(${new Date(p.contadaEm).toLocaleString('pt-BR')})</small>` : ''}</dd>
        <dt>Observações</dt><dd>${esc(p.obs) || '—'}</dd>
      </dl>
      <div class="count-row" data-code="${esc(p.codigo)}">
        <input type="number" min="0" step="1" inputmode="numeric" placeholder="Contado" value="${p.contada ?? ''}" aria-label="Quantidade contada">
        <button class="btn small" type="button" data-act="dsave">Salvar</button>
        <button class="btn small" type="button" data-act="dok">✓ Bate</button>
        <button class="btn small ghost" type="button" data-act="dreset">Zerar contagem</button>
      </div>
      <div class="dlg-actions" data-code="${esc(p.codigo)}">
        <button class="btn danger small" type="button" data-act="ddel">Excluir</button>
        <button class="btn small" type="button" data-act="dlabel">Etiqueta</button>
        <button class="btn small" type="button" data-act="dedit">Editar</button>
        <button class="btn primary small" type="button" data-close>Fechar</button>
      </div>`;
    if (!$('#dlgDetalhe').open) $('#dlgDetalhe').showModal();
  }
  async function handleHash() {
    const m = /^#\/peca\/(.+)$/.exec(location.hash);
    if (!m) return;
    const code = decodeURIComponent(m[1]);
    if (SYNC && !find(code)) { // peça pode ter sido criada por outra pessoa: busca na planilha antes de desistir
      for (let i = 0; i < 25 && syncing; i++) await new Promise(r => setTimeout(r, 200));
      await syncNow(false);
    }
    openDetail(code);
  }

  // ---------- exportar / importar ----------
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function exportJson() {
    download('data.json', JSON.stringify(state, null, 2), 'application/json');
    toast('data.json baixado. Envie ao responsável ou publique no GitHub.');
  }
  function exportCsv() {
    const q = v => { v = String(v ?? ''); return /[;"\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const head = ['Código', 'Nome', 'Quantidade', 'Local', 'Categoria', 'Observações', 'Contada', 'Status'];
    const rows = [...state.pecas].sort((a, b) => collator.compare(a.local, b.local) || collator.compare(a.codigo, b.codigo))
      .map(p => [p.codigo, p.nome, p.quantidade, p.local, p.categoria, p.obs, p.contada ?? '', STATUS_TXT[statusOf(p)]].map(q).join(';'));
    download('inventario-robotica.csv', '﻿' + [head.join(';'), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
    toast('CSV exportado (abre direto no Excel).');
  }

  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/, 1)[0] || '';
    const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
    const rows = []; let row = [], cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === sep) { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ''));
  }
  const COLS = {
    codigo: 'codigo', nome: 'nome', quantidade: 'quantidade', qtd: 'quantidade',
    local: 'local', localizacao: 'local', categoria: 'categoria',
    observacoes: 'obs', observacao: 'obs', obs: 'obs',
    contada: 'contada', 'quantidade contada': 'contada', contagem: 'contada'
  };
  function importCsv(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error('O CSV está vazio ou só tem o cabeçalho.');
    const idx = {};
    rows[0].forEach((h, i) => { const k = COLS[norm(h)]; if (k && !(k in idx)) idx[k] = i; });
    if (!('nome' in idx)) throw new Error('Não encontrei a coluna “Nome”. Cabeçalho esperado: Código;Nome;Quantidade;Local;Categoria;Observações');
    let add = 0, upd = 0, skip = 0;
    const get = (r, k) => (k in idx ? (r[idx[k]] ?? '').trim() : '');
    for (const r of rows.slice(1)) {
      const nome = get(r, 'nome');
      if (!nome) { skip++; continue; }
      const cat = ensureCategoria(get(r, 'categoria') || 'Outros');
      const local = ensureLocal(get(r, 'local')) || '(sem local)';
      let codigo = get(r, 'codigo').toUpperCase();
      if (!codigo) codigo = nextCode(prefixOf(cat));
      const dados = { nome, quantidade: toInt(get(r, 'quantidade')) ?? 0, local, categoria: cat, obs: get(r, 'obs') };
      const ct = get(r, 'contada');
      const p = find(codigo);
      if (p) { Object.assign(p, dados, { editadoEm: now() }); if (ct !== '') { p.contada = toInt(ct); p.contadaEm = now(); } upd++; }
      else { state.pecas.push({ codigo, ...dados, contada: ct === '' ? null : toInt(ct), contadaEm: ct === '' ? null : now(), editadoEm: now() }); add++; }
    }
    return { add, upd, skip };
  }

  function hasBackup() { try { return !!localStorage.getItem(LS_BACKUP); } catch (e) { return false; } }

  function doImport(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        backup();
        let res;
        if (/\.json$/i.test(file.name) || String(reader.result).trim().startsWith('{')) {
          const inc = JSON.parse(reader.result);
          if (!inc || !Array.isArray(inc.pecas)) throw new Error('Esse JSON não tem a lista “pecas”.');
          res = mergeData(inc);
        } else res = importCsv(String(reader.result));
        touch();
        toast(`Importação concluída: ${res.add} nova(s), ${res.upd} atualizada(s)${res.skip ? `, ${res.skip} linha(s) ignorada(s)` : ''}.`);
      } catch (e) {
        try { const b = JSON.parse(localStorage.getItem(LS_BACKUP)); if (b) { state = b.data; } } catch (x) { /* ignora */ }
        render();
        alert('Não foi possível importar: ' + e.message);
      }
    };
    reader.readAsText(file, 'utf-8');
  }
  function undoImport() {
    try {
      const b = JSON.parse(localStorage.getItem(LS_BACKUP));
      if (!b) return;
      if (!confirm('Voltar ao estado de antes da última importação? Alterações feitas depois dela serão perdidas.')) return;
      state = b.data; base = b.base; dirty = true; localStorage.removeItem(LS_BACKUP);
      persist(); render(); toast('Importação desfeita.');
    } catch (e) { toast('Nada para desfazer.'); }
  }

  // ---------- locais ----------
  function renderLocais() {
    const ul = $('#listaLocais');
    const locais = [...state.locais].sort(collator.compare);
    ul.innerHTML = locais.length ? locais.map(l => {
      const n = state.pecas.filter(p => p.local === l).length;
      return `<li data-local="${esc(l)}"><span>${esc(l.replace(/ > /g, ' › '))} <small>(${n} peça${n === 1 ? '' : 's'})</small></span>
        <button class="btn small" type="button" data-act="renloc">Renomear</button>
        <button class="btn small danger" type="button" data-act="delloc" ${n ? 'disabled title="Há peças neste local"' : ''}>Excluir</button></li>`;
    }).join('') : '<li class="muted">Nenhum local cadastrado.</li>';
  }

  // ---------- sincronização com a planilha ----------
  const pkey = p => [p.codigo, p.nome, p.quantidade, p.local, p.categoria, p.obs, p.contada, p.contadaEm, p.editadoEm].join('\u0001');
  const snap = () => ({ pecas: state.pecas.map(p => ({ ...p })), locais: [...state.locais], categorias: state.categorias.map(c => ({ ...c })) });
  const getSenha = () => { try { return localStorage.getItem(SENHA_KEY) || ''; } catch (e) { return ''; } };

  // O que mudou aqui desde a última confirmação da planilha
  function diff() {
    const lastMap = new Map(lastSynced.pecas.map(p => [p.codigo, pkey(p)]));
    const seen = new Set(), up = [];
    state.pecas.forEach(p => { seen.add(p.codigo); if (lastMap.get(p.codigo) !== pkey(p)) up.push(p); });
    const del = [...lastMap.keys()].filter(c => !seen.has(c));
    const lastL = new Set(lastSynced.locais), curL = new Set(state.locais);
    const addLocais = state.locais.filter(l => !lastL.has(l));
    const delLocais = lastSynced.locais.filter(l => !curL.has(l));
    const lastC = new Set(lastSynced.categorias.map(c => c.nome));
    const addCats = state.categorias.filter(c => !lastC.has(c.nome));
    return { up, del, addLocais, delLocais, addCats, empty: !(up.length || del.length || addLocais.length || delLocais.length || addCats.length) };
  }
  const pendingCount = () => { const d = diff(); return d.up.length + d.del.length + d.addLocais.length + d.delLocais.length + d.addCats.length; };

  async function api(body) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
    try {
      // corpo em texto simples evita o "preflight" de CORS, que o Apps Script não aceita
      const r = await fetch(CFG.apiUrl, { method: 'POST', body: JSON.stringify({ senha: getSenha(), ...body }), signal: ctrl.signal });
      return await r.json();
    } finally { clearTimeout(t); }
  }

  const busyUI = () => !!document.querySelector('dialog[open]') || !!(document.activeElement && document.activeElement.matches && document.activeElement.matches('#lista input'));

  function adopt(res) {
    const sig = s => s.pecas.map(pkey).join('\n') + '|' + [...s.locais].sort().join(',');
    const prev = sig(state), u = state.urlSite, at = state.atualizadoEm;
    state = normalizeState({ pecas: res.pecas, locais: res.locais, categorias: res.categorias, urlSite: u, atualizadoEm: at });
    lastSynced = snap(); dirty = false; persist();
    if (sig(state) !== prev) render();
  }

  async function syncNow(manual) {
    if (!SYNC || syncing) return false;
    if (!getSenha()) {
      if (!manual) { syncState = 'senha'; updateStatus(); return false; }
      const s = prompt('Digite a senha do grupo (a mesma que está no script da planilha):');
      if (!s) { syncState = 'senha'; updateStatus(); return false; }
      try { localStorage.setItem(SENHA_KEY, s.trim()); } catch (e) { /* ignora */ }
    }
    syncing = true; syncState = 'syncing'; updateStatus();
    const sentRev = rev, sent = snap(), d = diff();
    let ok = false;
    try {
      const body = d.empty ? { acao: 'listar' }
        : { acao: 'sincronizar', up: d.up, del: d.del, addLocais: d.addLocais, delLocais: d.delLocais, addCats: d.addCats };
      const res = await api(body);
      if (!res.ok) {
        if (res.erro === 'senha') { try { localStorage.removeItem(SENHA_KEY); } catch (e) { /* ignora */ } syncState = 'senha'; }
        else throw new Error(res.erro || 'erro');
      } else {
        ok = true; syncState = 'ok'; lastOkAt = new Date();
        if (rev === sentRev && !busyUI()) adopt(res);
        else { lastSynced = sent; persist(); scheduleSync(2500); } // usuário mexendo: puxa a versão da planilha depois
      }
    } catch (e) { console.warn('Falha ao sincronizar', e); syncState = 'erro'; }
    syncing = false; updateStatus();
    return ok;
  }
  function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(false), ms); }
  function startSyncLoops() {
    setInterval(() => { if (!document.hidden && syncState !== 'senha') syncNow(false); }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && syncState !== 'senha') syncNow(false); });
    window.addEventListener('online', () => syncNow(false));
  }
  function updateStatus() {
    const el = $('#syncStatus'); if (!el) return;
    if (!SYNC) { el.hidden = true; return; }
    el.hidden = false;
    const pend = pendingCount();
    let txt, cls;
    if (syncState === 'senha') { txt = 'Senha pendente — toque para informar'; cls = 'err'; }
    else if (syncState === 'syncing') { txt = 'Sincronizando…'; cls = 'busy'; }
    else if (syncState === 'erro') { txt = 'Sem conexão' + (pend ? ` — ${pend} alteração(ões) pendente(s)` : '') + ' · toque para tentar'; cls = 'err'; }
    else if (pend) { txt = `${pend} alteração(ões) a enviar…`; cls = 'busy'; }
    else { txt = 'Sincronizado' + (lastOkAt ? ' às ' + lastOkAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''); cls = 'ok'; }
    el.textContent = '● ' + txt; el.className = 'sync ' + cls;
  }

  // ---------- toast ----------
  let tt;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 3800);
  }

  // ---------- eventos ----------
  function bind() {
    $('#busca').addEventListener('input', render);
    ['#fLocal', '#fCat', '#fStatus'].forEach(s => $(s).addEventListener('change', render));
    $('#btnLimpar').addEventListener('click', () => { $('#busca').value = ''; $('#fLocal').value = ''; $('#fCat').value = ''; $('#fStatus').value = ''; render(); });
    $('#vLocal').addEventListener('click', () => { view = 'local'; $('#vLocal').classList.add('active'); $('#vLista').classList.remove('active'); render(); });
    $('#vLista').addEventListener('click', () => { view = 'lista'; $('#vLista').classList.add('active'); $('#vLocal').classList.remove('active'); render(); });
    $('#btnNova').addEventListener('click', () => openForm(null));
    $('#btnEtiquetas').addEventListener('click', () => printLabels(filtered()));

    // cartões
    $('#lista').addEventListener('click', ev => {
      const btn = ev.target.closest('[data-act]'); if (!btn) return;
      const card = btn.closest('.card'); const code = card.dataset.code;
      const act = btn.dataset.act;
      if (act === 'save') setCount(code, card.querySelector('input').value);
      else if (act === 'ok') { const p = find(code); setCount(code, p.quantidade); }
      else if (act === 'detail') openDetail(code);
      else if (act === 'edit') openForm(code);
    });
    $('#lista').addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && ev.target.matches('.count-row input')) { ev.preventDefault(); setCount(ev.target.closest('.card').dataset.code, ev.target.value); }
    });

    // detalhes
    $('#detalheBody').addEventListener('click', ev => {
      const btn = ev.target.closest('[data-act]'); if (!btn) return;
      const code = btn.closest('[data-code]').dataset.code; const act = btn.dataset.act;
      if (act === 'dsave') { setCount(code, $('#detalheBody .count-row input').value); openDetail(code); }
      else if (act === 'dok') { setCount(code, find(code).quantidade); openDetail(code); }
      else if (act === 'dreset') { setCount(code, ''); openDetail(code); }
      else if (act === 'dedit') openForm(code);
      else if (act === 'ddel') deletePiece(code);
      else if (act === 'dlabel') printLabels([find(code)]);
    });

    // fechar diálogos
    document.addEventListener('click', ev => {
      if (ev.target.closest('[data-close]')) { ev.target.closest('dialog').close(); if (location.hash) history.replaceState(null, '', location.pathname + location.search); }
      const d = ev.target;
      if (d.tagName === 'DIALOG') { const r = d.getBoundingClientRect(); if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) d.close(); } // clique no fundo
      if (!ev.target.closest('#menu')) $('#menu').open = false;
    });

    // formulário
    $('#formPeca').addEventListener('submit', submitForm);
    $('#pCodigo').addEventListener('input', () => { codigoTocado = true; });
    $('#pCat').addEventListener('change', () => {
      if (onSelectNovo($('#pCat'), 'cat') && !$('#pCat').value) return;
      if (!codigoTocado && !editingCode) $('#pCodigo').value = nextCode(prefixOf($('#pCat').value));
    });
    $('#pLocal').addEventListener('change', () => onSelectNovo($('#pLocal'), 'local'));
    $('#btnGerar').addEventListener('click', () => { $('#pCodigo').value = nextCode(prefixOf($('#pCat').value)); codigoTocado = false; });

    // menu
    $('#menu').addEventListener('click', ev => {
      const b = ev.target.closest('[data-menu]'); if (!b || b.disabled) return;
      $('#menu').open = false;
      const a = b.dataset.menu;
      if (a === 'csv') exportCsv();
      else if (a === 'json') exportJson();
      else if (a === 'importar') { $('#fileImport').value = ''; $('#fileImport').click(); }
      else if (a === 'desfazer') undoImport();
      else if (a === 'locais') { renderLocais(); $('#dlgLocais').showModal(); }
      else if (a === 'url') {
        const u = prompt('Cole aqui o link do site publicado (ex.: https://usuario.github.io/inventario-robotica/).\nEle vai dentro do QR Code das etiquetas.', state.urlSite || siteBase());
        if (u !== null) { state.urlSite = u.trim(); touch(); toast('Link salvo. Gere o data.json e publique para o grupo usar o mesmo link.'); }
      }
      else if (a === 'ajuda') $('#dlgAjuda').showModal();
      else if (a === 'sync') syncNow(true);
      else if (a === 'senha') { try { localStorage.removeItem(SENHA_KEY); } catch (e) { /* ignora */ } syncNow(true); }
    });
    $('#fileImport').addEventListener('change', ev => { const f = ev.target.files[0]; if (f) doImport(f); });

    // locais
    $('#formLocal').addEventListener('submit', ev => {
      ev.preventDefault();
      const v = $('#novoLocal').value.trim(); if (!v) return;
      ensureLocal(v); $('#novoLocal').value = ''; touch(); renderLocais();
    });
    $('#listaLocais').addEventListener('click', ev => {
      const b = ev.target.closest('[data-act]'); if (!b) return;
      const loc = b.closest('li').dataset.local;
      if (b.dataset.act === 'renloc') {
        const novo = (prompt('Novo nome do local:', loc) || '').trim().replace(/\s*[>›]\s*/g, ' > ');
        if (!novo || novo === loc) return;
        if (state.locais.some(l => l !== loc && norm(l) === norm(novo))) { toast('Já existe um local com esse nome.'); return; }
        state.locais = state.locais.map(l => l === loc ? novo : l);
        state.pecas.forEach(p => { if (p.local === loc) { p.local = novo; p.editadoEm = now(); } });
        touch(); renderLocais();
      } else if (b.dataset.act === 'delloc') {
        if (!confirm(`Excluir o local “${loc}”?`)) return;
        state.locais = state.locais.filter(l => l !== loc); touch(); renderLocais();
      }
    });

    // banner
    $('#banner').addEventListener('click', ev => {
      const b = ev.target.closest('[data-b]'); if (!b) return;
      if (b.dataset.b === 'json') exportJson();
      else if (b.dataset.b === 'descartar') {
        if (!confirm('Descartar TODAS as alterações feitas neste aparelho e voltar ao catálogo publicado?\n\nBaixe o data.json antes se quiser guardar uma cópia.')) return;
        backup();
        if (remote) { state = normalizeState(remote); base = remote.atualizadoEm; } else state = emptyState();
        dirty = false; persist(); render(); toast('Voltou ao catálogo publicado.');
      } else if (b.dataset.b === 'merge') {
        backup(); const r = mergeData(remote); base = remote.atualizadoEm; touch();
        toast(`Mesclado: ${r.add} nova(s), ${r.upd} atualizada(s).`);
      }
    });

    $('#syncStatus').addEventListener('click', () => syncNow(true));
    window.addEventListener('hashchange', handleHash);
  }

  bind();
  init();
})();
