import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { comparar, icmlBlocks } from '../src/comparar.js';
import { parseIcml, splitParagraphsAtBreaks } from '../src/icml.js';

// Constrói um bloco de parágrafo. `emph` = { bold:[[ini,fim]...], italic:[[...]] }.
function para(text, emph = {}) {
  const dentro = (i, ranges) => (ranges || []).some(([a, b]) => i >= a && i < b);
  const chars = [...text].map((c, i) => ({ c, bold: dentro(i, emph.bold), italic: dentro(i, emph.italic) }));
  return { type: 'para', text, chars, hasImage: false };
}
const tabela = (rows) => ({ type: 'table', rows, nCells: rows.flat().length });
const tipos = a => a.map(x => x.tipo);

test('ignora quebra de parágrafo/linha, espaço duplo, NBSP e soft-hyphen', () => {
  // quebra entre "ENERGIA" e "FOSSIL" (Word em 2 linhas) == concatenado no ID
  assert.deepEqual(comparar([para('ENERGIA\nFOSSIL')], [para('ENERGIAFOSSIL')]), []);
  // espaço duplo == simples
  assert.deepEqual(comparar([para('a  b')], [para('a b')]), []);
  // espaço não-separável (NBSP) == espaço comum
  assert.deepEqual(comparar([para('a\u00a0b')], [para('a b')]), []);
  // soft-hyphen (hífen de sílaba) ignorado
  assert.deepEqual(comparar([para('na\u00adcional')], [para('nacional')]), []);
});

test('diferença REAL de espaço entre palavras acusa (ENERGIA LIMPA ≠ ENERGIALIMPA)', () => {
  const r = comparar([para('ENERGIA LIMPA')], [para('ENERGIALIMPA')]);
  assert.equal(r.length, 1);
  assert.equal(r[0].tipo, 'texto');
});

test('itálico de parágrafo INTEIRO (assinatura) não acusa', () => {
  const w = [para('Deputado Federal', { italic: [[0, 16]] })];   // tudo itálico no Word
  const i = [para('Deputado Federal')];                          // regular no InDesign
  assert.deepEqual(comparar(w, i), []);
});

test('negrito de título inteiro não acusa', () => {
  const w = [para('Introdução', { bold: [[0, 10]] })];
  const i = [para('Introdução')];
  assert.deepEqual(comparar(w, i), []);
});

test('destaque PARCIAL (uma palavra) itálico perdido acusa', () => {
  const w = [para('a revista Plenário é boa', { italic: [[10, 18]] })];  // só "Plenário"
  const i = [para('a revista Plenário é boa')];                          // regular
  const r = comparar(w, i);
  assert.equal(r.length, 1);
  assert.equal(r[0].tipo, 'enfase');
  assert.equal(r[0].prop, 'italic');
  assert.match(r[0].msg, /Plenário/);
});

test('destaque parcial presente também no InDesign não acusa', () => {
  const w = [para('a revista Plenário é boa', { italic: [[10, 18]] })];
  const i = [para('a revista Plenário é boa', { italic: [[10, 18]] })];
  assert.deepEqual(comparar(w, i), []);
});

test('parágrafo de imagem é ignorado', () => {
  const w = [para('Texto de verdade.')];
  const i = [{ type: 'para', text: '', chars: [], hasImage: true }, para('Texto de verdade.')];
  assert.deepEqual(comparar(w, i), []);
});

test('trecho do Word ausente carrega textoWord, contexto e âncora (aposPsr)', () => {
  const A = { ...para('Paragrafo A comum'), psr: { id: 'A' } };
  const C = { ...para('Paragrafo C comum'), psr: { id: 'C' } };
  const wp = [para('Paragrafo A comum'), para('Paragrafo B que sumiu na diagramacao'), para('Paragrafo C comum')];
  const r = comparar(wp, [A, C]);   // B some
  const aus = r.find(x => x.tipo === 'ausente');
  assert.ok(aus, 'detecta o ausente');
  assert.equal(aus.textoWord, 'Paragrafo B que sumiu na diagramacao');
  assert.equal(aus.aposPsr && aus.aposPsr.id, 'A', 'âncora = parágrafo anterior no ICML');
  assert.match(aus.contexto, /Paragrafo B/);
});

