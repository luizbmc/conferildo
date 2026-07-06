import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparar } from '../src/comparar.js';

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
