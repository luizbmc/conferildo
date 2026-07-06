// ── Verificação de integridade DOCX × ICML ────────────────────
// Compara o texto do .docx original com o do .icml diagramado, para achar trechos
// alterados durante a diagramação. Prioriza IGUALDADE DE TEXTO; ignora, por
// projeto, diferenças de espaço em branco, de formatação/estilo, parágrafos de
// imagem, e (em tabelas) tudo além de nº de células + texto de cada célula.
//
// Exceção — ênfase (negrito/itálico): só é acusada quando é um DESTAQUE DENTRO do
// parágrafo (um trecho) presente no Word e ausente no InDesign. Ênfase de
// parágrafo INTEIRO (título todo em negrito, assinatura toda em itálico) é opção
// de estilo e é ignorada.

import * as icml from './icml.js';

// Fração de caracteres (não-espaço) enfatizados a partir da qual consideramos que
// a ênfase é do PARÁGRAFO (opção de estilo), não um destaque intra-parágrafo.
const LIMIAR_ENFASE_PARAGRAFO = 0.8;

const norm = s => (s || '').replace(/\s+/g, ' ').trim();   // p/ exibição (colapsa espaço)

// Chave de IGUALDADE de texto. "Ignorar espaços" significa:
//  • quebras de linha/parágrafo (e parágrafos vazios seguidos), hífen opcional
//    (soft-hyphen) e caracteres de largura zero → contam como NADA (concatenam);
//  • tipos de espaço (comum, não-separável, tab) e espaço duplo → um único espaço.
// Um espaço ENTRE palavras continua significativo: "ENERGIA LIMPA" ≠ "ENERGIALIMPA".
const chave = s => (s || '')
  .replace(/[\r\n\u2028\u2029\u00ad\u200b\ufeff]+/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// ── Extração dos blocos do ICML (mesma forma que docx.js) ─────
export function icmlBlocks(doc, story) {
  const fs = icml.styleFontStyles(doc);
  const blocks = [];
  for (const p of icml.readParagraphs(doc, story)) {
    const inlines = p.runs.flatMap(r => r.inlines);
    const tabela = inlines.find(i => i.type === 'table');
    if (tabela) { blocks.push({ ...icmlTableBlock(doc, tabela.node), psr: p.node }); continue; }

    const temImagem = inlines.some(i => i.type === 'image');
    const chars = extrairCharsICML(p.node, p.styleSelf, fs);
    if (temImagem && !chars.some(c => c.c.trim())) { blocks.push({ type: 'para', text: '', chars: [], hasImage: true, psr: p.node }); continue; }
    blocks.push({ type: 'para', text: chars.map(x => x.c).join(''), chars, hasImage: false, psr: p.node });
  }
  return blocks;
}

// Texto + ênfase por caractere de um parágrafo ICML, lendo direto os CSR filhos
// do PSR. Inclui o texto visível de hyperlinks (<HyperlinkTextSource>) e ignora
// notas/rodapés/quebras/tabelas/imagens. Não usa readInlines para não depender do
// modelo do editor (que omite o texto de hyperlink).
function extrairCharsICML(psr, paraStyle, fs) {
  const chars = [];
  for (const csr of Array.from(psr.childNodes)) {
    if (csr.nodeType !== 1 || csr.tagName !== 'CharacterStyleRange') continue;
    const local = csr.getAttribute('FontStyle');
    const fontStyle = local || fs.char.get(csr.getAttribute('AppliedCharacterStyle') || '') || fs.para.get(paraStyle) || '';
    const bold = /bold/i.test(fontStyle);
    const italic = /italic|oblique/i.test(fontStyle);
    const add = t => { for (const c of t) chars.push({ c, bold, italic }); };
    for (const node of Array.from(csr.childNodes)) {
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'Content') add(node.textContent);
      else if (node.tagName === 'HyperlinkTextSource')
        for (const cc of Array.from(node.getElementsByTagName('Content'))) add(cc.textContent);
    }
  }
  return chars;
}

function icmlTableBlock(doc, tableNode) {
  const t = icml.readTable(doc, tableNode);
  const byRow = new Map();
  for (const cell of t.cells) {
    const txt = cell.paras.map(p =>
      p.runs.flatMap(r => r.inlines).filter(i => i.type === 'text').map(i => i.text).join('')).join('\n');
    if (!byRow.has(cell.row)) byRow.set(cell.row, []);
    byRow.get(cell.row).push({ col: cell.col, txt });
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b)
    .map(r => byRow.get(r).sort((a, b) => a.col - b.col).map(c => c.txt));
  return { type: 'table', rows, nCells: t.cells.length };
}

