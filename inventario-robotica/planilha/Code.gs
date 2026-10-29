/**
 * Inventário da Sala de Robótica – ponte entre o site e a planilha do Google.
 * Cole este arquivo inteiro em Extensões ▸ Apps Script (veja o README).
 *
 * >>> TROQUE A SENHA ABAIXO e anote-a: o grupo vai digitá-la no site uma vez. <<<
 */
const SENHA = 'troque-esta-senha';

const ABA_PECAS = 'Pecas';
const ABA_LOCAIS = 'Locais';
const ABA_CATS = 'Categorias';
const CAB = ['Código', 'Nome', 'Quantidade', 'Local', 'Categoria', 'Observações', 'Contada', 'Status', 'ContadaEm', 'EditadoEm'];

/* Abrir o link do script no navegador só mostra esta mensagem (serve para testar). */
function doGet() {
  return saida({ ok: true, msg: 'API do inventário ativa. Use o site para acessar os dados.' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000); // uma gravação por vez: ninguém atropela ninguém
    const req = JSON.parse(e.postData.contents);
    if (req.senha !== SENHA) return saida({ ok: false, erro: 'senha' });
    prepararAbas();
    if (req.acao === 'sincronizar') {
      gravarPecas(mesclarPecas(lerPecas(), req));
      ajustarLocais(req.addLocais, req.delLocais);
      adicionarCategorias(req.addCats);
    }
    return saida({ ok: true, pecas: lerPecas(), locais: lerLocais(), categorias: lerCategorias() });
  } catch (err) {
    return saida({ ok: false, erro: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* ignora */ }
  }
}

function saida(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- regra de mesclagem (sem acesso à planilha, fácil de testar) ---------- */
function normalizar(p) {
  const c = p.contada === '' || p.contada == null ? null : Number(p.contada);
  return {
    codigo: String(p.codigo || '').trim(),
    nome: String(p.nome || ''),
    quantidade: Number(p.quantidade) || 0,
    local: String(p.local || ''),
    categoria: String(p.categoria || ''),
    obs: String(p.obs || ''),
    contada: c == null || isNaN(c) ? null : c,
    contadaEm: String(p.contadaEm || ''),
    editadoEm: String(p.editadoEm || '')
  };
}

/* req.del = códigos a apagar; req.up = peças novas/alteradas.
   Em peça existente, vale a alteração mais recente (dados e contagem separadamente). */
function mesclarPecas(atuais, req) {
  const mapa = new Map();
  atuais.forEach(function (p) { mapa.set(String(p.codigo).toLowerCase(), p); });
  (req.del || []).forEach(function (c) { mapa.delete(String(c).toLowerCase()); });
  (req.up || []).forEach(function (raw) {
    const ip = normalizar(raw);
    const k = ip.codigo.toLowerCase();
    if (!k) return;
    const p = mapa.get(k);
    if (!p) { mapa.set(k, ip); return; }
    if (ip.editadoEm > p.editadoEm) {
      p.nome = ip.nome; p.quantidade = ip.quantidade; p.local = ip.local;
      p.categoria = ip.categoria; p.obs = ip.obs; p.editadoEm = ip.editadoEm;
    }
    if (ip.contadaEm > p.contadaEm) { p.contada = ip.contada; p.contadaEm = ip.contadaEm; }
  });
  return Array.from(mapa.values());
}

/* ---------- leitura e escrita na planilha ---------- */
function aba(nome) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nome); }

function prepararAbas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [[ABA_PECAS, CAB], [ABA_LOCAIS, ['Local']], [ABA_CATS, ['Nome', 'Prefixo']]].forEach(function (d) {
    let sh = ss.getSheetByName(d[0]);
    if (!sh) sh = ss.insertSheet(d[0]);
    if (sh.getRange(1, 1).getValue() === '') {
      sh.getRange(1, 1, 1, d[1].length).setValues([d[1]]).setFontWeight('bold').setBackground('#e8eef7');
      sh.setFrozenRows(1);
      if (d[0] === ABA_PECAS) {
        // colunas de texto puro: impede o Sheets de transformar "2026-10-28T..." em data ou "=..." em fórmula
        ['A:B', 'D:F', 'I:J'].forEach(function (r) { sh.getRange(r).setNumberFormat('@'); });
        sh.setColumnWidth(2, 240); sh.setColumnWidth(4, 220);
      }
    }
  });
}

function lerPecas() {
  const sh = aba(ABA_PECAS), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, CAB.length).getValues()
    .filter(function (r) { return String(r[0]).trim() !== ''; })
    .map(function (r) {
      return normalizar({ codigo: r[0], nome: r[1], quantidade: r[2], local: r[3], categoria: r[4], obs: r[5], contada: r[6], contadaEm: r[8], editadoEm: r[9] });
    });
}

function gravarPecas(pecas) {
  const sh = aba(ABA_PECAS), n = sh.getLastRow();
  if (n > 1) sh.getRange(2, 1, n - 1, CAB.length).clearContent();
  if (!pecas.length) return;
  const vals = pecas.map(function (p, i) {
    const r = i + 2;
    return [p.codigo, p.nome, p.quantidade, p.local, p.categoria, p.obs, p.contada == null ? '' : p.contada,
      '=IF(G' + r + '="","Pendente",IF(G' + r + '=C' + r + ',"Conferida","Divergente"))', p.contadaEm || '', p.editadoEm || ''];
  });
  sh.getRange(2, 1, vals.length, CAB.length).setValues(vals);
}

function lerLocais() {
  const sh = aba(ABA_LOCAIS), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); }).filter(Boolean);
}

function ajustarLocais(add, del) {
  const sh = aba(ABA_LOCAIS);
  let lista = lerLocais().filter(function (l) { return (del || []).indexOf(l) < 0; });
  (add || []).forEach(function (l) { if (l && lista.indexOf(l) < 0) lista.push(l); });
  const n = sh.getLastRow();
  if (n > 1) sh.getRange(2, 1, n - 1, 1).clearContent();
  if (lista.length) sh.getRange(2, 1, lista.length, 1).setValues(lista.map(function (l) { return [l]; }));
}

function lerCategorias() {
  const sh = aba(ABA_CATS), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, 2).getValues()
    .map(function (r) { return { nome: String(r[0]).trim(), prefixo: String(r[1]).trim() }; })
    .filter(function (c) { return c.nome; });
}

function adicionarCategorias(add) {
  const sh = aba(ABA_CATS), atuais = lerCategorias().map(function (c) { return c.nome.toLowerCase(); });
  (add || []).forEach(function (c) {
    if (c && c.nome && atuais.indexOf(String(c.nome).toLowerCase()) < 0) {
      sh.appendRow([c.nome, c.prefixo || '']);
      atuais.push(String(c.nome).toLowerCase());
    }
  });
}
