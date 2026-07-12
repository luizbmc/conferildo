/**
 * Núcleo de leitura/escrita de ICML para o Conferildo.
 *
 * Princípio central — EDIÇÃO CIRÚRGICA: nunca reconstruímos o documento a
 * partir de um modelo simplificado. Mantemos o DOM original do ICML como fonte
 * da verdade e mutamos apenas os nós de conteúdo tocados pelo revisor. Assim,
 * todo o cabeçalho (fontes, cores, estilos), o pacote XMP e os overrides locais
 * do designer (Leading, Tracking, SpaceBefore…) sobrevivem por construção.
 *
 * O módulo é agnóstico de ambiente: recebe implementações de DOMParser e
 * XMLSerializer por injeção. No navegador usam-se as nativas; nos testes em
 * Node usa-se @xmldom/xmldom.
 */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// ── Parse / serialização ──────────────────────────────────────

export function parseIcml(xmlString, DOMParserImpl) {
  const doc = new DOMParserImpl().parseFromString(xmlString, 'text/xml');
  const story = first(doc.getElementsByTagName('Story'));
  if (!story) throw new Error('ICML sem elemento <Story>.');
  return { doc, story };
}

export function serializeIcml(doc, XMLSerializerImpl) {
  let out = new XMLSerializerImpl().serializeToString(doc);
  // Nem o serializer nativo nem o do xmldom reemitem a declaração XML.
  if (!out.startsWith('<?xml')) out = XML_DECL + '\n' + out;
  return out;
}

// ── Leitura da story para a UI ────────────────────────────────

/**
 * Extrai os parágrafos da story como uma visão para renderização, mantendo
 * referências vivas aos nós do DOM (para escrita cirúrgica posterior).
 */
export function readParagraphs(doc, story) {
  const paraNameBySelf = styleNameMap(doc, 'ParagraphStyle');
  const charNameBySelf = styleNameMap(doc, 'CharacterStyle');

  return childElements(story, 'ParagraphStyleRange').map(psr => ({
    node: psr,
    styleSelf: psr.getAttribute('AppliedParagraphStyle') || '',
    styleName: displayName(psr.getAttribute('AppliedParagraphStyle'), paraNameBySelf),
    runs: childElements(psr, 'CharacterStyleRange').map(csr => ({
      node: csr,
      styleSelf: csr.getAttribute('AppliedCharacterStyle') || '',
      styleName: displayName(csr.getAttribute('AppliedCharacterStyle'), charNameBySelf),
      inlines: readInlines(csr),
    })),
  }));
}

// Sequência inline de um CharacterStyleRange: texto, notas e quebras, em ordem.
function readInlines(csr) {
  const items = [];
  for (const node of Array.from(csr.childNodes)) {
    if (node.nodeType !== 1) continue; // só elementos
    if (node.tagName === 'Content')   items.push({ type: 'text', node, text: node.textContent });
    else if (node.tagName === 'Br')       items.push({ type: 'br',   node });
    else if (node.tagName === 'Note')     items.push({ type: 'note', node, text: aninhadoTexto(node) });
    else if (node.tagName === 'Footnote') items.push({ type: 'footnote', node, text: footnoteText(node) });
    else if (node.tagName === 'Table')    items.push({ type: 'table', node });
    else if (node.tagName === 'Rectangle' && node.getAttribute('ContentType') === 'GraphicType')
      items.push({ type: 'image', node, src: imageUri(node) });
  }
  return items;
}

// Caminho da imagem: o LinkResourceURI (file:...) do <Link> dentro do Rectangle,
// já decodificado (%20 → espaço), sem o prefixo "file:".
function imageUri(rectangle) {
  for (const link of Array.from(rectangle.getElementsByTagName('Link'))) {
    const uri = link.getAttribute('LinkResourceURI') || '';
    if (/^file:/i.test(uri)) return decodeURIComponent(uri.replace(/^file:/i, ''));
  }
  return null;
}

/**
 * Lê uma <Table> como uma grade para renderização. As células têm Name="coluna:linha"
 * e podem ter RowSpan/ColumnSpan. O conteúdo de cada célula é lido com readParagraphs
 * (uma célula é uma mini-story: PSR>CSR>Content).
 */
export function readTable(doc, tableNode) {
  const intAttr = (el, a) => parseInt(el.getAttribute(a), 10) || 0;
  const cells = childElements(tableNode, 'Cell').map(cell => {
    const [col, row] = (cell.getAttribute('Name') || '0:0').split(':').map(n => parseInt(n, 10) || 0);
    return {
      node: cell, col, row,
      colSpan: intAttr(cell, 'ColumnSpan') || 1,
      rowSpan: intAttr(cell, 'RowSpan') || 1,
      paras: readParagraphs(doc, cell),
    };
  });
  return {
    colCount:   intAttr(tableNode, 'ColumnCount'),
    headerRows: intAttr(tableNode, 'HeaderRowCount'),
    rowCount:   intAttr(tableNode, 'HeaderRowCount') + intAttr(tableNode, 'BodyRowCount') + intAttr(tableNode, 'FooterRowCount'),
    cells,
  };
}

// Texto de um elemento aninhado (Note/Footnote) com estrutura PSR>CSR>Content.
function aninhadoTexto(el) {
  return childElements(el, 'ParagraphStyleRange')
    .flatMap(psr => childElements(psr, 'CharacterStyleRange'))
    .flatMap(csr => childElements(csr, 'Content'))
    .map(c => c.textContent)
    .join('\n');
}

// Texto da nota de rodapé, sem o marcador de número automático (<?ACE 4?>, que
// já é ignorado por textContent) nem o tab inicial que o segue.
function footnoteText(fn) {
  return aninhadoTexto(fn).replace(/^[\t ]+/, '').trim();
}

// ── Listas de estilos disponíveis (para os seletores da UI) ───

export function listParagraphStyles(doc) {
  return styleList(doc, 'ParagraphStyle');
}
export function listCharacterStyles(doc) {
  return styleList(doc, 'CharacterStyle');
}

function styleList(doc, tag) {
  return Array.from(doc.getElementsByTagName(tag))
    .map(el => ({ self: el.getAttribute('Self'), name: el.getAttribute('Name') || '' }))
    .filter(s => s.self && !s.self.includes('[No ') && !/NormalParagraphStyle/i.test(s.name));
}

// ── Operações de edição cirúrgica (mutam o DOM in place) ──────

/**
 * Substitui o texto de um nó <Content>, preservando marcadores não-textuais
 * (ex.: a instrução <?ACE?> de número automático de nota de rodapé), que ficam
 * como filhos do Content e seriam perdidos por um simples `textContent = ...`.
 */
export function setContentText(contentNode, newText) {
  for (const n of Array.from(contentNode.childNodes))
    if (n.nodeType === 3) contentNode.removeChild(n);   // remove só nós de texto
  contentNode.appendChild(contentNode.ownerDocument.createTextNode(newText));
}

/** Troca o estilo de parágrafo, preservando SpaceBefore e demais overrides. */
export function setParagraphStyle(psrNode, styleSelf) {
  psrNode.setAttribute('AppliedParagraphStyle', styleSelf);
}

/** Troca o estilo de caractere de um range inteiro (aplicação por run). */
export function setCharacterStyle(csrNode, styleSelf) {
  csrNode.setAttribute('AppliedCharacterStyle', styleSelf);
}

/** Texto de corpo do parágrafo (concatena os <Content>, ignora notas). */
export function paragraphBodyText(psr) {
  return bodyContents(psr).map(c => c.node.textContent).join('');
}

/**
 * Marca com `conditionRef` os runs de corpo apagados por inteiro no editor
 * (Content sem span sobrevivente, fora de `keep`), PRESERVANDO o texto e o estilo
 * de caractere — assim o trecho removido mantém sua formatação e pode ser
 * restaurado. Retorna true se marcou algo.
 */
export function markOrphanRunsRemoved(psr, keep, conditionRef) {
  let marcou = false;
  for (const { node, csr } of bodyContents(psr)) {
    if (keep.has(node) || !node.textContent) continue;
    const cur = (csr.getAttribute('AppliedConditions') || '').split(/\s+/).filter(Boolean);
    if (!cur.includes(conditionRef)) {
      cur.push(conditionRef);
      csr.setAttribute('AppliedConditions', cur.join(' '));
      marcou = true;
    }
  }
  return marcou;
}

/**
 * Aplica um estilo de caractere à seleção arbitrária [start, end) do parágrafo,
 * em offsets de caractere sobre o texto de corpo. Divide os runs no ponto exato,
 * clonando atributos e <Properties> para preservar os overrides do designer.
 */
export function applyCharacterStyleToOffsets(psr, start, end, styleSelf) {
  if (end <= start) return;
  for (const csr of selecionarRuns(psr, start, end))
    csr.setAttribute('AppliedCharacterStyle', styleSelf);
}

// Prepara as fronteiras de CSR em [start, end) e devolve os CSRs cobertos.
function selecionarRuns(psr, start, end) {
  normalizePsr(psr);                 // cada CSR passa a ter um único item
  splitBoundaryAt(psr, start);       // garante fronteira de CSR em start
  splitBoundaryAt(psr, end);         // e em end
  return bodyContents(psr).filter(c => c.from >= start && c.to <= end).map(c => c.csr);
}

