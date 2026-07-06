import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import {
  parseIcml, serializeIcml, readParagraphs,
  listParagraphStyles, listCharacterStyles,
  setContentText, insertNote,
  paragraphBodyText, applyCharacterStyleToOffsets,
  insertParagraphAfter, deleteParagraph,
  splitParagraphAtOffset, mergeParagraphWithPrevious,
  paragraphStyleAppearances, splitParagraphsAtBreaks,
  findCharacterStyles, toggleCharacterStyle,
  readTable,
  conditionColors, listConditions, applyConditionToOffsets,
  ensureCondition, insertRun, applyConditionToBreak,
  removeConditionFromOffsets, removeConditionFromBreak,
  markOrphanRunsRemoved, insertRemovedRun, contentStartOffset,
  hasLiveTextFrom, findMatchesInParagraph, replaceRange,
  headingLevels,
} from '../src/icml.js';

// Encontra a primeira <Table> na story.
function acharTabela(story) {
  const list = story.getElementsByTagName('Table');
  return list.length ? list[0] : null;
}

// Fixture estável (cópia de um ICML real com nota, negrito, overrides e footnote).
const here = dirname(fileURLToPath(import.meta.url));
const original = readFileSync(join(here, 'fixtures', 'base.icml'), 'utf8');

// Carrega já normalizando os <Br/> em parágrafos (mesmo fluxo do app).
function carregar() {
  const { doc, story } = parseIcml(original, DOMParser);
  splitParagraphsAtBreaks(story);
  return { doc, story, paras: readParagraphs(doc, story) };
}

const textoDe = p => p.runs.map(r =>
  r.inlines.filter(i => i.type === 'text').map(i => i.text).join('')).join('');
const acharPara = (paras, sub) => paras.find(p => textoDe(p).includes(sub));
const childPSRs = story => Array.from(story.childNodes)
  .filter(n => n.nodeType === 1 && n.tagName === 'ParagraphStyleRange');

// Conta os <Br> TERMINAIS (separadores de parágrafo). Deve ser (nº parágrafos − 1).
function brTerminais(story) {
  let n = 0;
  for (const psr of childPSRs(story)) {
    let ultimo = null;
    for (const csr of Array.from(psr.childNodes).filter(c => c.nodeType === 1 && c.tagName === 'CharacterStyleRange')) {
      const itens = Array.from(csr.childNodes).filter(c => c.nodeType === 1 && c.tagName !== 'Properties');
      if (itens.length) ultimo = itens[itens.length - 1];
    }
    if (ultimo && ultimo.tagName === 'Br') n++;
  }
  return n;
}

// Resumo estrutural (comparação antes/depois sem depender de whitespace).
function describe(xml) {
  const { doc, story } = parseIcml(xml, DOMParser);
  const paras = readParagraphs(doc, story);
  return {
    fonts:  doc.getElementsByTagName('Font').length,
    colors: doc.getElementsByTagName('Color').length,
    paraStyles: doc.getElementsByTagName('ParagraphStyle').length,
    charStyles: doc.getElementsByTagName('CharacterStyle').length,
    notes:  doc.getElementsByTagName('Note').length,
    xmp:    xml.match(/<\?xpacket begin/) ? 1 : 0,
    text:   paras.map(textoDe).join('\n'),
  };
}

test('no-op round-trip preserva conteúdo e estrutura', () => {
  const { doc } = parseIcml(original, DOMParser);
  const out = serializeIcml(doc, XMLSerializer);

  assert.deepEqual(describe(out), describe(original), 'round-trip sem edição não altera nada');
  assert.match(out, /<\?aid style=/, 'PI <?aid?> preservada');
  assert.match(out, /<\?xpacket begin/, 'pacote XMP preservado');
  assert.match(out, /MinimumWordSpacing="84"/, 'override local preservado');
  assert.match(out, /<Leading type="unit">14\.397141607876142<\/Leading>/, 'Properties preservadas');
});

test('extração lê parágrafos, estilos e a nota existente', () => {
  const { doc, paras } = carregar();

  assert.ok(paras.length >= 3, 'vários parágrafos');
  assert.equal(paras[0].styleName, 'titulos:titulo-2');
  assert.match(textoDe(paras[0]), /Pensão por morte/);

  const notas = paras.flatMap(p => p.runs.flatMap(r => r.inlines.filter(i => i.type === 'note')));
  assert.ok(notas.length >= 1, 'a nota do arquivo é detectada');
  assert.ok(notas[0].text.length > 0);

  assert.ok(listParagraphStyles(doc).some(s => s.name.includes('titulo-2')));
  assert.ok(listCharacterStyles(doc).some(s => s.name === 'bold'));
});

test('editar texto altera só o Content e nada mais', () => {
  const { doc, paras } = carregar();
  const alvo = acharPara(paras, 'A pensão por morte').runs.flatMap(r => r.inlines).find(i => i.type === 'text');

  setContentText(alvo.node, 'TEXTO REVISADO');
  const out = serializeIcml(doc, XMLSerializer);

  assert.match(out, /<Content>TEXTO REVISADO<\/Content>/);
  const a = describe(original), b = describe(out);
  assert.deepEqual(
    { fonts: b.fonts, colors: b.colors, paraStyles: b.paraStyles, charStyles: b.charStyles, xmp: b.xmp },
    { fonts: a.fonts, colors: a.colors, paraStyles: a.paraStyles, charStyles: a.charStyles, xmp: a.xmp },
  );
});