test('itens parecidos fora de ordem pareiam por similaridade (não viram falso ausente)', () => {
  // Dois itens parecidos, ambos com pequena diferença e em ordem trocada no ICML.
  // Pareamento por índice casaria errado (→ ausente/extra); por similaridade acerta.
  const H = { ...para('cabeçalho do bloco'), psr: { id: 'H' } };
  const wp = [para('cabeçalho do bloco'),
    para('item alfa detalhe um dois tres quatro'),
    para('item beta detalhe cinco seis sete oito')];
  const ip = [H,
    { ...para('item beta detalhe cinco seis sete oitoX'), psr: { id: 'beta' } },   // beta + X, primeiro
    { ...para('item alfa detalhe um dois tres quatroY'), psr: { id: 'alfa' } }];   // alfa + Y, depois
  const r = comparar(wp, ip);
  assert.equal(r.filter(x => x.tipo === 'ausente').length, 0, 'sem falso ausente');
  assert.equal(r.filter(x => x.tipo === 'extra').length, 0, 'sem falso extra');
  const textos = r.filter(x => x.tipo === 'texto');
  assert.equal(textos.length, 2, 'dois modificados');
  assert.ok(textos.some(t => t.psr.id === 'alfa') && textos.some(t => t.psr.id === 'beta'), 'pareados corretamente');
});

test('trecho ausente no início do documento tem âncora nula', () => {
  const B = { ...para('Segundo paragrafo'), psr: { id: 'B' } };
  const r = comparar([para('Primeiro que sumiu'), para('Segundo paragrafo')], [B]);
  const aus = r.find(x => x.tipo === 'ausente');
  assert.ok(aus);
  assert.equal(aus.aposPsr, null, 'sem parágrafo anterior → insere antes do primeiro');
});

test('parágrafo alterado: diff por palavra (verde adicionado + tachado cortado)', () => {
  const w = [para('O rato roeu a roupa do rei.')];
  const i = [para('O gato roeu a roupa do rei.')];
  const r = comparar(w, i);
  assert.equal(r.length, 1);
  assert.equal(r[0].tipo, 'texto');
  // "gato" foi ADICIONADO pelo ICML → marcado de verde (range no ICML)
  const [gs, ge] = r[0].green[0];
  assert.equal('O gato roeu a roupa do rei.'.slice(gs, ge), 'gato');
  // "rato" (só no Word) foi CORTADO → inserido tachado
  assert.equal(r[0].cuts.length, 1);
  assert.equal(r[0].cuts[0].text.trim(), 'rato');
});

test('palavras a mais no Word (sem contrapartida) viram só corte tachado', () => {
  const r = comparar([para('revista Plenário da vida de contribuir')],
    [para('revista Plenário de contribuir')]);
  const t = r.find(x => x.tipo === 'texto');
  assert.ok(t);
  assert.equal(t.green.length, 0, 'nada adicionado pelo ICML');
  assert.equal(t.cuts.length, 1);
  assert.equal(t.cuts[0].text.trim(), 'da vida', 'corta "da vida"');
});

test('tabelas: nº de células e texto de cada célula', () => {
  const w = [tabela([['A', 'B'], ['C', 'D']])];
  const i = [tabela([['A', 'B'], ['C', 'X']])];   // uma célula difere
  const r = comparar(w, i);
  assert.ok(r.some(x => x.tipo === 'tabela' && /célula/.test(x.msg)));

  const r2 = comparar([tabela([['A', 'B']])], [tabela([['A']])]);
  assert.ok(r2.some(x => x.tipo === 'tabela' && /células difere/.test(x.msg)));
});

test('tabela: quebra de linha na célula (Word) == concatenado (ID) não acusa', () => {
  const r = comparar([tabela([['ENERGIA\nLIMPA']])], [tabela([['ENERGIALIMPA']])]);
  assert.deepEqual(r, []);
});

test('espaço colado na quebra de linha é ignorado', () => {
  // Fim de parágrafo com espaço sobrando no Word × sem espaço no InDesign.
  assert.deepEqual(comparar([tabela([['pneumonia. \nExames de sangue']])],
                            [tabela([['pneumonia.Exames de sangue']])]), []);
  assert.deepEqual(comparar([para('primeira linha \n segunda linha')],
                            [para('primeira linhasegunda linha')]), []);
});

// ── Aspas tipográficas, enumerador automático e hyperlink ─────

test('troca de aspas retas por tipográficas não acusa', () => {
  assert.deepEqual(comparar([para('a peça do "Assediômetro" é a chave')],
                            [para('a peça do \u201cAssediômetro\u201d é a chave')]), []);
  assert.deepEqual(comparar([para("Mont'Alvão, Cláudia")],
                            [para('Mont\u2019Alvão, Cláudia')]), []);
  // guillemets e primo também
  assert.deepEqual(comparar([para('o «texto» dela')], [para('o "texto" dela')]), []);
});