/**
 * Alterna um estilo de caractere NOMEADO na seleção: se todos os runs já têm o
 * estilo, remove-o (volta a "[No character style]"); senão aplica-o.
 */
export function toggleCharacterStyle(psr, start, end, styleSelf) {
  if (end <= start || !styleSelf) return;
  const csrs = selecionarRuns(psr, start, end);
  const ligado = csrs.length && csrs.every(c => c.getAttribute('AppliedCharacterStyle') === styleSelf);
  const alvo = ligado ? SEM_ESTILO_CHAR : styleSelf;
  csrs.forEach(c => c.setAttribute('AppliedCharacterStyle', alvo));
}

/** Define um atributo nos runs da seleção (divide nas fronteiras). Usado pela
 *  comparação p/ marcar trechos ADICIONADOS pelo ICML (ex.: CompAdd="true"). */
export function markOffsets(psr, start, end, attr, value) {
  if (end <= start) return;
  for (const csr of selecionarRuns(psr, start, end)) csr.setAttribute(attr, value);
}

// ── Text Conditions (destaque de trechos, ex.: "Texto alterado") ─────

// Cores indicadoras nomeadas do InDesign (aprox. RGB). Fallback: âmbar.
const INDICATOR_COLORS = {
  CuteTeal: [26, 188, 170], BackyardGreen: [122, 182, 72], SunburstYellow: [245, 196, 0],
  PewterGrey: [142, 142, 142], PurpleHaze: [142, 111, 179], AllureRed: [224, 67, 90],
  Charcoal: [74, 74, 74], GridBlue: [59, 125, 216], GridGreen: [57, 168, 69],
  GridOrange: [224, 138, 46], GridRed: [213, 69, 59], Lipstick: [214, 61, 117], Grass: [122, 182, 72],
};

/** Lista as conditions do documento: [{ self, name }]. */
export function listConditions(doc) {
  return Array.from(doc.getElementsByTagName('Condition'))
    .map(c => ({ self: c.getAttribute('Self'), name: c.getAttribute('Name') || '' }))
    .filter(c => c.self);
}