test('aplicar estilo a seleção arbitrária divide o run só no ponto exato', () => {
  const { doc, story, paras } = carregar();
  const psr = acharPara(paras, 'diagnosticado').node;   // "No caso...diagnosticado...TEA"
  const texto = paragraphBodyText(psr);
  const start = texto.indexOf('TEA');
  assert.ok(start > 0, 'palavra TEA encontrada');

  const estilo = listCharacterStyles(doc).find(s => s.name === 'destaque-sublinhado').self;
  applyCharacterStyleToOffsets(psr, start, start + 3, estilo);

  assert.equal(paragraphBodyText(psr), texto, 'nenhum caractere perdido/duplicado');

  const p = readParagraphs(doc, story).find(x => x.node === psr);
  const runsTEA = p.runs.filter(r =>
    r.styleName === 'destaque-sublinhado' && r.inlines.some(i => i.type === 'text' && i.text === 'TEA'));
  assert.equal(runsTEA.length, 1, 'apenas "TEA" recebeu o estilo');

  const out = serializeIcml(doc, XMLSerializer);
  assert.match(out, /AppliedCharacterStyle="CharacterStyle\/bold"[\s\S]*?<Content>diagnosticado<\/Content>/);
});

test('invariante de Br: (parágrafos − 1) quebras terminais', () => {
  const { story } = carregar();
  assert.equal(brTerminais(story), childPSRs(story).length - 1);
});

test('inserir parágrafo herda o estilo e mantém o invariante de Br', () => {
  const { doc, story, paras } = carregar();
  const alvo = acharPara(paras, 'A pensão por morte');
  const antes = paras.length;

  insertParagraphAfter(doc, story, alvo.node, { text: 'Parágrafo novo' });

  const depois = readParagraphs(doc, story);
  assert.equal(depois.length, antes + 1);
  const idx = depois.findIndex(p => p.node === alvo.node);
  assert.equal(depois[idx + 1].runs[0].inlines[0].text, 'Parágrafo novo');
  assert.equal(depois[idx + 1].styleName, 'miolo:corpo');
  assert.equal(brTerminais(story), depois.length - 1);

  const out = serializeIcml(doc, XMLSerializer);
  assert.match(out, /<Content>Parágrafo novo<\/Content>/);
  assert.ok(out.startsWith('<?xml') && out.includes('</Document>'));
});

test('excluir parágrafo remove o texto e recusa remover o último', () => {
  const { doc, story, paras } = carregar();
  const alvo = acharPara(paras, 'Novo parágrafo');
  const antes = paras.length;

  assert.equal(deleteParagraph(story, alvo.node), true);
  const depois = readParagraphs(doc, story);
  assert.equal(depois.length, antes - 1);
  assert.ok(!depois.some(p => textoDe(p) === 'Novo parágrafo'));
  assert.equal(brTerminais(story), depois.length - 1);

  // Story com um único parágrafo: não pode ser removido.
  const mini = parseIcml(
    '<?xml version="1.0"?><Document Self="d"><Story Self="s">' +
    '<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/x">' +
    '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">' +
    '<Content>só</Content></CharacterStyleRange></ParagraphStyleRange></Story></Document>', DOMParser);
  const um = readParagraphs(mini.doc, mini.story)[0].node;
  assert.equal(deleteParagraph(mini.story, um), false);
});

test('dividir e mesclar parágrafo preserva o texto', () => {
  const { doc, story, paras } = carregar();
  const psr = acharPara(paras, 'A pensão por morte').node;
  const textoOriginal = paragraphBodyText(psr);
  const antes = paras.length;

  const novo = splitParagraphAtOffset(doc, story, psr, 20);
  assert.equal(paragraphBodyText(psr),  textoOriginal.slice(0, 20));
  assert.equal(paragraphBodyText(novo), textoOriginal.slice(20));
  assert.equal(readParagraphs(doc, story).length, antes + 1);

  mergeParagraphWithPrevious(story, novo);
  assert.equal(paragraphBodyText(psr), textoOriginal);
  assert.equal(readParagraphs(doc, story).length, antes);
});

test('aparência converte LeftIndent/RightIndent em margens e BulletList em bullet', () => {
  const xml = `<?xml version="1.0"?>
<Document DOMVersion="21.4" Self="d">
  <RootParagraphStyleGroup Self="u1">
    <ParagraphStyle Self="ParagraphStyle/lista" Name="lista"
      PointSize="10" LeftIndent="18" RightIndent="9" BulletsAndNumberingListType="BulletList"/>
    <ParagraphStyle Self="ParagraphStyle/simples" Name="simples" PointSize="10"/>
  </RootParagraphStyleGroup>
  <Story Self="s"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/lista">
    <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>x</Content></CharacterStyleRange>
  </ParagraphStyleRange></Story>
</Document>`;
  const { doc } = parseIcml(xml, DOMParser);
  const ap = paragraphStyleAppearances(doc);

  const lista = ap.get('ParagraphStyle/lista');
  assert.equal(lista.marginLeft,  '28.8px');   // 18 * 1.6
  assert.equal(lista.marginRight, '14.4px');   //  9 * 1.6
  assert.equal(lista.bullet, true);

  const simples = ap.get('ParagraphStyle/simples');
  assert.equal(simples.marginLeft, undefined);
  assert.equal(simples.bullet, undefined);
});