// ── Alinhamento (LCS por texto normalizado) ───────────────────
function alinhar(a, b, key) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = key(a[i]) === key(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) ops.push({ t: 'match', ai: i++, bi: j++ });
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: 'del', ai: i++ });
    else ops.push({ t: 'ins', bi: j++ });
  }
  while (i < n) ops.push({ t: 'del', ai: i++ });
  while (j < m) ops.push({ t: 'ins', bi: j++ });
  return ops;
}

// ── Ênfase: trechos destacados no Word e regulares no InDesign ─
function seqNaoEspaco(chars) { return chars.filter(c => c.c.trim()); }

function trechosPerdidos(seqW, seqI, prop) {
  if (seqW.length !== seqI.length || !seqW.length) return [];
  const enf = seqW.filter(c => c[prop]).length;
  if (enf === 0) return [];
  if (enf / seqW.length >= LIMIAR_ENFASE_PARAGRAFO) return [];   // parágrafo inteiro → estilo
  const out = [];
  let i = 0;
  while (i < seqW.length) {
    if (seqW[i][prop] && !seqI[i][prop]) {
      let j = i, t = '';
      while (j < seqW.length && seqW[j][prop] && !seqI[j][prop]) { t += seqW[j].c; j++; }
      out.push(t); i = j;
    } else i++;
  }
  return out;
}

function preview(s, n = 90) { const t = norm(s); return t.length > n ? t.slice(0, n) + '…' : t; }

// Diff por PALAVRA entre o Word (base) e o ICML. Considerando o Word como base:
//  • palavras no ICML e não no Word = ADICIONADAS  → { green: [start,end] } (offsets do ICML)
//  • palavras no Word e não no ICML = CORTADAS      → { cuts: {at, text} }   (inserir tachado)
function tokenize(t) {
  const toks = []; const re = /\S+/g; let m;
  while ((m = re.exec(t))) toks.push({ w: m[0], s: m.index, e: m.index + m[0].length });
  return toks;
}
function lcsWordOps(a, b, key) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = key(a[i]) === key(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) ops.push({ t: 'm', i: i++, j: j++ });
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: 'd', i: i++ });
    else ops.push({ t: 'a', j: j++ });
  }
  while (i < n) ops.push({ t: 'd', i: i++ });
  while (j < m) ops.push({ t: 'a', j: j++ });
  return ops;
}
function diffMarks(wordText, icmlText) {
  const W = tokenize(wordText), I = tokenize(icmlText);
  const ops = lcsWordOps(W, I, x => chave(x.w));
  const green = [], cuts = [];
  let icmlPos = 0;                    // offset no ICML onde inserir os cortes
  let gs = -1, ge = -1;               // range de adicionadas (verde) em acumulação
  let cutBuf = [], cutAt = null;      // palavras cortadas em acumulação
  const flushGreen = () => { if (gs >= 0) { green.push([gs, ge]); gs = ge = -1; } };
  const flushCut = () => { if (cutBuf.length) { cuts.push({ at: cutAt, text: ' ' + cutBuf.join(' ') }); cutBuf = []; cutAt = null; } };
  for (const op of ops) {
    if (op.t === 'm') { flushCut(); flushGreen(); icmlPos = I[op.j].e; }
    else if (op.t === 'a') { flushCut(); const tk = I[op.j]; if (gs < 0) gs = tk.s; ge = tk.e; icmlPos = tk.e; }
    else { flushGreen(); if (cutAt === null) cutAt = icmlPos; cutBuf.push(W[op.i].w); }
  }
  flushCut(); flushGreen();
  return { green, cuts };
}

// Similaridade grosseira entre dois textos: (prefixo + sufixo comuns) / menor.
const LIMIAR_SIMILAR = 0.4;
function scoreSimilar(a, b) {
  const x = chave(a), y = chave(b);
  if (!x.length || !y.length) return 0;
  let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0; while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  return (p + s) / Math.min(x.length, y.length);
}

// Empurra os destaques (negrito/itálico) do Word ausentes no InDesign.
// `psr` = nó do parágrafo no ICML (p/ marcar/navegar no editor).
function verificarEnfase(achados, w, i) {
  for (const prop of ['bold', 'italic'])
    for (const trecho of trechosPerdidos(seqNaoEspaco(w.chars), seqNaoEspaco(i.chars), prop))
      achados.push({ tipo: 'enfase', prop, psr: i.psr, msg: `Destaque em ${prop === 'bold' ? 'negrito' : 'itálico'} perdido: “${preview(trecho, 60)}”`, contexto: preview(w.text) });
}