/** Mapa condSelf → cor de destaque CSS (rgba semitransparente, p/ UseHighlight). */
export function conditionColors(doc) {
  const map = new Map();
  for (const c of Array.from(doc.getElementsByTagName('Condition'))) {
    const self = c.getAttribute('Self');
    if (!self) continue;
    const props = first(childElements(c, 'Properties'));
    const ind = props && first(childElements(props, 'IndicatorColor'));
    let rgb = [245, 158, 11];
    if (ind && ind.getAttribute('type') === 'list') {
      const v = childElements(ind, 'ListItem').map(li => Math.round(parseFloat(li.textContent)));
      if (v.length >= 3) rgb = v;
    } else if (ind && INDICATOR_COLORS[ind.textContent.trim()]) {
      rgb = INDICATOR_COLORS[ind.textContent.trim()];
    }
    map.set(self, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.4)`);
  }
  return map;
}

/**
 * Garante que exista uma Condition com o dado nome; cria (com cor RGB) se faltar.
 * Retorna o Self (com espaço literal, como nas definições do ICML).
 */
export function ensureCondition(doc, name, rgb) {
  for (const c of Array.from(doc.getElementsByTagName('Condition')))
    if (c.getAttribute('Name') === name) return c.getAttribute('Self');

  const self = 'Condition/' + name;
  const cond = doc.createElement('Condition');
  cond.setAttribute('Self', self);
  cond.setAttribute('Name', name);
  cond.setAttribute('IndicatorMethod', 'UseHighlight');
  cond.setAttribute('Visible', 'true');
  const props = doc.createElement('Properties');
  const ind = doc.createElement('IndicatorColor');
  ind.setAttribute('type', 'list');
  for (const v of rgb) {
    const li = doc.createElement('ListItem');
    li.setAttribute('type', 'double');
    li.textContent = String(v);
    ind.appendChild(li);
  }
  props.appendChild(ind);
  cond.appendChild(props);

  const conds = doc.getElementsByTagName('Condition');
  if (conds.length) {
    const last = conds[conds.length - 1];
    last.parentNode.insertBefore(cond, last.nextSibling);
  } else {
    const story = first(Array.from(doc.getElementsByTagName('Story')));
    if (story) story.parentNode.insertBefore(cond, story);
    else doc.documentElement.appendChild(cond);
  }
  return self;
}

/**
 * Insere um novo run (CSR) com `text` no offset do parágrafo, com a condition
 * indicada (usado para re-inserir o texto apagado marcado como "Texto removido").
 */
export function insertRun(psr, offset, text, conditionRef) {
  const doc = psr.ownerDocument;
  normalizePsr(psr);
  splitBoundaryAt(psr, offset);

  const csr = doc.createElement('CharacterStyleRange');
  csr.setAttribute('AppliedCharacterStyle', SEM_ESTILO_CHAR);
  if (conditionRef) csr.setAttribute('AppliedConditions', conditionRef);
  const content = doc.createElement('Content');
  content.textContent = text;
  csr.appendChild(content);

  let acc = 0, alvo = null;
  for (const c of childElements(psr, 'CharacterStyleRange')) {
    if (acc >= offset) { alvo = c; break; }
    acc += childElements(c, 'Content').reduce((s, ct) => s + ct.textContent.length, 0);
  }
  if (alvo) alvo.parentNode.insertBefore(csr, alvo);
  else psr.appendChild(csr);
  return csr;
}

/** Insere um run TACHADO (StrikeThru) no offset — usado pela comparação para
 *  mostrar, no parágrafo, o texto do Word que foi CORTADO no ICML. */
export function insertStruckRun(psr, offset, text) {
  const doc = psr.ownerDocument;
  normalizePsr(psr);
  splitBoundaryAt(psr, offset);
  const csr = doc.createElement('CharacterStyleRange');
  csr.setAttribute('AppliedCharacterStyle', SEM_ESTILO_CHAR);
  csr.setAttribute('StrikeThru', 'true');
  const content = doc.createElement('Content');
  content.textContent = text;
  csr.appendChild(content);
  let acc = 0, alvo = null;
  for (const c of childElements(psr, 'CharacterStyleRange')) {
    if (acc >= offset) { alvo = c; break; }
    acc += childElements(c, 'Content').reduce((s, ct) => s + ct.textContent.length, 0);
  }
  if (alvo) alvo.parentNode.insertBefore(csr, alvo);
  else psr.appendChild(csr);
  return csr;
}

/**
 * Re-insere um trecho apagado NO OFFSET do parágrafo, clonando o shell de `refCsr`
 * (atributos + Properties) para preservar o estilo/formatação local do próprio run
 * de onde o texto foi removido. Marca com a condition indicada ("Texto removido").
 */
export function insertRemovedRun(psr, offset, text, refCsr, conditionRef) {
  const doc = psr.ownerDocument;
  normalizePsr(psr);
  splitBoundaryAt(psr, offset);

  const csr = cloneCsrShell(refCsr);
  const cur = (csr.getAttribute('AppliedConditions') || '').split(/\s+/).filter(Boolean);
  if (conditionRef && !cur.includes(conditionRef)) cur.push(conditionRef);
  if (cur.length) csr.setAttribute('AppliedConditions', cur.join(' '));
  const content = doc.createElement('Content');
  content.textContent = text;
  csr.appendChild(content);

  let acc = 0, alvo = null;
  for (const c of childElements(psr, 'CharacterStyleRange')) {
    if (acc >= offset) { alvo = c; break; }
    acc += childElements(c, 'Content').reduce((s, ct) => s + ct.textContent.length, 0);
  }
  if (alvo) alvo.parentNode.insertBefore(csr, alvo);
  else psr.appendChild(csr);
  return csr;
}

/**
 * Aplica a condition ao <Br/> terminal (caractere de fim de parágrafo) — usado
 * na remoção de um parágrafo inteiro, para que a quebra também seja removida.
 * Retorna false se o parágrafo não tem Br terminal (ex.: último da story).
 */
export function applyConditionToBreak(psr, conditionRef) {
  const csrs = childElements(psr, 'CharacterStyleRange');
  for (let i = csrs.length - 1; i >= 0; i--) {
    if (childElements(csrs[i], 'Br').length) {
      const cur = (csrs[i].getAttribute('AppliedConditions') || '').split(/\s+/).filter(Boolean);
      if (!cur.includes(conditionRef)) cur.push(conditionRef);
      csrs[i].setAttribute('AppliedConditions', cur.join(' '));
      return true;
    }
  }
  return false;
}

/** Aplica uma condition (AppliedConditions) à seleção — divide os runs no ponto. */
export function applyConditionToOffsets(psr, start, end, conditionSelf) {
  if (end <= start || !conditionSelf) return;
  for (const csr of selecionarRuns(psr, start, end)) {
    const cur = (csr.getAttribute('AppliedConditions') || '').split(/\s+/).filter(Boolean);
    if (!cur.includes(conditionSelf)) cur.push(conditionSelf);
    csr.setAttribute('AppliedConditions', cur.join(' '));
  }
}

/** Remove uma condition da seleção (desfazer marcação). */
export function removeConditionFromOffsets(psr, start, end, conditionSelf) {
  if (end <= start) return;
  for (const csr of selecionarRuns(psr, start, end)) desaplicarCond(csr, conditionSelf);
}

/** Remove uma condition do <Br/> terminal do parágrafo. */
export function removeConditionFromBreak(psr, conditionSelf) {
  for (const csr of childElements(psr, 'CharacterStyleRange'))
    if (childElements(csr, 'Br').length) desaplicarCond(csr, conditionSelf);
}

function desaplicarCond(csr, conditionSelf) {
  const cur = (csr.getAttribute('AppliedConditions') || '').split(/\s+/).filter(Boolean).filter(c => c !== conditionSelf);
  if (cur.length) csr.setAttribute('AppliedConditions', cur.join(' '));
  else csr.removeAttribute('AppliedConditions');
}

/**
 * Localiza os estilos de caractere de itálico e de sobrescrito DEFINIDOS no
 * documento (pelos atributos resolvidos, não pelo nome). Retorna o Self de cada
 * um ou null quando não existe — a UI só oferece o botão se houver estilo.
 */
export function findCharacterStyles(doc) {
  const bySelf = new Map();
  for (const el of Array.from(doc.getElementsByTagName('CharacterStyle'))) {
    const self = el.getAttribute('Self');
    if (self && !self.includes('[No ')) bySelf.set(self, el);
  }
  let italic = null, superscript = null;
  for (const [self, el] of bySelf) {
    const props = resolveStyleProps(el, bySelf);
    const fs = props.FontStyle || '';
    if (!italic && /italic/i.test(fs) && !/bold/i.test(fs)) italic = self;
    if (!superscript && props.Position === 'Superscript') superscript = self;
  }
  return { italic, superscript };
}

/**
 * Offset (em caracteres do corpo do parágrafo) onde começa um dado <Content>.
 * Retorna -1 se o nó não for um Content de corpo do parágrafo. Usado para
 * ancorar marcações por run sem recalcular offsets no app.
 */
export function contentStartOffset(psr, content) {
  for (const { node, from } of bodyContents(psr)) if (node === content) return from;
  return -1;
}

/**
 * Há algum texto de corpo "vivo" (NÃO marcado com `conditionRef`) a partir de
 * `offset`? Usado para decidir se um ENTER no fim visível de um parágrafo deve
 * inserir um parágrafo limpo (como o botão +) em vez de arrastar conteúdo
 * removido para o novo parágrafo. Ignora Content vazio.
 */
export function hasLiveTextFrom(psr, offset, conditionRef) {
  for (const { csr, to, node } of bodyContents(psr)) {
    if (to <= offset || !node.textContent) continue;
    const conds = (csr.getAttribute('AppliedConditions') || '').split(/\s+/).filter(Boolean);
    if (!conds.includes(conditionRef)) return true;
  }
  return false;
}

/**
 * Mapeia o Self de cada ParagraphStyle ao seu nível de heading (1–4), lido da
 * tag de exportação EPUB do InDesign: um <StyleExportTagMap ExportType="EPUB"
 * ExportTag="h1"/> dentro do estilo. Só considera h1..h4. Retorna Map(self→nível).
 */
export function headingLevels(doc) {
  const map = new Map();
  for (const ps of Array.from(doc.getElementsByTagName('ParagraphStyle'))) {
    const self = ps.getAttribute('Self');
    if (!self) continue;
    for (const tm of Array.from(ps.getElementsByTagName('StyleExportTagMap'))) {
      if (tm.getAttribute('ExportType') !== 'EPUB') continue;
      const m = /^h([1-4])$/i.exec((tm.getAttribute('ExportTag') || '').trim());
      if (m) { map.set(self, Number(m[1])); break; }
    }
  }
  return map;
}

/**
 * Localiza `termo` no texto VIVO do parágrafo (ignora trechos já marcados com
 * `refRem`, isto é, "removidos"). Retorna [{start,end}] em offsets do corpo
 * (compatíveis com applyConditionToOffsets/replaceRange). `caseSensitive` liga a
 * distinção de caixa.
 */
export function findMatchesInParagraph(psr, termo, caseSensitive, refRem) {
  if (!termo) return [];
  const full = paragraphBodyText(psr);
  const hay = caseSensitive ? full : full.toLowerCase();
  const needle = caseSensitive ? termo : termo.toLowerCase();

  const struck = [];
  for (const { csr, from, to } of bodyContents(psr)) {
    const conds = (csr.getAttribute('AppliedConditions') || '').split(/\s+/).filter(Boolean);
    if (refRem && conds.includes(refRem)) struck.push([from, to]);
  }
  const tocaStruck = (s, e) => struck.some(([a, b]) => s < b && e > a);

  const out = [];
  let i = 0;
  while (i <= hay.length) {
    const k = hay.indexOf(needle, i);
    if (k < 0) break;
    const s = k, e = k + needle.length;
    if (!tocaStruck(s, e)) out.push({ start: s, end: e });
    i = k + needle.length;      // sem sobreposição
  }
  return out;
}

/**
 * Substitui o trecho [start,end): marca o texto antigo como "Texto removido"
 * (mantido tachado) e insere `novo` logo após, marcado como "Texto alterado" e
 * herdando o estilo do run onde o trecho começa (limpa qualquer removido herdado
 * no texto novo). É a mesma semântica de uma edição manual (apagar + digitar).
 */
export function replaceRange(psr, start, end, novo, refRem, refEd) {
  const doc = psr.ownerDocument;
  // Estilo do run onde o trecho começa (capturado antes de qualquer split).
  let estiloCsr = null;
  for (const { csr, from, to } of bodyContents(psr)) {
    if (start >= from && start < to) { estiloCsr = csr; break; }
  }
  if (end > start && refRem) applyConditionToOffsets(psr, start, end, refRem);

  if (novo) {
    normalizePsr(psr);
    splitBoundaryAt(psr, end);
    const shell = estiloCsr ? cloneCsrShell(estiloCsr) : doc.createElement('CharacterStyleRange');
    if (!estiloCsr) shell.setAttribute('AppliedCharacterStyle', SEM_ESTILO_CHAR);
    if (refEd) shell.setAttribute('AppliedConditions', refEd);   // só "alterado"
    else shell.removeAttribute('AppliedConditions');
    const content = doc.createElement('Content');
    content.textContent = novo;
    shell.appendChild(content);

    let acc = 0, alvo = null;
    for (const c of childElements(psr, 'CharacterStyleRange')) {
      if (acc >= end) { alvo = c; break; }
      acc += childElements(c, 'Content').reduce((s, ct) => s + ct.textContent.length, 0);
    }
    if (alvo) alvo.parentNode.insertBefore(shell, alvo);
    else psr.appendChild(shell);
  }
}

// Lista os <Content> de corpo com seus CSRs e offsets acumulados (exclui notas).
function bodyContents(psr) {
  const out = [];
  let offset = 0;
  for (const csr of childElements(psr, 'CharacterStyleRange')) {
    for (const content of childElements(csr, 'Content')) {
      const len = content.textContent.length;
      out.push({ node: content, csr, from: offset, to: offset + len });
      offset += len;
    }
  }
  return out;
}

// Garante que cada CharacterStyleRange contenha no máximo um item inline
// (Content, Br ou Note), clonando atributos e Properties para os novos CSRs.
function normalizePsr(psr) {
  for (const csr of childElements(psr, 'CharacterStyleRange')) {
    const items = Array.from(csr.childNodes).filter(
      n => n.nodeType === 1 && n.tagName !== 'Properties'
    );
    if (items.length <= 1) continue;
    // items[0] permanece no CSR original; cada item seguinte vira um CSR clonado,
    // encadeado logo após o anterior para manter a ordem do documento.
    let anchor = csr;
    for (let i = 1; i < items.length; i++) {
      const clone = cloneCsrShell(csr);
      clone.appendChild(items[i]); // appendChild move o nó para fora do CSR original
      anchor.parentNode.insertBefore(clone, anchor.nextSibling);
      anchor = clone;
    }
  }
}

// Divide o CSR que contém `offset` para que exista uma fronteira exatamente ali.
function splitBoundaryAt(psr, offset) {
  const total = paragraphBodyText(psr).length;
  if (offset <= 0 || offset >= total) return;
  for (const { node: content, csr, from, to } of bodyContents(psr)) {
    if (offset > from && offset < to) {
      const local = offset - from;
      const full  = content.textContent;
      const rest  = full.slice(local);
      setContentText(content, full.slice(0, local));   // preserva <?ACE?> na 1ª parte
      const clone = cloneCsrShell(csr);
      const newContent = content.ownerDocument.createElement('Content');
      newContent.textContent = rest;
      clone.appendChild(newContent);
      csr.parentNode.insertBefore(clone, csr.nextSibling);
      return;
    }
  }
}

// Clona um CSR só com seus atributos e o bloco <Properties> (sem itens inline).
function cloneCsrShell(csr) {
  const shell = csr.cloneNode(false);
  const props = first(childElements(csr, 'Properties'));
  if (props) shell.appendChild(props.cloneNode(true));
  return shell;
}

/**
 * Cria e insere uma <Note> logo após um nó de conteúdo, com o texto informado.
 * A nota segue o mesmo esquema PSR>CSR>Content usado pelo InDesign/InCopy.
 */
export function insertNote(doc, contentNode, texto, { userName = 'Revisor', documentUser = 'dDocumentUser0' } = {}) {
  const now = new Date().toISOString().slice(0, 19);
  const note = doc.createElement('Note');
  note.setAttribute('Collapsed', 'false');
  note.setAttribute('CreationDate', now);
  note.setAttribute('ModificationDate', now);
  note.setAttribute('UserName', userName);
  note.setAttribute('AppliedDocumentUser', documentUser);

  const psr = doc.createElement('ParagraphStyleRange');
  psr.setAttribute('AppliedParagraphStyle', 'ParagraphStyle/$ID/[No paragraph style]');
  const csr = doc.createElement('CharacterStyleRange');
  csr.setAttribute('AppliedCharacterStyle', 'CharacterStyle/$ID/[No character style]');
  const content = doc.createElement('Content');
  content.textContent = texto;

  csr.appendChild(content);
  psr.appendChild(csr);
  note.appendChild(psr);

  contentNode.parentNode.insertBefore(note, contentNode.nextSibling);
  return note;
}

/**
 * Insere uma nota no offset preciso do corpo do parágrafo, dividindo o
 * <Content> no ponto exato quando o cursor cai no meio de um texto.
 */
export function insertNoteAtOffset(doc, psr, offset, texto, opts) {
  const contents = bodyContents(psr);
  if (!contents.length) return null;

  let hit = contents[contents.length - 1];
  for (const c of contents) { if (offset <= c.to) { hit = c; break; } }

  const local = offset - hit.from;
  const full  = hit.node.textContent;
  if (local > 0 && local < full.length) {
    const second = doc.createElement('Content');
    second.textContent = full.slice(local);
    hit.node.textContent = full.slice(0, local);
    hit.node.parentNode.insertBefore(second, hit.node.nextSibling);
  }
  return insertNote(doc, hit.node, texto, opts);
}

/** Aparência CSS de cada estilo de parágrafo (resolve BasedOn). */
export function paragraphStyleAppearances(doc) {
  return styleAppearances(doc, 'ParagraphStyle');
}
/** Aparência CSS de cada estilo de caractere (resolve BasedOn). */
export function characterStyleAppearances(doc) {
  return styleAppearances(doc, 'CharacterStyle');
}

// Constrói o mapa Self → aparência {fontSize, textAlign, color, fontWeight,
// fontStyle, underline, name} para todos os estilos de um tipo, considerando a
// herança por BasedOn e traduzindo PointSize/Justification/FillColor/FontStyle.
function styleAppearances(doc, tag) {
  const bySelf = new Map();
  for (const el of Array.from(doc.getElementsByTagName(tag))) {
    const self = el.getAttribute('Self');
    if (self) bySelf.set(self, el);
  }
  const cores = buildColorMap(doc);
  const out = new Map();
  for (const [self, el] of bySelf) {
    const props = resolveStyleProps(el, bySelf);
    out.set(self, appearanceToCss(props, cores, el.getAttribute('Name') || ''));
  }
  // Cor do marcador vinda do BulletsCharacterStyle (um estilo de caractere): só
  // faz sentido em estilos de parágrafo. Resolve o FillColor do estilo referido.
  if (tag === 'ParagraphStyle') {
    const charBySelf = new Map();
    for (const el of Array.from(doc.getElementsByTagName('CharacterStyle'))) {
      const s = el.getAttribute('Self');
      if (s) charBySelf.set(s, el);
    }
    for (const css of out.values()) {
      if (!css.bulletCharStyleRef) continue;
      const cel = charBySelf.get(css.bulletCharStyleRef);
      if (!cel) continue;
      const cp = resolveStyleProps(cel, charBySelf);
      if (cp.FillColor && cores.has(cp.FillColor)) css.bulletCor = comTint(cores.get(cp.FillColor), cp.FillTint);
    }
  }
  return out;
}

// FontStyle efetivo (resolvendo BasedOn) de cada estilo de caractere e de
// parágrafo → { char: Map(self→FontStyle), para: Map(self→FontStyle) }. Usado
// pela verificação de integridade p/ determinar negrito/itálico por trecho.
export function styleFontStyles(doc) {
  const build = tag => {
    const bySelf = new Map();
    for (const el of Array.from(doc.getElementsByTagName(tag))) {
      const self = el.getAttribute('Self');
      if (self) bySelf.set(self, el);
    }
    const out = new Map();
    for (const [self, el] of bySelf) {
      const fs = resolveStyleProps(el, bySelf).FontStyle;
      if (fs) out.set(self, fs);
    }
    return out;
  };
  return { char: build('CharacterStyle'), para: build('ParagraphStyle') };
}

// Resolve os 4 atributos de aparência percorrendo a cadeia BasedOn (o próprio
// estilo sobrepõe o que herda).
function resolveStyleProps(el, bySelf, seen = new Set()) {
  if (!el || seen.has(el)) return {};
  seen.add(el);
  const basedOn = getBasedOn(el);
  const herdado = resolveStyleProps(basedOn ? bySelf.get(basedOn) : null, bySelf, seen);
  const proprio = {
    PointSize:     el.getAttribute('PointSize'),
    Justification: el.getAttribute('Justification'),
    FillColor:     el.getAttribute('FillColor'),
    FillTint:      el.getAttribute('FillTint'),
    FontStyle:     el.getAttribute('FontStyle'),
    Underline:      el.getAttribute('Underline'),
    UnderlineWeight: el.getAttribute('UnderlineWeight'),
    UnderlineOffset: el.getAttribute('UnderlineOffset'),
    UnderlineTint:   el.getAttribute('UnderlineTint'),
    UnderlineColor:  getPropObject(el, 'UnderlineColor'),
    AppliedFont:   getAppliedFont(el),
    LeftIndent:    el.getAttribute('LeftIndent'),
    RightIndent:   el.getAttribute('RightIndent'),
    FirstLineIndent: el.getAttribute('FirstLineIndent'),
    TabPosition:   getFirstTabPosition(el),
    SpaceBefore:   el.getAttribute('SpaceBefore'),
    SpaceAfter:    el.getAttribute('SpaceAfter'),
    SameParaSpacing: getPropObject(el, 'SameParaStyleSpacing'),
    ListType:      el.getAttribute('BulletsAndNumberingListType'),
    BulletCharValue: getPropAttr(el, 'BulletChar', 'BulletCharacterValue'),
    BulletsFont:     getPropObject(el, 'BulletsFont'),
    BulletsCharStyle: getPropObject(el, 'BulletsCharacterStyle'),
    Position:      el.getAttribute('Position'),
    ShadingOn:     el.getAttribute('ParagraphShadingOn'),
    ShadingTint:   el.getAttribute('ParagraphShadingTint'),
    ShadingColor:  getPropObject(el, 'ParagraphShadingColor'),
    ShadingWidth:  el.getAttribute('ParagraphShadingWidth'),
    ShadingLeftOffset:  el.getAttribute('ParagraphShadingLeftOffset'),
    ShadingRightOffset: el.getAttribute('ParagraphShadingRightOffset'),
    ShadingTopOffset:    el.getAttribute('ParagraphShadingTopOffset'),
    ShadingBottomOffset: el.getAttribute('ParagraphShadingBottomOffset'),
    ShadingCornerOptTL: el.getAttribute('ParagraphShadingTopLeftCornerOption'),
    ShadingCornerOptTR: el.getAttribute('ParagraphShadingTopRightCornerOption'),
    ShadingCornerOptBR: el.getAttribute('ParagraphShadingBottomRightCornerOption'),
    ShadingCornerOptBL: el.getAttribute('ParagraphShadingBottomLeftCornerOption'),
    ShadingRadiusTL: el.getAttribute('ParagraphShadingTopLeftCornerRadius'),
    ShadingRadiusTR: el.getAttribute('ParagraphShadingTopRightCornerRadius'),
    ShadingRadiusBR: el.getAttribute('ParagraphShadingBottomRightCornerRadius'),
    ShadingRadiusBL: el.getAttribute('ParagraphShadingBottomLeftCornerRadius'),
    SplitDocument:  el.getAttribute('SplitDocument'),
    StartParagraph: el.getAttribute('StartParagraph'),
    BorderOn:      el.getAttribute('ParagraphBorderOn'),
    MergeBorders:  el.getAttribute('MergeConsecutiveParaBorders'),
    BorderColor:   getPropObject(el, 'ParagraphBorderColor'),
    BorderType:    getPropObject(el, 'ParagraphBorderType'),
    BorderTint:    el.getAttribute('ParagraphBorderTint'),
    BorderTop:     el.getAttribute('ParagraphBorderTopLineWeight'),
    BorderBottom:  el.getAttribute('ParagraphBorderBottomLineWeight'),
    BorderLeft:    el.getAttribute('ParagraphBorderLeftLineWeight'),
    BorderRight:   el.getAttribute('ParagraphBorderRightLineWeight'),
    BorderLeftOffset:   el.getAttribute('ParagraphBorderLeftOffset'),
    BorderRightOffset:  el.getAttribute('ParagraphBorderRightOffset'),
    BorderTopOffset:    el.getAttribute('ParagraphBorderTopOffset'),
    BorderBottomOffset: el.getAttribute('ParagraphBorderBottomOffset'),
    BorderRadiusTL: el.getAttribute('ParagraphBorderTopLeftCornerRadius'),
    BorderRadiusTR: el.getAttribute('ParagraphBorderTopRightCornerRadius'),
    BorderRadiusBR: el.getAttribute('ParagraphBorderBottomRightCornerRadius'),
    BorderRadiusBL: el.getAttribute('ParagraphBorderBottomLeftCornerRadius'),
    CornerOptTL:    el.getAttribute('ParagraphBorderTopLeftCornerOption'),
    CornerOptTR:    el.getAttribute('ParagraphBorderTopRightCornerOption'),
    CornerOptBR:    el.getAttribute('ParagraphBorderBottomRightCornerOption'),
    CornerOptBL:    el.getAttribute('ParagraphBorderBottomLeftCornerOption'),
  };
  const merged = { ...herdado };
  for (const k in proprio) if (proprio[k] != null) merged[k] = proprio[k];
  return merged;
}

function getBasedOn(el) {
  const props = first(childElements(el, 'Properties'));
  if (!props) return null;
  const bo = first(childElements(props, 'BasedOn'));
  return bo ? bo.textContent.trim() : null;
}

function getAppliedFont(el) {
  return getPropObject(el, 'AppliedFont');
}

// Lê um valor de <Properties> por tag (ex.: AppliedFont, ParagraphShadingColor).
function getPropObject(el, tag) {
  const props = first(childElements(el, 'Properties'));
  if (!props) return null;
  const node = first(childElements(props, tag));
  return node ? node.textContent.trim() : null;
}

// Posição do primeiro tab (Properties > TabList > ListItem > Position), em pt.
function getFirstTabPosition(el) {
  const props = first(childElements(el, 'Properties'));
  if (!props) return null;
  const tabList = first(childElements(props, 'TabList'));
  if (!tabList) return null;
  const item = first(childElements(tabList, 'ListItem'));
  if (!item) return null;
  const pos = first(childElements(item, 'Position'));
  return pos ? pos.textContent.trim() : null;
}

// Lê um atributo de um filho de <Properties> (ex.: BulletChar/BulletCharacterValue).
function getPropAttr(el, tag, attr) {
  const props = first(childElements(el, 'Properties'));
  if (!props) return null;
  const node = first(childElements(props, tag));
  return node && node.hasAttribute(attr) ? node.getAttribute(attr) : null;
}

// "Inter 18pt" → "Inter": remove sufixos de tamanho óptico para o nome Google.
// Remove um eventual tamanho anexado ao nome (ex.: "Fonte 10pt") — exigindo a
// unidade pt/px. NÃO remove números que fazem parte do nome da família, como
// "Source Serif 4" ou "Source Sans 3".
function baseFontName(name) {
  return name.replace(/\s+\d+(\.\d+)?\s*(pt|px)$/i, '').trim();
}

// Monta o valor CSS font-family: nome exato, nome base (Google) e um fallback
// genérico inferido do nome.
function fontStack(name) {
  const base = baseFontName(name);
  const serif = /minion|garamond|times|georgia|caslon|mincho|ming|song|serif/i.test(name)
    && !/sans/i.test(name);
  const partes = [`"${name}"`];
  if (base !== name) partes.push(`"${base}"`);
  partes.push(serif ? 'serif' : 'sans-serif');
  return partes.join(', ');
}

// Fator de zoom do editor: 1pt = 1.6px, de modo que 10pt → 16px na tela
// (o padrão do CSS seria ~1.333px/pt). Preserva as proporções entre estilos.
const PT_TO_PX = 1.6;

function appearanceToCss(props, cores, name) {
  const css = { name };
  if (props.PointSize) {
    const pt = parseFloat(props.PointSize);
    css.fontSize = `${pt * PT_TO_PX}px`;
    // Fontes acima de 12pt são tipicamente títulos: entrelinha reduzida
    // proporcionalmente ao tamanho (quanto maior a fonte, mais apertada).
    if (pt > 12) css.lineHeight = Math.max(1.05, 1.3 - (pt - 12) * 0.02);
  }
  if (props.Justification) css.textAlign = mapJustification(props.Justification);
  // Cor do texto: aplica o FillTint como intensidade (ex.: preto + FillTint="80"
  // → preto 80%). comTint ignora -1/100 (cor cheia) e valores fora de 0–100.
  if (props.FillColor && cores.has(props.FillColor)) css.color = comTint(cores.get(props.FillColor), props.FillTint);
  if (props.FontStyle) {
    css.fontWeight = mapFontWeight(props.FontStyle);
    if (/italic|oblique/i.test(props.FontStyle)) css.fontStyle = 'italic';
  }
  if (props.AppliedFont) {
    css.fontName   = props.AppliedFont;              // nome original (p/ carregar)
    css.fontFamily = fontStack(props.AppliedFont);   // stack CSS c/ fallback
  }
  if (props.LeftIndent  && parseFloat(props.LeftIndent)  > 0) css.marginLeft  = `${parseFloat(props.LeftIndent)  * PT_TO_PX}px`;
  if (props.RightIndent && parseFloat(props.RightIndent) > 0) css.marginRight = `${parseFloat(props.RightIndent) * PT_TO_PX}px`;
  // Espaço antes/depois do parágrafo (SpaceBefore/SpaceAfter, pt→px). Usado no
  // espaçamento das caixas (espacarCaixas) para respeitar o valor do estilo.
  if (props.SpaceBefore && parseFloat(props.SpaceBefore) > 0) css.spaceBefore = `${(parseFloat(props.SpaceBefore) * PT_TO_PX).toFixed(1)}px`;
  if (props.SpaceAfter  && parseFloat(props.SpaceAfter)  > 0) css.spaceAfter  = `${(parseFloat(props.SpaceAfter)  * PT_TO_PX).toFixed(1)}px`;
  // "Espaço entre parágrafos do mesmo estilo" (SameParaStyleSpacing): usado no lugar
  // de SpaceBefore/After entre dois parágrafos do MESMO estilo (geralmente menor).
  if (props.SameParaSpacing != null && props.SameParaSpacing !== '') {
    const v = parseFloat(props.SameParaSpacing);
    if (!isNaN(v)) css.sameStyleSpacing = `${(v * PT_TO_PX).toFixed(1)}px`;
  }
  if (props.ListType === 'BulletList') {
    css.bullet = true;
    // Caractere do marcador (BulletChar): code point Unicode → caractere. Ex.:
    // 128161 → 💡. Sem valor, o CSS mantém o "•" padrão.
    const cp = parseInt(props.BulletCharValue, 10);
    if (cp > 0) { try { css.bulletChar = String.fromCodePoint(cp); } catch { /* code point inválido */ } }
    // Fonte do marcador (BulletsFont): usa o nome exato + fallbacks de emoji (o
    // 💡 depende de uma fonte de emoji; "Segoe UI Emoji" existe no Windows).
    if (props.BulletsFont) {
      css.bulletFont = `"${props.BulletsFont}", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    }
    // Estilo de caractere do marcador (BulletsCharacterStyle) → cor. Resolvido em
    // styleAppearances (precisa do mapa de estilos de caractere).
    if (props.BulletsCharStyle) css.bulletCharStyleRef = props.BulletsCharStyle;
    // Distância marcador→texto = posição do 1º tab − início do marcador
    // (LeftIndent + FirstLineIndent). No InDesign a lista usa um tab após o
    // marcador; ex.: tab 10mm, marcador em 4mm → 6mm (24px). 4px/mm, piso 10px.
    const li = parseFloat(props.LeftIndent) || 0;
    const fli = parseFloat(props.FirstLineIndent) || 0;
    const tab = parseFloat(props.TabPosition);
    if (!isNaN(tab)) css.bulletGap = `${Math.max(10, (tab - li - fli) / 2.834645669 * 4).toFixed(1)}px`;
  }
  if (props.Position === 'Superscript') css.verticalAlign = 'super';
  else if (props.Position === 'Subscript') css.verticalAlign = 'sub';

  // Borda de parágrafo: cada lado tem sua espessura (pt → px × 2, p/ aproximar a
  // aparência do InDesign, onde a linha se mostra mais grossa). Cor de
  // ParagraphBorderColor (preto se ausente). Com borda, padding padrão de 6px.
  if (props.BorderOn === 'true') {
    const corBase = (props.BorderColor && cores.get(props.BorderColor)) || 'rgb(0, 0, 0)';
    const cor = comTint(corBase, props.BorderTint);
    // Tipo de traço: "Solid" → linha cheia; qualquer outro (ex.: "Japanese Dots",
    // "Canned Dotted", "Dashed") → tracejado.
    const traco = /solid/i.test(props.BorderType || 'Solid') ? 'solid' : 'dashed';
    // Se BorderOn e NENHUM lado tem peso explícito, usa o padrão do InDesign (1pt).
    const semExplicito = [props.BorderTop, props.BorderBottom, props.BorderLeft, props.BorderRight].every(w => w == null);
    const lado = w => {
      let v = parseFloat(w);
      if (isNaN(v) && semExplicito) v = 1;
      return v > 0 ? `${v * 2}px ${traco} ${cor}` : null;
    };
    const bt = lado(props.BorderTop), bb = lado(props.BorderBottom);
    const bl = lado(props.BorderLeft), br = lado(props.BorderRight);
    if (bt) css.borderTop = bt;
    if (bb) css.borderBottom = bb;
    if (bl) css.borderLeft = bl;
    if (br) css.borderRight = br;
    if (bt || bb || bl || br) {
      // (Padding interno e margem da caixa são definidos no bloco unificado abaixo,
      // que também cobre caixas só com shading.)
      // Cantos arredondados (raio do ICML, pt→px na escala do editor). Só arredonda
      // um canto quando: (a) seu CornerOption é RoundedCorner — ausente/None/Bevel
      // fica reto, mesmo havendo um raio herdado; e (b) os DOIS lados vizinhos têm
      // borda (uma linha só à esquerda continua reta, sem curvar as pontas).
      const raio = (v, ok) => { const n = parseFloat(v); return (ok && n > 0) ? `${(n * PT_TO_PX).toFixed(1)}px` : '0'; };
      const arred = opt => opt === 'RoundedCorner';
      const tl  = raio(props.BorderRadiusTL, bt && bl && arred(props.CornerOptTL));
      const tr  = raio(props.BorderRadiusTR, bt && br && arred(props.CornerOptTR));
      const brr = raio(props.BorderRadiusBR, bb && br && arred(props.CornerOptBR));
      const blr = raio(props.BorderRadiusBL, bb && bl && arred(props.CornerOptBL));
      css.borderRadius = (tl === '0' && tr === '0' && brr === '0' && blr === '0') ? '0' : `${tl} ${tr} ${brr} ${blr}`;
    }
  }

  // ParagraphShading → fundo do parágrafo. Sempre traduzido quando ligado e com
  // cor real (Swatch/None não pinta).
  if (props.ShadingOn === 'true' && props.ShadingColor && props.ShadingColor !== 'Swatch/None'
      && cores.has(props.ShadingColor)) {
    css.backgroundColor = comTint(cores.get(props.ShadingColor), props.ShadingTint);
    // "Largura = texto" (ParagraphShadingWidth=TextWidth): o fundo abraça o texto
    // em vez de ocupar a coluna inteira → caixa shrink-to-fit.
    if (props.ShadingWidth === 'TextWidth') {
      css.widthText = true;
      // O recuo real do texto (alinhado aos parágrafos vizinhos) é LeftIndent menos
      // o offset de borda: numa caixa TextWidth o InDesign guarda nesse offset a
      // compensação de moldura que faz o texto alinhar com os blocos ao redor.
      const li = parseFloat(props.LeftIndent) || 0;
      const blo = parseFloat(props.BorderLeftOffset) || 0;
      // Numa caixa "largura = texto", os offsets do shading estendem o fundo além do
      // texto em cada lado (ex.: ShadingLeftOffset 6mm → 24px de teal à esquerda do
      // texto). 4px/mm; pisos pequenos p/ o texto não colar. O padding esquerdo é
      // compensado na margem para o conteúdo (e o marcador) ficar na mesma posição —
      // só a caixa se expande.
      const MM = 2.834645669;
      const sOff = (off, min) => { const v = Math.abs(parseFloat(off)); return isNaN(v) ? min : Math.max(min, v / MM * 4); };
      const sl = sOff(props.ShadingLeftOffset, 5), sr = sOff(props.ShadingRightOffset, 5);
      const st = sOff(props.ShadingTopOffset, 4),  sb = sOff(props.ShadingBottomOffset, 4);
      if (css.bullet && css.bulletGap) {
        // Lista com tab: a caixa começa a ShadingLeftOffset da margem da página (sem
        // vazar para fora dela), com uma base pequena de 2px até o marcador; o texto
        // cai na posição do tab via --bullet-w (somado ao padding no app.js).
        css.padding = `${st.toFixed(1)}px ${sr.toFixed(1)}px ${sb.toFixed(1)}px 2px`;
        css.marginLeft = `${sl.toFixed(1)}px`;
      } else {
        css.padding = `${st.toFixed(1)}px ${sr.toFixed(1)}px ${sb.toFixed(1)}px ${sl.toFixed(1)}px`;
        css.marginLeft = `${((li - blo) * PT_TO_PX - (sl - 5)).toFixed(1)}px`;
      }
    }
  }
  // Padding interno das caixas (borda e/ou shading). Gap borda↔texto = magnitude do
  // offset de cada lado (|offset|, positivo ou negativo): 11pt/4mm → 16px (4px/mm).
  // Usa o offset de borda quando há borda no estilo, senão o de shading; sem offset,
  // piso de 5px de respiro. Recua a margem esquerda/direita pelo excedente sobre 5px
  // para o texto permanecer no LeftIndent (a borda é que se afasta). Só ColumnWidth;
  // TextWidth (abraça o texto) já teve o padding definido acima.
  const temBorda = !!(css.borderTop || css.borderBottom || css.borderLeft || css.borderRight);
  const ehCaixaColuna = (temBorda || !!css.backgroundColor)
    && props.BorderWidth !== 'TextWidth' && props.ShadingWidth !== 'TextWidth';
  if (ehCaixaColuna) {
    const MM = 2.834645669;   // pt por mm
    const usaBorda = props.BorderOn === 'true';
    const off = (bo, so) => parseFloat(usaBorda ? bo : so) || 0;   // offset em pt (0 se ausente)
    const li = parseFloat(props.LeftIndent) || 0, ri = parseFloat(props.RightIndent) || 0;
    // ColumnWidth: as bordas esq/dir ficam na coluna e o texto é recuado pelo Indent
    // → gap = Indent + Offset (offset negativo aproxima a borda do texto). Topo/base
    // ficam rente ao texto → gap = |offset|. Escala 4px/mm (11pt/4mm → 16px), piso 5px.
    const px    = pt => Math.max(5, pt / MM * 4);
    const pxAbs = pt => Math.max(5, Math.abs(pt) / MM * 4);
    const pL = px(li + off(props.BorderLeftOffset,  props.ShadingLeftOffset));
    const pR = px(ri + off(props.BorderRightOffset, props.ShadingRightOffset));
    const pT = pxAbs(off(props.BorderTopOffset,     props.ShadingTopOffset));
    const pB = pxAbs(off(props.BorderBottomOffset,  props.ShadingBottomOffset));
    css.padding = `${pT.toFixed(1)}px ${pR.toFixed(1)}px ${pB.toFixed(1)}px ${pL.toFixed(1)}px`;
    // Mantém o texto na posição atual (LeftIndent + respiro) recuando a borda p/ fora.
    css.marginLeft  = `${Math.max(0, li * PT_TO_PX - (pL - 5)).toFixed(1)}px`;
    css.marginRight = `${Math.max(0, ri * PT_TO_PX - (pR - 5)).toFixed(1)}px`;
  }

  // Cantos do shading: cada canto só arredonda quando seu CornerOption é
  // RoundedCorner (ausente/None/Bevel fica reto). Ex.: "Dica prática" tem topo
  // arredondado e base reta. Só aplica quando há fundo e a borda ainda não definiu
  // o raio (a borda tem precedência quando existe).
  if (css.backgroundColor && css.borderRadius == null) {
    const arred = opt => opt === 'RoundedCorner';
    const raio = (v, ok) => { const n = parseFloat(v); return (ok && n > 0) ? `${(n * PT_TO_PX).toFixed(1)}px` : '0'; };
    const tl  = raio(props.ShadingRadiusTL, arred(props.ShadingCornerOptTL));
    const tr  = raio(props.ShadingRadiusTR, arred(props.ShadingCornerOptTR));
    const brr = raio(props.ShadingRadiusBR, arred(props.ShadingCornerOptBR));
    const blr = raio(props.ShadingRadiusBL, arred(props.ShadingCornerOptBL));
    if (!(tl === '0' && tr === '0' && brr === '0' && blr === '0')) {
      css.borderRadius = `${tl} ${tr} ${brr} ${blr}`;
    }
  }

  // Texto muito claro SEM fundo próprio some na página branca → força preto.
  if (css.color && corClara(css.color) && !css.backgroundColor) css.color = 'rgb(0, 0, 0)';

  // "Mesclar bordas/sombreamento consecutivos com as mesmas configurações"
  // (MergeConsecutiveParaBorders no ICML). Ligado por padrão no InDesign — só não
  // funde parágrafos vizinhos quando o estilo desliga a opção explicitamente.
  css.mergeBorders = props.MergeBorders !== 'false';

  // Underline: aplica e, quando o ICML define, traduz cor, espessura (pt→px ×2,
  // como as bordas) e deslocamento.
  if (props.Underline === 'true' || /sublinhad|underline/i.test(name)) {
    css.underline = true;
    if (props.UnderlineColor && cores.has(props.UnderlineColor))
      css.underlineColor = comTint(cores.get(props.UnderlineColor), props.UnderlineTint);
    const uw = parseFloat(props.UnderlineWeight);
    if (uw > 0) css.underlineThickness = `${(uw * 2).toFixed(1)}px`;
    const uo = parseFloat(props.UnderlineOffset);
    if (!isNaN(uo)) css.underlineOffset = `${(uo * PT_TO_PX).toFixed(1)}px`;
  }

  // Estilos de título (pelo nome/grupo) ganham mais espaço antes e depois — o
  // de antes um pouco maior. SplitDocument="true" ou StartParagraph="NextOddPage"
  // indicam início em nova página (separador <hr>).
  if (ehTitulo(name)) css.titulo = true;
  if (props.SplitDocument === 'true' || props.StartParagraph === 'NextOddPage') css.novaPagina = true;

  return css;
}