test('splitParagraphsAtBreaks separa parágrafos agrupados no mesmo PSR', () => {
  const { doc, story } = parseIcml(original, DOMParser);
  const antes = childPSRs(story).length;
  splitParagraphsAtBreaks(story);
  const paras = readParagraphs(doc, story);

  assert.ok(paras.length > antes, 'PSRs com <Br/> interno viram vários parágrafos');

  const ts = paras.map(textoDe);
  assert.ok(ts.some(t => t === 'Novo parágrafo'), '"Novo parágrafo" é parágrafo próprio');
  assert.ok(!ts.some(t => /ou não\.Novo parágrafo/.test(t)), 'não estão colados');
});

test('lê nota de rodapé (<Footnote>) e preserva no round-trip', () => {
  const { doc, story, paras } = carregar();

  const fns = paras.flatMap(p => p.runs.flatMap(r => r.inlines.filter(i => i.type === 'footnote')));
  assert.equal(fns.length, 1, 'uma nota de rodapé');
  assert.match(fns[0].text, /^Sistema de contribuição/);
  assert.ok(!fns[0].text.includes('\t'), 'tab inicial removido');

  const paraMontepio = acharPara(paras, 'montepio');
  assert.ok(paraMontepio.runs.some(r => r.inlines.some(i => i.type === 'footnote')));

  const out = serializeIcml(doc, XMLSerializer);
  assert.match(out, /<Footnote>/);
  assert.match(out, /ACE 4/);
  assert.match(out, /Sistema de contribuição/);
});

test('editar rodapé: aplica estilos NOMEADOS itálico/sobrescrito, <?ACE?> preservado', () => {
  const { doc, paras } = carregar();
  const estilos = findCharacterStyles(doc);
  assert.ok(estilos.italic, 'estilo itálico disponível no ICML');
  assert.ok(estilos.superscript, 'estilo sobrescrito disponível no ICML');

  const fnNode = paras.flatMap(p => p.runs.flatMap(r => r.inlines))
    .find(i => i.type === 'footnote').node;

  // Itálico (estilo nomeado) em "Sistema", após o tab do número automático
  let psr = readParagraphs(doc, fnNode)[0].node;
  let texto = paragraphBodyText(psr);
  const s1 = texto.indexOf('Sistema');
  toggleCharacterStyle(psr, s1, s1 + 'Sistema'.length, estilos.italic);

  let out = serializeIcml(doc, XMLSerializer);
  assert.match(out, /AppliedCharacterStyle="CharacterStyle\/italic"[\s\S]*?<Content>Sistema<\/Content>/, '"Sistema" recebeu o estilo italic');
  assert.match(out, /ACE 4/, 'número automático preservado');

  // Sobrescrito (estilo nomeado) em "morte"
  psr = readParagraphs(doc, fnNode)[0].node;
  texto = paragraphBodyText(psr);
  const s2 = texto.indexOf('morte');
  toggleCharacterStyle(psr, s2, s2 + 'morte'.length, estilos.superscript);

  out = serializeIcml(doc, XMLSerializer);
  assert.match(out, /AppliedCharacterStyle="CharacterStyle\/sobrescrito"[\s\S]*?<Content>morte<\/Content>/, '"morte" recebeu o estilo sobrescrito');
  assert.match(out, /ACE 4/, 'número automático ainda preservado');

  // 2º toggle remove o itálico (volta a [No character style])
  psr = readParagraphs(doc, fnNode)[0].node;
  texto = paragraphBodyText(psr);
  const s3 = texto.indexOf('Sistema');
  toggleCharacterStyle(psr, s3, s3 + 'Sistema'.length, estilos.italic);
  out = serializeIcml(doc, XMLSerializer);
  assert.doesNotMatch(out, /AppliedCharacterStyle="CharacterStyle\/italic"[\s\S]*?<Content>Sistema<\/Content>/, 'estilo removido no 2º toggle');
});

test('findCharacterStyles retorna null quando o estilo não existe no ICML', () => {
  const xml = `<?xml version="1.0"?><Document Self="d">
    <RootCharacterStyleGroup Self="u">
      <CharacterStyle Self="CharacterStyle/sobrescrito" Name="sobrescrito" Position="Superscript"/>
    </RootCharacterStyleGroup>
    <Story Self="s"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/x">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>x</Content></CharacterStyleRange>
    </ParagraphStyleRange></Story></Document>`;
  const { doc } = parseIcml(xml, DOMParser);
  const est = findCharacterStyles(doc);
  assert.equal(est.superscript, 'CharacterStyle/sobrescrito');
  assert.equal(est.italic, null, 'sem estilo itálico → null (botão não é oferecido)');
});

