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
const CAB = ['Código', 'Nome', 'Quantidade', 'Local', 'Categoria', 'Observações', 'Contada', 'Status', 'ContadaEm', 'EditadoEm', 'Foto', 'FotoEm'];
const PASTA_FOTOS = 'Fotos - Inventário Robótica'; // pasta criada no seu Google Drive

/* Abrir o link do script no navegador só mostra esta mensagem (serve para testar). */
function doGet() {
  return saida({ ok: true, fotos: true, msg: 'API do inventário ativa (com fotos). Use o site para acessar os dados.' });
}

/* Rode esta função UMA VEZ pelo editor (botão ▶ Executar) para autorizar o acesso ao Drive (fotos). */
function autorizarFotos() {
  const p = pastaFotos();
  Logger.log('Pronto. Fotos vão para a pasta: ' + p.getName() + ' — ' + p.getUrl());
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000); // uma gravação por vez: ninguém atropela ninguém
    const req = JSON.parse(e.postData.contents);
    if (req.senha !== SENHA) return saida({ ok: false, erro: 'senha' });
    if (req.acao === 'foto') return saida(salvarFoto(req));
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
    editadoEm: String(p.editadoEm || ''),
    foto: String(p.foto || '').trim(),
    fotoEm: String(p.fotoEm || '')
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
    // a foto tem data própria: editar outros dados (ou um site antigo, sem fotos) nunca apaga a foto
    if (ip.fotoEm > p.fotoEm) { p.foto = ip.foto; p.fotoEm = ip.fotoEm; }
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
        ['A:B', 'D:F', 'I:L'].forEach(function (r) { sh.getRange(r).setNumberFormat('@'); });
        sh.setColumnWidth(2, 240); sh.setColumnWidth(4, 220);
      }
    }
    if (d[0] === ABA_PECAS) garantirColunasNovas(sh);
  });
}

/* Planilhas criadas antes das fotos têm só até a coluna J: acrescenta "Foto" e "FotoEm" (K e L)
   sem mexer em nenhum dado existente. Se K/L já estiverem ocupadas com outra coisa, para tudo. */
function garantirColunasNovas(sh) {
  const total = CAB.length;
  if (sh.getMaxColumns() < total) sh.insertColumnsAfter(sh.getMaxColumns(), total - sh.getMaxColumns());
  const cab = sh.getRange(1, 1, 1, total).getValues()[0];
  for (let i = 10; i < total; i++) {
    const atual = String(cab[i]).trim();
    if (atual === CAB[i]) continue;
    const col = i + 1, letra = String.fromCharCode(64 + col);
    if (atual !== '') throw new Error('A coluna ' + letra + ' da aba Pecas já tem outro conteúdo ("' + atual + '"). Mova-a para outra coluna para liberar ' + letra + ' para "' + CAB[i] + '".');
    const n = sh.getLastRow();
    if (n > 1 && sh.getRange(2, col, n - 1, 1).getValues().some(function (r) { return String(r[0]) !== ''; })) {
      throw new Error('A coluna ' + letra + ' da aba Pecas tem dados sem cabeçalho. Mova-os para liberar a coluna ' + letra + '.');
    }
    sh.getRange(1, col).setValue(CAB[i]).setFontWeight('bold').setBackground('#e8eef7');
    sh.getRange(1, col, sh.getMaxRows(), 1).setNumberFormat('@');
  }
}

/* ---------- fotos (Google Drive) ---------- */
function pastaFotos() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PASTA_FOTOS_ID');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* recria */ } }
  const it = DriveApp.getFoldersByName(PASTA_FOTOS);
  const pasta = it.hasNext() ? it.next() : DriveApp.createFolder(PASTA_FOTOS);
  props.setProperty('PASTA_FOTOS_ID', pasta.getId());
  return pasta;
}

/* req.dados = imagem JPEG em base64 (o site já reduz o tamanho). Devolve o link da foto. */
function salvarFoto(req) {
  const dados = String(req.dados || '');
  if (!dados) return { ok: false, erro: 'foto vazia' };
  if (dados.length > 8 * 1024 * 1024) return { ok: false, erro: 'foto grande demais' };
  const codigo = String(req.codigo || 'peca').trim().replace(/[^\w.-]+/g, '_');
  const nome = codigo + '_' + Utilities.formatDate(new Date(), 'GMT', "yyyyMMdd'T'HHmmss") + '.jpg';
  const arq = pastaFotos().createFile(Utilities.newBlob(Utilities.base64Decode(dados), 'image/jpeg', nome));
  try {
    arq.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); // para todos verem no site
  } catch (e) {
    return { ok: false, erro: 'o Drive não deixou compartilhar a foto por link (conta de escola?). ' + e };
  }
  return { ok: true, url: 'https://drive.google.com/file/d/' + arq.getId() + '/view' };
}

function lerPecas() {
  const sh = aba(ABA_PECAS), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, CAB.length).getValues()
    .filter(function (r) { return String(r[0]).trim() !== ''; })
    .map(function (r) {
      return normalizar({ codigo: r[0], nome: r[1], quantidade: r[2], local: r[3], categoria: r[4], obs: r[5], contada: r[6], contadaEm: r[8], editadoEm: r[9], foto: r[10], fotoEm: r[11] });
    });
}

function gravarPecas(pecas) {
  const sh = aba(ABA_PECAS), n = sh.getLastRow();
  if (n > 1) sh.getRange(2, 1, n - 1, CAB.length).clearContent();
  if (!pecas.length) return;
  const vals = pecas.map(function (p, i) {
    const r = i + 2;
    return [p.codigo, p.nome, p.quantidade, p.local, p.categoria, p.obs, p.contada == null ? '' : p.contada,
      '=IF(G' + r + '="","Pendente",IF(G' + r + '=C' + r + ',"Conferida","Divergente"))', p.contadaEm || '', p.editadoEm || '', p.foto || '', p.fotoEm || ''];
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