// Nome/grupo do estilo indica título/capítulo/subtítulo/intertítulo.
function ehTitulo(name) {
  const n = (name || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  return /titulo|tit[.\-]|\bcap\b|cap[.\-]/.test(n);
}

function mapJustification(j) {
  if (/Center/i.test(j))    return 'center';
  if (/Right/i.test(j))     return 'right';
  if (/Justified/i.test(j)) return 'justify';
  return 'left';
}

function mapFontWeight(fs) {
  if (/Black|Heavy/i.test(fs))         return 900;
  if (/Extra ?Bold|Ultra/i.test(fs))   return 800;
  if (/Semi ?Bold|Demi/i.test(fs))     return 600;   // antes de "Bold"
  if (/Bold/i.test(fs))                return 700;
  if (/Medium/i.test(fs))              return 500;
  if (/Extra ?Light/i.test(fs))        return 200;
  if (/Light/i.test(fs))               return 300;
  if (/Thin|Hairline/i.test(fs))       return 100;
  return 400;
}

// Mapa Self → cor CSS, convertendo CMYK/RGB das definições <Color> e resolvendo
// as tintas mistas (<MixedInk>).
function buildColorMap(doc) {
  const map = new Map();
  const cmyk = new Map();   // Self → [c,m,y,k], para resolver os MixedInk
  for (const el of Array.from(doc.getElementsByTagName('Color'))) {
    const self = el.getAttribute('Self');
    if (!self) continue;
    const space = (el.getAttribute('Space') || '').toUpperCase();
    const v = (el.getAttribute('ColorValue') || '').trim().split(/\s+/).map(Number);
    if (space === 'CMYK' && v.length >= 4) { map.set(self, cmykToRgb(v[0], v[1], v[2], v[3])); cmyk.set(self, v.slice(0, 4)); }
    else if (space === 'RGB' && v.length >= 3) map.set(self, `rgb(${v[0]}, ${v[1]}, ${v[2]})`);
  }
  for (const el of Array.from(doc.getElementsByTagName('MixedInk'))) {
    const self = el.getAttribute('Self');
    const rgb = mixedInkToRgb(el, cmyk);
    if (self && rgb) map.set(self, rgb);
  }
  return map;
}

// CMYK de uma tinta: tintas de processo pelo nome; tintas spot pela cor spot
// referenciada (MixedInkSpotColorList) ou por "Color/<nome>".
function inkCmyk(inkRef, spotRef, cmyk) {
  const nome = decodeURIComponent(inkRef.replace(/^Ink\//, ''));
  if (/Process\s+Cyan/i.test(nome))    return [100, 0, 0, 0];
  if (/Process\s+Magenta/i.test(nome)) return [0, 100, 0, 0];
  if (/Process\s+Yellow/i.test(nome))  return [0, 0, 100, 0];
  if (/Process\s+Black/i.test(nome))   return [0, 0, 0, 100];
  const ref = spotRef ? decodeURIComponent(spotRef) : 'Color/' + nome;
  return cmyk.get(ref) || cmyk.get('Color/' + nome) || null;
}

// Combina as tintas de um <MixedInk> numa cor RGB: soma a contribuição CMYK de
// cada tinta pelo seu percentual. InkList e InkPercentages são posicionais; as
// tintas spot alinham com MixedInkSpotColorList (só as não-processo).
function mixedInkToRgb(el, cmyk) {
  const inks = (el.getAttribute('InkList') || '').split(/\s+/).filter(Boolean);
  const pcts = (el.getAttribute('InkPercentages') || '').split(/\s+/).map(Number);
  const spots = (el.getAttribute('MixedInkSpotColorList') || '').split(/\s+/).filter(Boolean);
  if (!inks.length) return null;
  let c = 0, m = 0, y = 0, k = 0, spotIdx = 0;
  inks.forEach((ink, i) => {
    const processo = /Process\s+(Cyan|Magenta|Yellow|Black)/i.test(decodeURIComponent(ink));
    const base = inkCmyk(ink, processo ? null : spots[spotIdx++], cmyk);
    if (!base) return;
    const f = (pcts[i] || 0) / 100;
    c += base[0] * f; m += base[1] * f; y += base[2] * f; k += base[3] * f;
  });
  const cl = v => Math.min(100, Math.max(0, v));
  return cmykToRgb(cl(c), cl(m), cl(y), cl(k));
}

// Interpreta "rgb(r, g, b)" e devolve [r,g,b] ou null.
function parseRgb(css) {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(css || '');
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// Cor branca ou muito clara (luminância relativa alta).
function corClara(css) {
  const rgb = parseRgb(css);
  if (!rgb) return false;
  const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return lum > 0.85;
}

// Aplica um tint (0–100%) misturando a cor com branco, como no InDesign.
function comTint(css, tint) {
  const rgb = parseRgb(css);
  const t = parseFloat(tint);
  if (!rgb || !(t >= 0 && t <= 100)) return css;
  const mix = v => Math.round(255 - (255 - v) * (t / 100));
  return `rgb(${mix(rgb[0])}, ${mix(rgb[1])}, ${mix(rgb[2])})`;
}

// Conversão CMYK→RGB por modelo linear de tintas ("block-dye"), calibrado contra
// o InDesign: RGB = branco − Σ (tinta · vetor de absorção da tinta). A fórmula
// ingênua (255·(1−x)·(1−k)) assume tintas perfeitas e puxa os cianos para o
// verde; os vetores abaixo foram aferidos a olho a partir de pontos calibrados:
//   • Magenta puro CMYK(0,100,0,0) → rgb(237,2,163)  ⇒ A_M = (18, 253, 92)
//   • Amarelo puro CMYK(0,0,100,0) → rgb(249,227,55) ⇒ A_Y = (6, 28, 200)
//   • Preto CMYK(0,0,0,50) → rgb(127,127,127)        ⇒ A_K = (256, 256, 256)
//     (K=50 → 127 e K=100 → 0 por clamp; cinza/preto por K seguem neutros)
//   • "projeto ciano" CMYK(93,25,16,2) → rgb(68,159,233), com A_M/A_Y/A_K aferidos
//     resolve A_C = (188.85, 23.67, −42.23) (ciano do InDesign: mais azul e menos
//     verde). A_C é re-resolvido sempre que A_M/A_Y/A_K mudam.
// Reproduz os pontos calibrados exatamente; vale p/ uso direto, tintas mistas e
// derivadas por tint. Estender/reajustar com novos pontos.
const TINTA_ABS = {
  C: [188.85, 23.67, -42.23],
  M: [18, 253, 92],
  Y: [6, 28, 200],
  K: [256, 256, 256],
};

function cmykToRgb(c, m, y, k) {
  c /= 100; m /= 100; y /= 100; k /= 100;
  const canal = i => {
    const v = 255 - (c * TINTA_ABS.C[i] + m * TINTA_ABS.M[i] + y * TINTA_ABS.Y[i] + k * TINTA_ABS.K[i]);
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  return `rgb(${canal(0)}, ${canal(1)}, ${canal(2)})`;
}

// ── Operações de parágrafo ────────────────────────────────────

const SEM_ESTILO_CHAR = 'CharacterStyle/$ID/[No character style]';

/** Insere um parágrafo novo (vazio ou com texto) logo após `psr`. */
export function insertParagraphAfter(doc, story, psr, { styleSelf, text = '' } = {}) {
  const novo = doc.createElement('ParagraphStyleRange');
  novo.setAttribute('AppliedParagraphStyle', styleSelf || psr.getAttribute('AppliedParagraphStyle'));
  novo.appendChild(makeContentCsr(doc, text));
  psr.parentNode.insertBefore(novo, psr.nextSibling);
  ensureParagraphBreaks(story);
  return novo;
}

/** Insere um parágrafo ANTES de `psr` (usado p/ trecho ausente no início). */
export function insertParagraphBefore(doc, story, psr, { styleSelf, text = '' } = {}) {
  const novo = doc.createElement('ParagraphStyleRange');
  novo.setAttribute('AppliedParagraphStyle', styleSelf || psr.getAttribute('AppliedParagraphStyle'));
  novo.appendChild(makeContentCsr(doc, text));
  psr.parentNode.insertBefore(novo, psr);
  ensureParagraphBreaks(story);
  return novo;
}

/** Remove um parágrafo. Recusa remover o último parágrafo restante. */
export function deleteParagraph(story, psr) {
  if (childElements(story, 'ParagraphStyleRange').length <= 1) return false;
  psr.parentNode.removeChild(psr);
  ensureParagraphBreaks(story);
  return true;
}

/**
 * Divide o parágrafo no offset de corpo `offset`: o texto antes permanece em
 * `psr`, o texto a partir de `offset` vai para um novo parágrafo (mesmo estilo
 * e atributos), inserido logo após. Retorna o novo parágrafo.
 */
export function splitParagraphAtOffset(doc, story, psr, offset) {
  splitBoundaryAt(psr, offset);            // garante fronteira de CSR em `offset`

  const novo = psr.cloneNode(false);       // herda atributos do parágrafo
  const props = first(childElements(psr, 'Properties'));
  if (props) novo.appendChild(props.cloneNode(true));

  let acc = 0, movendo = false;
  for (const csr of childElements(psr, 'CharacterStyleRange')) {
    const len = childElements(csr, 'Content').reduce((s, c) => s + c.textContent.length, 0);
    if (acc >= offset) movendo = true;
    if (movendo) novo.appendChild(csr);    // appendChild move o CSR para o novo PSR
    acc += len;
  }
  if (!childElements(novo, 'CharacterStyleRange').length) novo.appendChild(makeContentCsr(doc, ''));
  if (!childElements(psr,  'CharacterStyleRange').length) psr.appendChild(makeContentCsr(doc, ''));

  psr.parentNode.insertBefore(novo, psr.nextSibling);
  ensureParagraphBreaks(story);
  return novo;
}

/** Lista os parágrafos (PSRs de topo) da story, em ordem de documento. */
export function paragraphList(story) {
  return childElements(story, 'ParagraphStyleRange');
}

/**
 * Move os parágrafos `psrNodes` (na ordem dada) para logo depois de `alvoPsr`,
 * preservando estilo/atributos/conteúdo de cada um. Recusa se `alvoPsr` estiver
 * entre os movidos. Retorna true se moveu.
 */
export function moveParagraphsAfter(story, psrNodes, alvoPsr) {
  if (!psrNodes || !psrNodes.length || !alvoPsr) return false;
  if (psrNodes.indexOf(alvoPsr) !== -1) return false;
  let ref = alvoPsr;
  for (const psr of psrNodes) {
    if (psr.parentNode) psr.parentNode.removeChild(psr);
    ref.parentNode.insertBefore(psr, ref.nextSibling);
    ref = psr;
  }
  ensureParagraphBreaks(story);
  return true;
}

/**
 * Duplica os parágrafos `psrNodes` (clone profundo) logo depois de `alvoPsr`,
 * na ordem dada. Retorna os clones inseridos (ou null se inválido).
 */
export function copyParagraphsAfter(story, psrNodes, alvoPsr) {
  if (!psrNodes || !psrNodes.length || !alvoPsr) return null;
  const clones = [];
  let ref = alvoPsr;
  for (const psr of psrNodes) {
    const clone = psr.cloneNode(true);
    ref.parentNode.insertBefore(clone, ref.nextSibling);
    ref = clone;
    clones.push(clone);
  }
  ensureParagraphBreaks(story);
  return clones;
}

/** Funde `psr` no parágrafo anterior (para Backspace no início). */
export function mergeParagraphWithPrevious(story, psr) {
  let prev = psr.previousSibling;
  while (prev && !(prev.nodeType === 1 && prev.tagName === 'ParagraphStyleRange')) prev = prev.previousSibling;
  if (!prev) return false;

  removeTrailingBr(prev);                  // remove a marca de ¶ entre os dois
  for (const csr of childElements(psr, 'CharacterStyleRange')) prev.appendChild(csr);
  psr.parentNode.removeChild(psr);
  ensureParagraphBreaks(story);
  return true;
}

/**
 * No ICML, <Br/> é a marca de fim de parágrafo, e um mesmo ParagraphStyleRange
 * pode conter VÁRIOS parágrafos (de mesmo estilo) separados por <Br/>. Esta
 * função normaliza a story para o modelo "1 PSR = 1 parágrafo", dividindo cada
 * PSR nos <Br/> internos em PSRs separados (clonando atributos e Properties).
 * Deve ser chamada logo após o parse. (A quebra de linha forçada é o caractere
 * U+2028 dentro do <Content>, não um <Br/>.)
 */
export function splitParagraphsAtBreaks(story) {
  const doc = story.ownerDocument;
  for (const psr of childElements(story, 'ParagraphStyleRange')) {
    let atual = psr, br;
    while ((br = firstInternalBr(atual))) atual = splitPsrAfterBr(atual, br, doc);
  }
  ensureParagraphBreaks(story);
}

// Primeiro <Br/> do PSR que NÃO é o último item inline (ou seja, é separador
// entre dois parágrafos dentro do mesmo PSR).
function firstInternalBr(psr) {
  const ultimo = lastInlineOf(psr)?.item || null;
  for (const csr of childElements(psr, 'CharacterStyleRange'))
    for (const item of inlineItems(csr))
      if (item.tagName === 'Br' && item !== ultimo) return item;
  return null;
}

// Divide o PSR após o <Br/>: tudo depois do Br vai para um novo PSR clonado.
function splitPsrAfterBr(psr, br, doc) {
  const novo = psr.cloneNode(false);
  const props = first(childElements(psr, 'Properties'));
  if (props) novo.appendChild(props.cloneNode(true));

  const brCsr = br.parentNode;
  // Itens do mesmo CSR depois do Br → novo CSR clonado (preserva atributos).
  const resto = [];
  for (let n = br.nextSibling; n; n = n.nextSibling)
    if (n.nodeType === 1 && n.tagName !== 'Properties') resto.push(n);
  if (resto.length) {
    const csrNovo = cloneCsrShell(brCsr);
    for (const item of resto) csrNovo.appendChild(item);
    novo.appendChild(csrNovo);
  }
  // CSRs seguintes → movem para o novo PSR.
  const seguintes = [];
  for (let c = brCsr.nextSibling; c; c = c.nextSibling)
    if (c.nodeType === 1 && c.tagName === 'CharacterStyleRange') seguintes.push(c);
  for (const c of seguintes) novo.appendChild(c);

  psr.parentNode.insertBefore(novo, psr.nextSibling);
  return novo;
}

/** Normaliza o invariante de <Br>: todo parágrafo termina em Br, exceto o último. */
export function ensureParagraphBreaks(story) {
  const psrs = childElements(story, 'ParagraphStyleRange');
  psrs.forEach((psr, i) => {
    if (i === psrs.length - 1) removeTrailingBr(psr);
    else ensureTrailingBr(psr);
  });
}

function makeContentCsr(doc, text) {
  const csr = doc.createElement('CharacterStyleRange');
  csr.setAttribute('AppliedCharacterStyle', SEM_ESTILO_CHAR);
  const content = doc.createElement('Content');
  content.textContent = text;
  csr.appendChild(content);
  return csr;
}

function inlineItems(csr) {
  return Array.from(csr.childNodes).filter(n => n.nodeType === 1 && n.tagName !== 'Properties');
}

function lastInlineOf(psr) {
  const csrs = childElements(psr, 'CharacterStyleRange');
  for (let i = csrs.length - 1; i >= 0; i--) {
    const items = inlineItems(csrs[i]);
    if (items.length) return { csr: csrs[i], item: items[items.length - 1] };
  }
  return null;
}

function ensureTrailingBr(psr) {
  const last = lastInlineOf(psr);
  if (last && last.item.tagName === 'Br') return;
  const doc = psr.ownerDocument;
  let target = childElements(psr, 'CharacterStyleRange').pop();
  if (!target) {
    target = doc.createElement('CharacterStyleRange');
    target.setAttribute('AppliedCharacterStyle', SEM_ESTILO_CHAR);
    psr.appendChild(target);
  }
  target.appendChild(doc.createElement('Br'));
}

function removeTrailingBr(psr) {
  const last = lastInlineOf(psr);
  if (!last || last.item.tagName !== 'Br') return;
  last.csr.removeChild(last.item);
  // Remove o CSR se ficou sem itens inline (mantendo ao menos um CSR no parágrafo).
  if (!inlineItems(last.csr).length && childElements(psr, 'CharacterStyleRange').length > 1) {
    last.csr.parentNode.removeChild(last.csr);
  }
}

// ── Utilidades ────────────────────────────────────────────────

function first(list) { return list && list.length ? list[0] : null; }

function childElements(parent, tagName) {
  return Array.from(parent.childNodes).filter(n => n.nodeType === 1 && n.tagName === tagName);
}

// Mapa Self→Name a partir das definições de estilo do documento.
function styleNameMap(doc, tag) {
  const map = new Map();
  for (const el of Array.from(doc.getElementsByTagName(tag))) {
    const self = el.getAttribute('Self');
    if (self) map.set(self, el.getAttribute('Name') || '');
  }
  return map;
}

// Nome amigável de um estilo aplicado; decodifica o Self quando não há nome.
function displayName(appliedSelf, nameBySelf) {
  if (!appliedSelf) return '';
  const name = nameBySelf.get(appliedSelf);
  if (name) return decodeStyleName(name);
  // Fallback: remove o prefixo do tipo e decodifica o separador de grupo (%3a = ':').
  return decodeStyleName(appliedSelf.replace(/^[^/]+\//, ''));
}

function decodeStyleName(raw) {
  return raw
    .replace(/%3a/gi, ':')
    .replace(/^\$ID\/\[?/,'')
    .replace(/\]$/, '')
    .replace(/^No (paragraph|character) style$/i, '(nenhum)');
}