// ── Comparação principal ──────────────────────────────────────
export function comparar(docxBlocks, icmlBlocks) {
  const achados = [];

  // Parágrafos de texto (ignora imagem e vazios após normalização).
  const ehParaTexto = b => b.type === 'para' && !b.hasImage && chave(b.text);
  const wp = docxBlocks.filter(ehParaTexto);
  const ip = icmlBlocks.filter(ehParaTexto);

  const ops = alinhar(wp, ip, b => chave(b.text));
  let ultimoIcml = null;   // último parágrafo do ICML casado (âncora p/ inserir ausentes)
  // Junta del/ins adjacentes como parágrafos MODIFICADOS (texto alterado).
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.t === 'match') { ultimoIcml = ip[op.bi]; verificarEnfase(achados, wp[op.ai], ip[op.bi]); continue; }

    // Intervalo de del(word) + ins(indesign) consecutivos.
    const dels = [], inss = [];
    while (k < ops.length && ops[k].t !== 'match') {
      if (ops[k].t === 'del') dels.push(wp[ops[k].ai]); else inss.push(ip[ops[k].bi]);
      k++;
    }
    k--;
    // Pareia por MELHOR similaridade globalmente (não por índice): calcula todos os
    // pares acima do limiar, ordena por score e atribui os melhores primeiro. Assim
    // um parágrafo só um pouco diferente vira "alterado", não "ausente", mesmo com
    // vários candidatos parecidos (itens de lista) no mesmo intervalo.
    const cand = [];
    for (let di = 0; di < dels.length; di++)
      for (let ij = 0; ij < inss.length; ij++) {
        const sc = scoreSimilar(dels[di].text, inss[ij].text);
        if (sc >= LIMIAR_SIMILAR) cand.push([sc, di, ij]);
      }
    cand.sort((a, b) => b[0] - a[0]);
    const delPar = new Map(), insUsado = new Set();
    for (const [, di, ij] of cand) {
      if (delPar.has(di) || insUsado.has(ij)) continue;
      delPar.set(di, ij); insUsado.add(ij);
    }
    for (let di = 0; di < dels.length; di++) {
      const w = dels[di];
      if (delPar.has(di)) {
        const i = inss[delPar.get(di)];
        if (chave(w.text) === chave(i.text)) verificarEnfase(achados, w, i);   // igual: artefato do LCS
        else {
          const marks = diffMarks(w.text, i.text);   // verde (adicionado) + cortes (tachado)
          achados.push({ tipo: 'texto', psr: i.psr, green: marks.green, cuts: marks.cuts, msg: 'Texto do parágrafo diferente', contexto: preview(i.text), word: preview(w.text), indesign: preview(i.text) });
        }
      } else {
        // Trecho do Word sem correspondência → texto + âncora no ICML (parágrafo após
        // o qual inserir; null = antes do primeiro) p/ a inserção tachada.
        achados.push({ tipo: 'ausente', msg: 'Trecho do Word não encontrado no InDesign', contexto: preview(w.text), word: preview(w.text), textoWord: w.text, aposPsr: ultimoIcml && ultimoIcml.psr });
      }
    }
    for (let ij = 0; ij < inss.length; ij++) {
      if (insUsado.has(ij)) continue;
      const i = inss[ij];
      achados.push({ tipo: 'extra', psr: i.psr, msg: 'Parágrafo no InDesign sem correspondência no Word', contexto: preview(i.text), indesign: preview(i.text) });
    }
  }

  // Tabelas: nº de células + texto de cada célula (alinhadas por ordem).
  const wt = docxBlocks.filter(b => b.type === 'table');
  const it = icmlBlocks.filter(b => b.type === 'table');
  for (let k = 0; k < Math.max(wt.length, it.length); k++) {
    const w = wt[k], i = it[k];
    if (!w || !i) { achados.push({ tipo: 'tabela', psr: i && i.psr, msg: `Tabela ${k + 1} existe só ${w ? 'no Word' : 'no InDesign'}` }); continue; }
    if (w.nCells !== i.nCells) {
      // Estrutura difere → comparar por posição não faz sentido; só reporta a contagem.
      achados.push({ tipo: 'tabela', psr: i.psr, msg: `Tabela ${k + 1}: nº de células difere (Word ${w.nCells}, InDesign ${i.nCells})` });
      continue;
    }
    const cw = w.rows.flat(), ci = i.rows.flat();
    for (let c = 0; c < Math.min(cw.length, ci.length); c++)
      if (chave(cw[c]) !== chave(ci[c]))
        achados.push({ tipo: 'tabela', psr: i.psr, msg: `Tabela ${k + 1}, célula ${c + 1}: texto difere`, contexto: preview(cw[c]), word: preview(cw[c]), indesign: preview(ci[c]) });
  }

  return achados;
}