test('lê a tabela como grade e edita o texto de uma célula (round-trip)', () => {
  const { doc, story } = carregar();
  const tableNode = acharTabela(story);
  assert.ok(tableNode, 'há uma <Table> no arquivo');

  const t = readTable(doc, tableNode);
  assert.equal(t.colCount, 2);
  assert.equal(t.rowCount, 6);          // 1 cabeçalho + 5 corpo
  assert.equal(t.headerRows, 1);

  // A célula de cabeçalho (0:0) ocupa 2 colunas
  const cab = t.cells.find(c => c.row === 0 && c.col === 0);
  assert.equal(cab.colSpan, 2);
  assert.match(cab.paras[0].runs[0].inlines[0].text, /Aposentadoria/);

  // Edita o texto de uma célula do corpo (só o Content, sem mexer na estrutura)
  const cel = t.cells.find(c => c.paras.some(p =>
    p.runs.some(r => r.inlines.some(i => i.type === 'text' && i.text.includes('Natureza')))));
  const content = cel.paras[0].runs.flatMap(r => r.inlines).find(i => i.type === 'text').node;
  setContentText(content, 'CÉLULA REVISADA');

  const out = serializeIcml(doc, XMLSerializer);
  assert.match(out, /<Content>CÉLULA REVISADA<\/Content>/);
  // A estrutura da tabela permanece intacta
  assert.match(out, /<Table [\s\S]*?ColumnCount="2"/);
  assert.equal((out.match(/<Cell /g) || []).length, (serializeIcml(parseIcml(original, DOMParser).doc, XMLSerializer).match(/<Cell /g) || []).length, 'nº de células inalterado');
});