test('diferença REAL dentro das aspas continua acusando', () => {
  const r = comparar([para('a peça do "Assediômetro"')], [para('a peça do \u201cAssediometro\u201d')]);
  assert.equal(r.length, 1);
  assert.equal(r[0].tipo, 'texto');
});

test('enumerador automático do Word × número gravado no ICML não acusa', () => {
  // No Word o número vem da numeração automática (não sai no texto extraído);
  // no InDesign está gravado como texto, com tabulação.
  assert.deepEqual(comparar([para('Protagonismo climático e COP30')],
                            [para('1.4.\tProtagonismo climático e COP30')]), []);
  assert.deepEqual(comparar([para('Cronograma')], [para('2.1 Cronograma')]), []);
  assert.deepEqual(comparar([para('Não sei.')], [para('C. Não sei.')]), []);
  assert.deepEqual(comparar([para('criar um corpus brasileiro')], [para('1. criar um corpus brasileiro')]), []);
  // numeração literal dos dois lados, com pontuação diferente
  assert.deepEqual(comparar([para('7.6.. Governança de conteúdo')], [para('7.6. Governança de conteúdo')]), []);
});

test('enumerador ignorado não engole texto que só parece número', () => {
  // "A construção" / "Civil." não são enumeradores: a diferença tem de aparecer
  const r = comparar([para('A construção do ethos')], [para('A construção do ethas')]);
  assert.equal(r.length, 1);
  const r2 = comparar([para('Civil. O texto original')], [para('Civil. O texto originaL alterado')]);
  assert.equal(r2.length, 1);
});

test('título numerado alterado de verdade acusa, sem marcar o número', () => {
  const r = comparar([para('Protagonismo climático e COP30')],
                     [para('1.4.\tProtagonismo climático e COP29')]);
  assert.equal(r.length, 1);
  assert.equal(r[0].tipo, 'texto');
  const texto = '1.4.\tProtagonismo climático e COP29';
  const [gs, ge] = r[0].green[0];
  assert.equal(texto.slice(gs, ge), 'COP29', 'o verde marca a palavra trocada, não o número');
});

// ── Texto de hyperlink no ICML ────────────────────────────────

// ICML mínimo: um PSR com dois parágrafos (separados por <Br/>) e um
// <HyperlinkTextSource> — como o InDesign grava — no SEGUNDO parágrafo.
const ICML_LINK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Document>
  <Story Self="s1">
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/texto">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Content>Primeiro paragrafo sobre o tema.</Content>
        <Br />
        <Content>No plano internacional, a </Content>
      </CharacterStyleRange>
      <HyperlinkTextSource Self="u1" Name="Origem 1">
        <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
          <Content>Norma Tecnica ISO 24495-1</Content>
        </CharacterStyleRange>
      </HyperlinkTextSource>
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Content> consolidou principios.</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>
  </Story>
</Document>`;

function blocosDoIcmlLink() {
  const { doc, story } = parseIcml(ICML_LINK, DOMParser);
  splitParagraphsAtBreaks(story);   // <Br/> = fim de parágrafo, como o app faz ao abrir
  return icmlBlocks(doc, story);
}

test('texto de hyperlink entra no parágrafo certo e não acusa diferença', () => {
  const ip = blocosDoIcmlLink();
  assert.equal(ip.length, 2, 'dois parágrafos');
  assert.equal(ip[0].text, 'Primeiro paragrafo sobre o tema.', 'o link não vaza para o parágrafo anterior');
  assert.equal(ip[1].text, 'No plano internacional, a Norma Tecnica ISO 24495-1 consolidou principios.');

  const wp = [para('Primeiro paragrafo sobre o tema.'),
              para('No plano internacional, a Norma Tecnica ISO 24495-1 consolidou principios.')];
  assert.deepEqual(comparar(wp, ip), [], 'o hyperlink deixa de gerar falso positivo');
});

test('parágrafo com hyperlink: diferença real acusa, mas sem marcas por trecho', () => {
  const ip = blocosDoIcmlLink();
  const wp = [para('Primeiro paragrafo sobre o tema.'),
              para('No plano internacional, a Norma Tecnica ISO 24495-1 consolidou diretrizes.')];
  const r = comparar(wp, ip);
  assert.equal(r.length, 1);
  assert.equal(r[0].tipo, 'texto');
  // O editor não renderiza o texto do link → os offsets não batem: sem verde/tachado.
  assert.deepEqual(r[0].green, []);
  assert.deepEqual(r[0].cuts, []);
});