test('texto branco: usa ParagraphShadingColor como fundo, ou cai para preto', () => {
  const { doc } = carregar();
  const comFundo = paragraphStyleAppearances(doc).get('ParagraphStyle/miolo%3afig-tab-titulo-arte');
  assert.equal(comFundo.color, 'rgb(255, 255, 255)', 'texto continua branco');
  assert.match(comFundo.backgroundColor, /^rgb\(/, 'fundo de sombreamento aplicado');

  // Sintético: branco SEM sombreamento → texto vira preto (senão some na página)
  const xml = `<?xml version="1.0"?><Document Self="d">
    <Color Self="Color/Paper" Space="CMYK" ColorValue="0 0 0 0" Name="Paper"/>
    <RootParagraphStyleGroup Self="u">
      <ParagraphStyle Self="ParagraphStyle/branco" Name="branco" PointSize="10" FillColor="Color/Paper"/>
    </RootParagraphStyleGroup>
    <Story Self="s"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/branco">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>x</Content></CharacterStyleRange>
    </ParagraphStyleRange></Story></Document>`;
  const mini = parseIcml(xml, DOMParser);
  const b = paragraphStyleAppearances(mini.doc).get('ParagraphStyle/branco');
  assert.equal(b.color, 'rgb(0, 0, 0)', 'branco sem sombreamento → preto');
  assert.equal(b.backgroundColor, undefined);
});

test('detecta estilos de título (nome/grupo) e SplitDocument="true" (nova página)', () => {
  const { doc } = carregar();
  const ap = paragraphStyleAppearances(doc);

  assert.ok(ap.get('ParagraphStyle/titulos%3atitulo-2').titulo, 'titulo-2 é título');
  assert.ok(ap.get('ParagraphStyle/miolo%3afig-tab-titulo-arte').titulo, 'contém "titulo" → título');
  assert.ok(!ap.get('ParagraphStyle/miolo%3acorpo').titulo, 'corpo não é título');

  assert.ok(ap.get('ParagraphStyle/titulos%3atitulo-cap').novaPagina, 'titulo-cap: SplitDocument="true" → nova página');
  assert.ok(!ap.get('ParagraphStyle/titulos%3atitulo-2').novaPagina, 'titulo-2: SplitDocument="false" → sem nova página');
});

test('MixedInk combina as tintas (Process Black + spot) pela InkList/InkPercentages', () => {
  // Igual ao plenario: 30% Process Black + 100% "verde limão" (CMYK 25 0 100 0).
  const xml = `<?xml version="1.0"?><Document Self="d">
    <Color Self="Color/verde limão" Space="CMYK" ColorValue="25 0 100 0" Name="verde limão" />
    <MixedInk Self="MixedInk/Tinta mista 1" Space="MixedInk"
      InkList="Ink/$ID/Process%20Black Ink/verde%20lim%C3%A3o"
      InkPercentages="30 100"
      MixedInkSpotColorList="Color/verde%20lim%C3%A3o" Name="Tinta mista 1" />
    <ParagraphStyle Self="ParagraphStyle/tm" Name="tm" FillColor="MixedInk/Tinta mista 1"></ParagraphStyle>
    <Story Self="s"></Story></Document>`;
  const { doc } = parseIcml(xml, DOMParser);
  const ap = paragraphStyleAppearances(doc);
  // CMYK combinado = (25, 0, 100, 30) → verde-limão escurecido
  assert.equal(ap.get('ParagraphStyle/tm').color, 'rgb(134, 179, 0)', 'verde limão + 30% preto');
});

test('FillTint aplica intensidade sobre a cor (preto 80% → cinza), -1/100 = cheio', () => {
  const xml = `<?xml version="1.0"?><Document Self="d">
    <Color Self="Color/Black" Space="CMYK" ColorValue="0 0 0 100" />
    <ParagraphStyle Self="ParagraphStyle/t80" Name="t80" FillColor="Color/Black" FillTint="80"></ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/tcheio" Name="tcheio" FillColor="Color/Black" FillTint="-1"></ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/t100" Name="t100" FillColor="Color/Black" FillTint="100"></ParagraphStyle>
    <Story Self="s"></Story></Document>`;
  const { doc } = parseIcml(xml, DOMParser);
  const ap = paragraphStyleAppearances(doc);
  assert.equal(ap.get('ParagraphStyle/t80').color, 'rgb(51, 51, 51)', 'preto 80% = rgb(51,51,51)');
  assert.equal(ap.get('ParagraphStyle/tcheio').color, 'rgb(0, 0, 0)', 'FillTint=-1 → preto cheio');
  assert.equal(ap.get('ParagraphStyle/t100').color, 'rgb(0, 0, 0)', 'FillTint=100 → preto cheio');
});

test('StartParagraph="NextOddPage" também gera nova página (<hr>)', () => {
  const xml = `<?xml version="1.0"?><Document Self="d">
    <ParagraphStyle Self="ParagraphStyle/abre" Name="abre" StartParagraph="NextOddPage"></ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/npg" Name="npg" StartParagraph="NextPage"></ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/qq" Name="qq" StartParagraph="Anywhere"></ParagraphStyle>
    <Story Self="s"></Story></Document>`;
  const { doc } = parseIcml(xml, DOMParser);
  const ap = paragraphStyleAppearances(doc);
  assert.ok(ap.get('ParagraphStyle/abre').novaPagina, 'NextOddPage → nova página');
  assert.ok(!ap.get('ParagraphStyle/npg').novaPagina, 'NextPage não dispara (só NextOddPage)');
  assert.ok(!ap.get('ParagraphStyle/qq').novaPagina, 'Anywhere não dispara');
});

test('lê imagem (Rectangle GraphicType) e extrai o caminho do LinkResourceURI', () => {
  const xml = `<?xml version="1.0"?><Document Self="d"><Story Self="s">
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/miolo%3aobjeto">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Rectangle Self="r" ContentType="GraphicType">
          <Image Self="i"><Link Self="l" LinkResourceURI="file:C:/x/Imagem%20Teste.png"/></Image>
        </Rectangle>
      </CharacterStyleRange></ParagraphStyleRange></Story></Document>`;
  const { doc, story } = parseIcml(xml, DOMParser);
  const img = readParagraphs(doc, story).flatMap(p => p.runs.flatMap(r => r.inlines)).find(i => i.type === 'image');

  assert.ok(img, 'a imagem é detectada');
  assert.equal(img.src, 'C:/x/Imagem Teste.png', 'caminho decodificado, sem "file:"');

  // Round-trip preserva a estrutura gráfica original
  const out = serializeIcml(doc, XMLSerializer);
  assert.match(out, /<Rectangle /);
  assert.match(out, /LinkResourceURI="file:C:\/x\/Imagem%20Teste\.png"/);
});

test('borda de parágrafo: espessura por lado (pt→px), cor e padding 6px', () => {
  const { doc } = carregar();
  const ap = paragraphStyleAppearances(doc);
  const selfDe = nome => listParagraphStyles(doc).find(s => s.name === nome).self;

  // Borda esquerda de 3px (ciano) com padding 6px
  const esq = ap.get(selfDe('miolo:destaque 1 miolo'));
  assert.equal(esq.borderLeft, '3px solid rgb(18, 187, 209)');
  assert.equal(esq.padding, '12px');
  assert.equal(esq.borderTop, undefined);
  assert.equal(esq.borderRight, undefined);

  // Borda inferior de 1.5px
  const inf = ap.get(selfDe('miolo:fig-tab-titulo-arte'));
  assert.match(inf.borderBottom, /^1\.5px solid rgb\(/);
  assert.equal(inf.padding, '12px');

  // Estilo sem borda não recebe padding do bordado
  assert.equal(ap.get(selfDe('miolo:corpo')).borderLeft, undefined);
});

test('conditions: lê cores (enum e list) e aplica AppliedConditions à seleção', () => {
  const xml = `<?xml version="1.0"?><Document Self="d">
    <Condition Self="Condition/alterado" Name="Texto alterado" IndicatorMethod="UseHighlight">
      <Properties><IndicatorColor type="enumeration">CuteTeal</IndicatorColor></Properties></Condition>
    <Condition Self="Condition/iso" Name="isoladas">
      <Properties><IndicatorColor type="list">
        <ListItem type="double">176</ListItem><ListItem type="double">213</ListItem><ListItem type="double">253</ListItem>
      </IndicatorColor></Properties></Condition>
    <Story Self="s"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/x">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>abcdef</Content></CharacterStyleRange>
    </ParagraphStyleRange></Story></Document>`;
  const { doc, story } = parseIcml(xml, DOMParser);

  const cores = conditionColors(doc);
  assert.equal(cores.get('Condition/alterado'), 'rgba(26, 188, 170, 0.4)', 'CuteTeal (enum)');
  assert.equal(cores.get('Condition/iso'), 'rgba(176, 213, 253, 0.4)', 'cor em list (RGB)');
  assert.ok(listConditions(doc).some(c => c.name === 'Texto alterado'));

  // Aplica a condition ao "cd" (offsets 2..4)
  const psr = readParagraphs(doc, story)[0].node;
  applyConditionToOffsets(psr, 2, 4, 'Condition/alterado');
  const out = serializeIcml(doc, XMLSerializer);
  assert.match(out, /AppliedConditions="Condition\/alterado"[\s\S]*?<Content>cd<\/Content>/);
  // Preserva o texto (só dividiu os runs)
  assert.equal(readParagraphs(doc, story).map(p => p.runs.map(r => r.inlines.filter(i => i.type === 'text').map(i => i.text).join('')).join('')).join(''), 'abcdef');
});

test('ensureCondition cria condition faltante; insertRun re-insere texto removido', () => {
  const xml = `<?xml version="1.0"?><Document Self="d"><Story Self="s">
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/x">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>abcdef</Content></CharacterStyleRange>
    </ParagraphStyleRange></Story></Document>`;
  const { doc, story } = parseIcml(xml, DOMParser);

  // Cria "Texto removido" (não existia) e é idempotente
  const self = ensureCondition(doc, 'Texto removido', [235, 87, 87]);
  assert.equal(self, 'Condition/Texto removido');
  assert.equal(ensureCondition(doc, 'Texto removido', [1, 2, 3]), self);
  assert.equal(doc.getElementsByTagName('Condition').length, 1);
  assert.equal(conditionColors(doc).get(self), 'rgba(235, 87, 87, 0.4)');

  // Re-insere "XY" (tachado) no offset 3, com a condition
  const psr = readParagraphs(doc, story)[0].node;
  insertRun(psr, 3, 'XY', 'Condition/Texto%20removido');
  assert.equal(paragraphBodyText(psr), 'abcXYdef', 'texto inserido no ponto certo');

  const out = serializeIcml(doc, XMLSerializer);
  assert.match(out, /<Condition Self="Condition\/Texto removido"/);
  assert.match(out, /AppliedConditions="Condition\/Texto%20removido"[\s\S]*?<Content>XY<\/Content>/);
});

test('remoção de parágrafo inteiro marca também o <Br/> de fim de parágrafo', () => {
  const { doc, story } = carregar();
  // 1º parágrafo de corpo (tem Br terminal, pois não é o último)
  const psr = readParagraphs(doc, story).find(p =>
    p.styleName === 'miolo:corpo' && p.runs.some(r => r.inlines.some(i => i.type === 'br'))).node
    || readParagraphs(doc, story)[1].node;

  const total = paragraphBodyText(psr).length;
  applyConditionToOffsets(psr, 0, total, 'Condition/Texto%20removido');
  const marcou = applyConditionToBreak(psr, 'Condition/Texto%20removido');
  assert.equal(marcou, true, 'havia um Br terminal a marcar');

  const out = serializeIcml(doc, XMLSerializer);
  // Existe um CSR com a condition contendo um <Br/>
  assert.match(out, /AppliedConditions="[^"]*Texto%20removido[^"]*"[^>]*>\s*(<Properties>[\s\S]*?<\/Properties>\s*)?<Br ?\/>/);
});

test('desfazer remoção: remove a condition do texto e do <Br/>', () => {
  const { doc, story } = carregar();
  const psr = readParagraphs(doc, story).find(p =>
    p.styleName === 'miolo:corpo' && p.runs.some(r => r.inlines.some(i => i.type === 'br')))?.node
    || readParagraphs(doc, story)[1].node;

  const total = paragraphBodyText(psr).length;
  const ref = 'Condition/Texto%20removido';
  applyConditionToOffsets(psr, 0, total, ref);
  applyConditionToBreak(psr, ref);
  let out = serializeIcml(doc, XMLSerializer);
  assert.ok(out.includes('Texto%20removido'), 'marcado como removido');

  // Desfaz
  removeConditionFromOffsets(psr, 0, paragraphBodyText(psr).length, ref);
  removeConditionFromBreak(psr, ref);
  out = serializeIcml(doc, XMLSerializer);
  assert.ok(!out.includes('Texto%20removido'), 'condition removida ao desfazer');
  assert.equal(paragraphBodyText(psr).length, total, 'o texto continua lá');
});

test('markOrphanRunsRemoved marca runs apagados sem perder texto nem estilo', () => {
  const xml = `<?xml version="1.0"?><Document Self="d"><Story Self="s">
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/x">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>manter </Content></CharacterStyleRange>
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/y"><Content>(apagar)</Content></CharacterStyleRange>
    </ParagraphStyleRange></Story></Document>`;
  const { doc, story } = parseIcml(xml, DOMParser);
  const p = readParagraphs(doc, story)[0];
  const contentManter = p.runs.find(r => r.inlines.some(i => i.text === 'manter '))
    .inlines.find(i => i.type === 'text').node;

  // Só "manter " sobrevive (o outro run foi apagado no editor) → o órfão é marcado
  const ref = 'Condition/Texto%20removido';
  const mudou = markOrphanRunsRemoved(p.node, new Set([contentManter]), ref);
  assert.equal(mudou, true, 'sinaliza que marcou um órfão');
  // texto e estilo de caractere permanecem intactos
  assert.equal(paragraphBodyText(p.node), 'manter (apagar)', 'texto do órfão preservado');
  const csrApagar = p.node.getElementsByTagName('CharacterStyleRange')[1];
  assert.equal(csrApagar.getAttribute('AppliedCharacterStyle'), 'CharacterStyle/y', 'estilo preservado');
  assert.ok((csrApagar.getAttribute('AppliedConditions') || '').includes(ref), 'condition aplicada');

  // idempotente: rodar de novo não duplica a condition nem sinaliza mudança
  const denovo = markOrphanRunsRemoved(p.node, new Set([contentManter]), ref);
  assert.equal(denovo, false, 'não remarca o que já está marcado');
});

test('apagar seleção que engloba um run estilizado no meio não duplica o texto', () => {
  // "A pensão ... previdenciário pago pelo [INSS] aos dependentes do segurado ..."
  // com INSS em negrito (run próprio). Apaga "pago pelo INSS aos dependentes".
  const xml = `<?xml version="1.0"?><Document Self="d"><Story Self="s">
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/x">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>A pensão é paga pelo </Content></CharacterStyleRange>
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/negrito"><Content>INSS</Content></CharacterStyleRange>
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content> aos dependentes do segurado.</Content></CharacterStyleRange>
    </ParagraphStyleRange></Story></Document>`;
  const { doc, story } = parseIcml(xml, DOMParser);
  const p = readParagraphs(doc, story)[0];
  const base = paragraphBodyText(p.node);
  const refRem = 'Condition/Texto%20removido';

  const contents = [...p.node.getElementsByTagName('Content')];
  const [c1, c2, c3] = contents;              // run1 (plain), run2 (negrito, apagado), run3 (plain)

  // Simula o editor: apagou "paga pelo INSS aos dependentes".
  // run1 perde o sufixo "paga pelo ", run2 some (órfão), run3 perde o prefixo " aos dependentes".
  const novo1 = 'A pensão é ';
  const novo3 = ' do segurado.';
  const antigo1 = c1.textContent, antigo3 = c3.textContent;
  const csr1 = c1.parentNode, csr3 = c3.parentNode;
  setContentText(c1, novo1);
  setContentText(c3, novo3);

  // 1) órfão (INSS) marcado no lugar, mantendo o negrito
  markOrphanRunsRemoved(p.node, new Set([c1, c3]), refRem);

  // 2) diff por run — direita p/ esquerda (run3 depois run1)
  const off3 = contentStartOffset(p.node, c3);
  insertRemovedRun(p.node, off3, ' aos dependentes', csr3, refRem);   // prefixo apagado do run3
  const off1 = contentStartOffset(p.node, c1);
  insertRemovedRun(p.node, off1 + novo1.length, 'paga pelo ', csr1, refRem);   // sufixo apagado do run1

  // Texto reconstruído == original (tudo preservado, nada duplicado)
  const final = paragraphBodyText(p.node);
  assert.equal(final, base, 'texto final idêntico ao original (sem duplicação)');
  assert.equal((final.match(/INSS/g) || []).length, 1, 'INSS aparece uma única vez');

  // O run do INSS mantém o estilo negrito e recebeu a condition
  const csrInss = [...p.node.getElementsByTagName('CharacterStyleRange')]
    .find(c => [...c.getElementsByTagName('Content')].some(ct => ct.textContent === 'INSS'));
  assert.equal(csrInss.getAttribute('AppliedCharacterStyle'), 'CharacterStyle/negrito', 'negrito preservado');
  assert.ok((csrInss.getAttribute('AppliedConditions') || '').includes(refRem), 'INSS marcado removido');

  // Os trechos re-inseridos herdam o estilo do run de origem (ambos "[No character style]")
  const reInseridos = [...p.node.getElementsByTagName('CharacterStyleRange')]
    .filter(c => (c.getAttribute('AppliedConditions') || '').includes(refRem)
      && [...c.getElementsByTagName('Content')].some(ct => /paga pelo|aos dependentes/.test(ct.textContent)));
  assert.equal(reInseridos.length, 2, 'dois trechos re-inseridos (sufixo run1 + prefixo run3)');
});

test('hasLiveTextFrom detecta se há texto vivo (não-removido) a partir de um offset', () => {
  // "Frase viva " + "removida" (struck) + "." (viva)
  const xml = `<?xml version="1.0"?><Document Self="d"><Story Self="s">
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/x">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>Frase viva </Content></CharacterStyleRange>
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]" AppliedConditions="Condition/Texto%20removido"><Content>removida</Content></CharacterStyleRange>
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>.</Content></CharacterStyleRange>
    </ParagraphStyleRange></Story></Document>`;
  const { doc, story } = parseIcml(xml, DOMParser);
  const p = readParagraphs(doc, story)[0];
  const ref = 'Condition/Texto%20removido';
  const fimViva = 'Frase viva '.length;        // offset após o texto vivo inicial
  const fimRemovida = fimViva + 'removida'.length;

  assert.equal(hasLiveTextFrom(p.node, 0, ref), true, 'início tem texto vivo');
  // A partir do fim do texto vivo inicial ainda há o "." vivo depois do struck.
  assert.equal(hasLiveTextFrom(p.node, fimViva, ref), true, 'o "." final é vivo');
  // Se removêssemos também o ".", nada vivo restaria a partir dali.
  const ultimo = p.node.getElementsByTagName('CharacterStyleRange')[2];
  ultimo.setAttribute('AppliedConditions', ref);
  assert.equal(hasLiveTextFrom(p.node, fimViva, ref), false, 'só conteúdo removido a partir do offset');
  assert.equal(hasLiveTextFrom(p.node, fimRemovida, ref), false, 'após tudo, nada vivo');
});

test('findMatchesInParagraph respeita caixa e ignora trechos removidos', () => {
  const xml = `<?xml version="1.0"?><Document Self="d"><Story Self="s">
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/x">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>casa Casa </Content></CharacterStyleRange>
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]" AppliedConditions="Condition/Texto%20removido"><Content>casa</Content></CharacterStyleRange>
    </ParagraphStyleRange></Story></Document>`;
  const { doc, story } = parseIcml(xml, DOMParser);
  const p = readParagraphs(doc, story)[0];
  const refRem = 'Condition/Texto%20removido';

  // case-insensitive: acha "casa" e "Casa" vivos, mas NÃO o "casa" removido
  const ci = findMatchesInParagraph(p.node, 'casa', false, refRem);
  assert.equal(ci.length, 2, 'duas ocorrências vivas (ignora a removida)');
  assert.deepEqual(ci[0], { start: 0, end: 4 });
  assert.deepEqual(ci[1], { start: 5, end: 9 });

  // case-sensitive: só "casa" minúsculo vivo
  const cs = findMatchesInParagraph(p.node, 'casa', true, refRem);
  assert.equal(cs.length, 1, 'uma ocorrência (caixa exata)');
  assert.deepEqual(cs[0], { start: 0, end: 4 });
});

test('replaceRange marca o antigo como removido e insere o novo como alterado', () => {
  const xml = `<?xml version="1.0"?><Document Self="d"><Story Self="s">
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/x">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/y"><Content>O rato roeu a roupa.</Content></CharacterStyleRange>
    </ParagraphStyleRange></Story></Document>`;
  const { doc, story } = parseIcml(xml, DOMParser);
  const p = readParagraphs(doc, story)[0];
  const refRem = 'Condition/Texto%20removido';
  const refEd  = 'Condition/Texto%20alterado';

  // substitui "rato" (offsets 2..6) por "gato"
  replaceRange(p.node, 2, 6, 'gato', refRem, refEd);

  // texto: "O " + [rato struck] + [gato alterado] + " roeu a roupa."
  assert.equal(paragraphBodyText(p.node), 'O ratogato roeu a roupa.', 'antigo preservado + novo inserido');
  const csrs = [...p.node.getElementsByTagName('CharacterStyleRange')];
  const rato = csrs.find(c => c.textContent === 'rato');
  const gato = csrs.find(c => c.textContent === 'gato');
  assert.ok((rato.getAttribute('AppliedConditions') || '').includes(refRem), 'antigo = removido');
  assert.ok((gato.getAttribute('AppliedConditions') || '').includes(refEd), 'novo = alterado');
  assert.ok(!(gato.getAttribute('AppliedConditions') || '').includes(refRem), 'novo NÃO herda removido');
  assert.equal(gato.getAttribute('AppliedCharacterStyle'), 'CharacterStyle/y', 'novo herda o estilo do trecho');
});

test('headingLevels lê a tag EPUB h1..h4 dos estilos (ignora além de h4 e não-EPUB)', () => {
  const xml = `<?xml version="1.0"?><Document Self="d">
    <ParagraphStyle Self="ParagraphStyle/tit" Name="tit">
      <StyleExportTagMap ExportType="EPUB" ExportTag="h1" /></ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/sub" Name="sub">
      <StyleExportTagMap ExportType="EPUB" ExportTag="h2" /></ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/menor" Name="menor">
      <StyleExportTagMap ExportType="EPUB" ExportTag="h5" /></ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/htmlonly" Name="htmlonly">
      <StyleExportTagMap ExportType="HTML" ExportTag="h1" /></ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/corpo" Name="corpo">
      <StyleExportTagMap ExportType="EPUB" ExportTag="" /></ParagraphStyle>
    <Story Self="s"></Story></Document>`;
  const { doc } = parseIcml(xml, DOMParser);
  const niveis = headingLevels(doc);
  assert.equal(niveis.get('ParagraphStyle/tit'), 1);
  assert.equal(niveis.get('ParagraphStyle/sub'), 2);
  assert.equal(niveis.has('ParagraphStyle/menor'), false, 'h5 fora do intervalo');
  assert.equal(niveis.has('ParagraphStyle/htmlonly'), false, 'só EPUB');
  assert.equal(niveis.has('ParagraphStyle/corpo'), false, 'ExportTag vazio não é heading');
  assert.equal(niveis.size, 2);
});

test('inserir nota adiciona uma <Note> nova sem quebrar o resto', () => {
  const { doc, paras } = carregar();
  const alvo = acharPara(paras, 'A pensão por morte').runs.flatMap(r => r.inlines).find(i => i.type === 'text');

  insertNote(doc, alvo.node, 'Revisar esta frase', { userName: 'Revisor' });
  const out = serializeIcml(doc, XMLSerializer);

  assert.equal(describe(out).notes, describe(original).notes + 1, 'uma nota a mais');
  assert.match(out, /<Content>Revisar esta frase<\/Content>/);
});
