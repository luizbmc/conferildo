import * as icml from './icml.js';
import * as docx from './docx.js';
import * as comparar from './comparar.js';

const SEM_ESTILO_CHAR = 'CharacterStyle/$ID/[No character style]';

let coresCondicao = new Map();   // condSelf → cor de destaque (definido no load)

const state = {
  doc: null,
  story: null,
  fileName: 'revisado.icml',
  pendingNote: null,     // { psr, offset } enquanto o painel de nota está aberto
  pendingRodape: null,   // { footnote, original, holder, psr } ao editar rodapé
  paraAtivo: null,       // PSR do parágrafo clicado (alvo dos estilos de parágrafo)
  selAnchor: null,       // PSR âncora da seleção de bloco (Shift+clique no rótulo)
  selBloco: [],          // PSRs consecutivos selecionados (para recortar)
  clipboardParas: [],    // PSRs na área de transferência aguardando colagem
  clipboardModo: null,   // 'recortar' (mover) | 'copiar' (duplicar)
  condEdicao: null,      // Self da condition "Texto adicionado" (aplicada ao editar)
  condRemovido: null,    // Self da condition "Texto removido" (aplicada ao apagar)
  condMovido: null,      // Self da condition "Texto movido" (aplicada ao recortar/colar)
  busca: { termo: '', matches: [], idx: -1 },  // localizar/substituir
  original: new Map(),   // texto pristino → assinatura (p/ desmarcar ao reverter estilo)
  hist: { stack: [], pos: -1, MAX: 5, restaurando: false, timer: null },  // undo/redo
  comparacao: null,            // achados da última comparação DOCX (null = não rodou)
  comparacaoPsrs: new Set(),   // PSRs a marcar no editor (só do app, não é textCondition)
};

// ── Elementos ─────────────────────────────────────────────────
const el = {
  bannerAtt:      document.getElementById('banner-att'),
  bannerAttMsg:   document.getElementById('banner-att-msg'),
  bannerAttLink:  document.getElementById('banner-att-link'),
  bannerAttFechar: document.getElementById('banner-att-fechar'),
  input:      document.getElementById('input-arquivo'),
  exportar:   document.getElementById('btn-exportar'),
  nomeArq:    document.getElementById('nome-arquivo'),
  painelEstilos: document.getElementById('painel-estilos'),
  listaPara:  document.getElementById('lista-para'),
  listaChar:  document.getElementById('lista-char'),
  limparChar: document.getElementById('btn-limpar-char'),
  btnNota:    document.getElementById('btn-nota'),
  btnRestaurar: document.getElementById('btn-restaurar'),
  btnMarcacoes: document.getElementById('btn-marcacoes'),
  editor:     document.getElementById('editor'),
  vazio:      document.getElementById('vazio'),
  palco:      document.querySelector('.palco'),
  painelAlteracoes: document.getElementById('painel-alteracoes'),
  listaAlteracoes:  document.getElementById('lista-alteracoes'),
  paVazio:    document.getElementById('pa-vazio'),
  paContador: document.getElementById('pa-contador'),
  abaAlteracoes: document.getElementById('aba-alteracoes'),
  abaNavegacao:  document.getElementById('aba-navegacao'),
  conteudoAlteracoes: document.getElementById('conteudo-alteracoes'),
  conteudoNavegacao:  document.getElementById('conteudo-navegacao'),
  listaNavegacao: document.getElementById('lista-navegacao'),
  navVazio:   document.getElementById('nav-vazio'),
  btnDesfazer: document.getElementById('btn-desfazer'),
  btnRefazer:  document.getElementById('btn-refazer'),
  btnIntegridade: document.getElementById('btn-integridade'),
  inputDocx:   document.getElementById('input-docx'),
  abaComparacao: document.getElementById('aba-comparacao'),
  conteudoComparacao: document.getElementById('conteudo-comparacao'),
  listaComparacao: document.getElementById('lista-comparacao'),
  pcResumo:    document.getElementById('pc-resumo'),
  pcContador:  document.getElementById('pc-contador'),
  btnBusca:    document.getElementById('btn-busca'),
  buscaFechar: document.getElementById('busca-fechar'),
  barraBusca:  document.getElementById('barra-busca'),
  buscaTermo:  document.getElementById('busca-termo'),
  buscaSubst:  document.getElementById('busca-subst'),
  buscaCase:   document.getElementById('busca-case'),
  buscaContador: document.getElementById('busca-contador'),
  buscaAnterior: document.getElementById('busca-anterior'),
  buscaProximo:  document.getElementById('busca-proximo'),
  buscaSubstituir:    document.getElementById('busca-substituir'),
  buscaSubstituirTudo: document.getElementById('busca-substituir-tudo'),
  painelNota: document.getElementById('painel-nota'),
  notaAutor:  document.getElementById('nota-autor'),
  notaTexto:  document.getElementById('nota-texto'),
  notaSalvar: document.getElementById('nota-salvar'),
  notaCancel: document.getElementById('nota-cancelar'),
  painelRodape:    document.getElementById('painel-rodape'),
  rodapeEditor:    document.getElementById('rodape-editor'),
  rodapeItalico:   document.getElementById('rodape-italico'),
  rodapeSobre:     document.getElementById('rodape-sobrescrito'),
  rodapeSalvar:    document.getElementById('rodape-salvar'),
  rodapeCancelar:  document.getElementById('rodape-cancelar'),
};

// ── Carregamento de arquivo ───────────────────────────────────
el.input.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) abrirArquivo(file);
});

;['dragover', 'dragenter'].forEach(ev =>
  el.palco.addEventListener(ev, e => { e.preventDefault(); el.palco.classList.add('arrastando'); }));
;['dragleave', 'drop'].forEach(ev =>
  el.palco.addEventListener(ev, e => { e.preventDefault(); el.palco.classList.remove('arrastando'); }));
el.palco.addEventListener('drop', e => {
  const file = e.dataTransfer.files[0];
  if (file) abrirArquivo(file);
});

// Ao focar um parágrafo (corpo) ou célula, marca-o como o parágrafo ativo —
// alvo da aplicação de estilo de parágrafo pelo painel. Delegado via focusin
// (que borbulha, ao contrário de focus).
function ativarPorEvento(e) {
  const ed = e.target.closest?.('.para-body, .tabela td, .tabela th');
  if (ed && ed._psr) marcarParaAtivo(ed._psr, ed.classList.contains('para-body') ? ed.closest('.para') : null);
}
el.editor.addEventListener('focusin', ativarPorEvento);
el.editor.addEventListener('click', ativarPorEvento);

async function abrirArquivo(file) {
  try {
    const texto = await file.text();
    const { doc, story } = icml.parseIcml(texto, DOMParser);
    icml.splitParagraphsAtBreaks(story);   // <Br/> = fim de parágrafo → 1 PSR por parágrafo
    state.doc = doc;
    state.story = story;
    state.fileName = file.name.replace(/\.icml$/i, '') + '-revisado.icml';
    el.nomeArq.textContent = file.name;
    el.exportar.disabled = false;
    el.vazio.hidden = true;
    el.editor.classList.add('ativo');
    el.painelEstilos.hidden = false;
    el.painelAlteracoes.hidden = false;
    el.btnBusca.disabled = false;   // libera o botão; a barra abre sob demanda
    el.btnIntegridade.disabled = false;
    state.comparacao = null; state.comparacaoPsrs = new Set();   // zera comparação anterior
    state.paraAtivo = null;
    // Garante as conditions de controle de alterações (cria se faltarem).
    state.condEdicao   = icml.ensureCondition(doc, 'Texto adicionado', [26, 188, 170]);   // teal
    state.condRemovido = icml.ensureCondition(doc, 'Texto removido', [235, 87, 87]);     // vermelho
    state.condMovido   = icml.ensureCondition(doc, 'Texto movido', [124, 92, 255]);       // violeta
    coresCondicao = icml.conditionColors(doc);
    capturarFormatacaoOriginal();   // baseline p/ detectar "voltou ao original"
    reiniciarHistoria();            // zera o undo/redo do arquivo anterior
    el.editor.classList.remove('marcacoes-ocultas');
    montarPaineis();
    render();
    toast('Arquivo carregado.');
  } catch (err) {
    console.error(err);
    toast('Erro ao abrir: ' + err.message);
  }
}

// ── Painel de estilos (direita) ───────────────────────────────
function montarPaineis() {
  const apChar = icml.characterStyleAppearances(state.doc);

  // Lista de estilos de parágrafo: aplica ao parágrafo ATIVO (o clicado).
  el.listaPara.innerHTML = '';
  for (const s of icml.listParagraphStyles(state.doc)) {
    const item = document.createElement('button');
    item.className = 'pe-item';
    item.appendChild(nomeComGrupo(s.name));   // grupo em destaque
    item.dataset.self = s.self;
    item.addEventListener('mousedown', e => e.preventDefault()); // mantém o parágrafo ativo
    item.addEventListener('click', () => aplicarEstiloParagrafo(s.self));
    el.listaPara.appendChild(item);
  }

  // Lista de estilos de caractere: aplica à SELEÇÃO de texto. Mostra só os estilos
  // básicos de formatação (itálico, negrito, sobrescrito, subscrito), escondendo
  // variantes técnicas (quebra/parte/hifenizar) e estilos não-formatação.
  el.listaChar.innerHTML = '';
  for (const s of icml.listCharacterStyles(state.doc)) {
    if (!estiloCaractereBasico(s.name)) continue;
    const item = document.createElement('button');
    item.className = 'pe-item';
    item.textContent = s.name;
    aplicarAparencia(item, apChar.get(s.self));  // prévia da aparência do estilo
    item.addEventListener('mousedown', e => e.preventDefault()); // preserva a seleção
    item.addEventListener('click', () => aplicarEstiloChar(s.self));
    el.listaChar.appendChild(item);
  }
}

// Só os estilos de caractere básicos aparecem no painel: o nome deve conter uma
// das palavras de formatação (em qualquer caixa) e NÃO conter variantes técnicas.
const KW_CHAR_BASICOS = ['itálico', 'italico', 'italic', 'bold', 'negrito', 'sobrescrito', 'subscrito'];
const KW_CHAR_EXCLUIR = ['quebra', 'parte', 'hifenizar'];
function estiloCaractereBasico(nome) {
  const n = (nome || '').toLowerCase();
  return KW_CHAR_BASICOS.some(k => n.includes(k)) && !KW_CHAR_EXCLUIR.some(k => n.includes(k));
}

// Define o parágrafo ativo (clicado) e reflete no painel + destaque visual.
function marcarParaAtivo(psrNode, paraEl) {
  state.paraAtivo = psrNode;
  el.editor.querySelectorAll('.para.ativo').forEach(x => x.classList.remove('ativo'));
  if (paraEl) paraEl.classList.add('ativo');
  atualizarListaParaAtiva();
}

// Destaca, na lista de estilos de parágrafo, o estilo do parágrafo ativo.
function atualizarListaParaAtiva() {
  const alvo = state.paraAtivo ? state.paraAtivo.getAttribute('AppliedParagraphStyle') : null;
  el.listaPara.querySelectorAll('.pe-item').forEach(it =>
    it.classList.toggle('ativo', it.dataset.self === alvo));
}

// ── Seleção de bloco + recortar/colar parágrafos ──────────────

// Clique no rótulo do estilo: seleciona 1 parágrafo; Shift+clique estende o
// intervalo consecutivo a partir da âncora.
function selecionarRotulo(psr, wrap, estender) {
  marcarParaAtivo(psr, wrap);
  if (estender && state.selAnchor) {
    const lista = icml.paragraphList(state.story);
    const ia = lista.indexOf(state.selAnchor);
    const ib = lista.indexOf(psr);
    if (ia !== -1 && ib !== -1) {
      const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
      state.selBloco = lista.slice(lo, hi + 1);
    } else {
      state.selAnchor = psr; state.selBloco = [psr];
    }
  } else {
    state.selAnchor = psr; state.selBloco = [psr];
  }
  aplicarMarcasParas();
  atualizarBarraParas();
}

// Reaplica as classes de seleção/recorte nos .para já renderizados (sem re-render,
// para não gerar snapshot de histórico numa simples seleção).
function aplicarMarcasParas() {
  el.editor.querySelectorAll('.para').forEach(p => {
    p.classList.toggle('para-sel', state.selBloco.includes(p._psr));
    p.classList.toggle('para-recortada',
      state.clipboardModo === 'recortar' && state.clipboardParas.includes(p._psr));
  });
}

let barraParas = null;
function atualizarBarraParas() {
  if (!barraParas) {
    barraParas = document.createElement('div');
    barraParas.className = 'barra-paras';
    document.body.appendChild(barraParas);
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (state.clipboardParas.length) cancelarClipboard();
      else if (state.selBloco.length) limparSelecao();
    });
  }
  barraParas.innerHTML = '';
  const info = document.createElement('span');
  info.className = 'barra-paras-info';

  if (state.clipboardParas.length) {
    const verbo = state.clipboardModo === 'copiar' ? 'copiado(s)' : 'recortado(s)';
    info.textContent = `${state.clipboardParas.length} parágrafo(s) ${verbo} — clique no destino e cole`;
    barraParas.append(info,
      botaoBarra('📋 Colar aqui', colarParas, true),
      botaoBarra('✕ Cancelar', cancelarClipboard));
    barraParas.hidden = false;
  } else if (state.selBloco.length) {
    info.textContent = `${state.selBloco.length} parágrafo(s) selecionado(s)`;
    barraParas.append(info,
      botaoBarra('✂ Recortar', recortarParas, true),
      botaoBarra('📄 Copiar', copiarParas, true),
      botaoBarra('✕', limparSelecao));
    barraParas.hidden = false;
  } else {
    barraParas.hidden = true;
  }
}

function botaoBarra(txt, fn, primario) {
  const b = document.createElement('button');
  b.className = 'barra-paras-btn' + (primario ? ' primario' : '');
  b.textContent = txt;
  b.addEventListener('click', fn);
  return b;
}

function limparSelecao() {
  state.selBloco = []; state.selAnchor = null;
  aplicarMarcasParas();
  atualizarBarraParas();
}

function recortarParas() {
  if (!state.selBloco.length) return;
  state.clipboardParas = state.selBloco.slice();
  state.clipboardModo = 'recortar';
  state.selBloco = []; state.selAnchor = null;
  aplicarMarcasParas();
  atualizarBarraParas();
  toast(`${state.clipboardParas.length} parágrafo(s) recortado(s). Clique num destino e cole.`);
}

function copiarParas() {
  if (!state.selBloco.length) return;
  state.clipboardParas = state.selBloco.slice();
  state.clipboardModo = 'copiar';
  state.selBloco = []; state.selAnchor = null;
  aplicarMarcasParas();
  atualizarBarraParas();
  toast(`${state.clipboardParas.length} parágrafo(s) copiado(s). Clique num destino e cole.`);
}

function cancelarClipboard() {
  state.clipboardParas = []; state.clipboardModo = null;
  aplicarMarcasParas();
  atualizarBarraParas();
  toast('Cancelado.');
}

// Aplica uma textCondition a todo o conteúdo do parágrafo (texto + fim de ¶).
function aplicarCondicaoParagrafo(psr, condSelf) {
  if (!condSelf) return;
  const ref = refCondition(condSelf);
  const total = icml.paragraphBodyText(psr).length;
  if (total) icml.applyConditionToOffsets(psr, 0, total, ref);
  icml.applyConditionToBreak(psr, ref);
}

function colarParas() {
  if (!state.clipboardParas.length) return;
  const alvo = state.paraAtivo;
  if (!alvo) return toast('Clique no parágrafo de destino primeiro.');
  const copiar = state.clipboardModo === 'copiar';
  if (!copiar && state.clipboardParas.includes(alvo))
    return toast('Escolha um parágrafo de destino fora do bloco recortado.');
  const n = state.clipboardParas.length;

  if (copiar) {
    const clones = icml.copyParagraphsAfter(state.story, state.clipboardParas, alvo);
    if (!clones) return toast('Não foi possível colar aqui.');
    for (const c of clones) aplicarCondicaoParagrafo(c, state.condEdicao);    // "Texto adicionado"
  } else {
    if (!icml.moveParagraphsAfter(state.story, state.clipboardParas, alvo))
      return toast('Não foi possível colar aqui.');
    for (const p of state.clipboardParas) aplicarCondicaoParagrafo(p, state.condMovido);  // "Texto movido"
  }

  state.clipboardParas = []; state.clipboardModo = null;
  state.selBloco = []; state.selAnchor = null;
  render();                 // reflete a nova ordem/condições e agenda snapshot (undo cobre)
  atualizarBarraParas();
  toast(copiar ? `${n} parágrafo(s) copiado(s).` : `${n} parágrafo(s) movido(s).`);
}

// Corpo editável (parágrafo ou célula) que carrega um dado PSR.
function acharBodyPorPsr(psr) {
  return [...el.editor.querySelectorAll('.para-body, .tabela td, .tabela th')].find(b => b._psr === psr) || null;
}

// Aplica o estilo de parágrafo escolhido ao parágrafo ativo (comum ou célula).
function aplicarEstiloParagrafo(styleSelf) {
  if (!state.paraAtivo) return toast('Clique num parágrafo primeiro.');
  // O clique no painel não dispara blur (os itens usam mousedown preventDefault),
  // então comita aqui a edição pendente do parágrafo ativo — assim o texto que foi
  // digitado (ex.: num parágrafo novo) recebe "Texto alterado" antes da troca.
  const bodyAtivo = acharBodyPorPsr(state.paraAtivo);
  if (bodyAtivo) finalizarEdicao(state.paraAtivo, bodyAtivo, bodyAtivo.closest('.para'));
  icml.setParagraphStyle(state.paraAtivo, styleSelf);
  // Acha o .para a re-renderizar: o que tem _psr === ativo (parágrafo comum),
  // ou o que contém a célula com esse psr (dentro de uma tabela).
  let paraEl = [...el.editor.querySelectorAll('.para')].find(x => x._psr === state.paraAtivo);
  if (!paraEl) {
    const cel = [...el.editor.querySelectorAll('.tabela td, .tabela th')].find(td => td._psr === state.paraAtivo);
    paraEl = cel ? cel.closest('.para') : null;
  }
  if (paraEl) rerenderPara(paraEl);
  const novoEl = [...el.editor.querySelectorAll('.para')].find(x => x._psr === state.paraAtivo);
  if (novoEl) novoEl.classList.add('ativo');
  atualizarListaParaAtiva();
  toast('Estilo de parágrafo aplicado.');
}

// Renderiza o nome do estilo com o grupo (parte antes do ":") em destaque.
function nomeComGrupo(nome) {
  const i = (nome || '').indexOf(':');
  if (i < 0) return document.createTextNode(nome || '');
  const frag = document.createDocumentFragment();
  const grupo = document.createElement('span');
  grupo.className = 'estilo-grupo';
  grupo.textContent = nome.slice(0, i + 1);   // inclui os ":"
  frag.append(grupo, document.createTextNode(nome.slice(i + 1)));
  return frag;
}

// Aplica as propriedades de aparência (PointSize/Justification/FillColor/FontStyle)
// como estilos inline no elemento.
function aplicarAparencia(elemento, ap) {
  if (!ap) return;
  if (ap.fontSize)   elemento.style.fontSize   = ap.fontSize;
  if (ap.textAlign)  elemento.style.textAlign  = ap.textAlign;
  if (ap.color)      elemento.style.color      = ap.color;
  if (ap.fontWeight) elemento.style.fontWeight = ap.fontWeight;
  if (ap.fontStyle)  elemento.style.fontStyle  = ap.fontStyle;
  if (ap.fontFamily)  elemento.style.fontFamily  = ap.fontFamily;
  if (ap.lineHeight)  elemento.style.lineHeight  = ap.lineHeight;
  if (ap.marginLeft)  elemento.style.marginLeft  = ap.marginLeft;
  if (ap.marginRight) elemento.style.marginRight = ap.marginRight;
  if (ap.verticalAlign) {
    elemento.style.verticalAlign = ap.verticalAlign;   // sobrescrito/subscrito
    if (!ap.fontSize) elemento.style.fontSize = '0.75em';
  }
  if (ap.backgroundColor) elemento.style.backgroundColor = ap.backgroundColor;
  // Shading/borda com "largura = texto": a caixa abraça o texto (não a coluna).
  // O recuo do texto vem de ap.marginLeft (LeftIndent − offset de borda), calculado
  // no icml.js, para alinhar com os parágrafos vizinhos.
  if (ap.widthText) {
    elemento.style.width = 'fit-content';
    // Se o parágrafo é centralizado/à direita, mantém a caixa junto ao texto.
    if (ap.textAlign === 'center')     elemento.style.marginLeft = elemento.style.marginRight = 'auto';
    else if (ap.textAlign === 'right') elemento.style.marginLeft = 'auto';
  }
  if (ap.borderTop)    elemento.style.borderTop    = ap.borderTop;
  if (ap.borderBottom) elemento.style.borderBottom = ap.borderBottom;
  if (ap.borderLeft)   elemento.style.borderLeft   = ap.borderLeft;
  if (ap.borderRight)  elemento.style.borderRight  = ap.borderRight;
  // Raio dos cantos vem do estilo (ICML). Sem borda, mantém o arredondamento do
  // .para-body (foco). A fusão de bordas consecutivas é feita em juntarBordas, que
  // restaura a borda "limpa" guardada em dataset antes de recalcular.
  if (ap.borderTop || ap.borderBottom || ap.borderLeft || ap.borderRight) {
    if (ap.borderRadius != null) elemento.style.borderRadius = ap.borderRadius;
    const pp = (ap.padding || '').split(/\s+/);
    elemento.dataset.borda = JSON.stringify({
      t: ap.borderTop || '', b: ap.borderBottom || '', l: ap.borderLeft || '',
      r: ap.borderRight || '', radius: ap.borderRadius || '0',
      merge: ap.mergeBorders !== false,
      padT: pp[0] || '', padB: pp[2] || pp[0] || ''   // padding topo/base "limpo" (p/ restaurar na fusão)
    });
  } else if (ap.backgroundColor && ap.borderRadius != null) {
    elemento.style.borderRadius = ap.borderRadius;   // cantos do shading (caixa sem borda)
  }
  if (ap.padding)      elemento.style.padding      = ap.padding;
  if (ap.underline) {
    elemento.style.textDecorationLine = 'underline';
    if (ap.underlineColor)     elemento.style.textDecorationColor     = ap.underlineColor;
    if (ap.underlineThickness) elemento.style.textDecorationThickness = ap.underlineThickness;
    if (ap.underlineOffset)    elemento.style.textUnderlineOffset     = ap.underlineOffset;
  }
}

// ── Renderização ──────────────────────────────────────────────
function render() {
  const paras   = icml.readParagraphs(state.doc, state.story);
  const estilos = icml.listParagraphStyles(state.doc);
  const apPara  = icml.paragraphStyleAppearances(state.doc);
  const apChar  = icml.characterStyleAppearances(state.doc);

  // Carrega do Google Fonts as famílias usadas pelos estilos (idempotente).
  const fontes = new Set();
  for (const ap of [...apPara.values(), ...apChar.values()]) if (ap.fontName) fontes.add(ap.fontName);
  carregarFontesGoogle(fontes);

  ignorarBlurDe(el.editor);   // corpos antigos não devem finalizar edição ao sair
  el.editor.innerHTML = '';
  paras.forEach(p => el.editor.appendChild(renderPara(p, estilos, apPara, apChar)));
  juntarBordas();
  montarNavegador();
  if (!el.conteudoNavegacao.hidden) montarNavegacaoDoc();
  agendarSnapshot();
}

// Aproxima o InDesign: parágrafos consecutivos com a MESMA borda só à esquerda
// têm o vão entre eles removido, para o border-left virar uma linha contínua
// (o espaçamento do texto fica pelos paddings internos, dentro da borda).
function juntarBordas() {
  const wraps = [...el.editor.querySelectorAll('.para')];
  const corpo = w => w.querySelector('.para-body, .para-objeto');
  wraps.forEach(w => w.classList.remove('para-continua-borda'));

  // Restaura a borda "limpa" (do estilo, guardada em dataset) antes de recalcular
  // a fusão — assim re-renders parciais não deixam resíduos das mutações abaixo.
  const specs = wraps.map(w => {
    const c = corpo(w);
    if (!c || !c.dataset.borda) return null;
    const d = JSON.parse(c.dataset.borda);
    c.style.borderTop = d.t; c.style.borderBottom = d.b;
    c.style.borderLeft = d.l; c.style.borderRight = d.r;
    c.style.borderRadius = d.radius;
    if (d.padT) c.style.paddingTop = d.padT;       // restaura padding topo/base "limpo"
    if (d.padB) c.style.paddingBottom = d.padB;
    return d;
  });
  const chave = d => d ? [d.t, d.b, d.l, d.r].join('¦') : null;

  // Funde grupos consecutivos com a MESMA borda: encosta os parágrafos e remove as
  // linhas/cantos internos, formando um contorno único (como o InDesign faz).
  let i = 0;
  while (i < wraps.length) {
    const k = chave(specs[i]);
    if (!k) { i++; continue; }
    // Só encosta o vizinho quando AMBOS têm "mesclar bordas consecutivas" ligado
    // (MergeConsecutiveParaBorders). Se algum desliga a opção, fica caixa separada.
    let j = i;
    while (j + 1 < wraps.length && chave(specs[j + 1]) === k
           && specs[j].merge !== false && specs[j + 1].merge !== false) j++;
    if (j > i) {
      for (let g = i; g <= j; g++) {
        const c = corpo(wraps[g]);
        // Espaço interno entre parágrafos do mesmo estilo dentro do box mesclado =
        // SameParaStyleSpacing (no padding-bottom do de cima; topo do de baixo = 0),
        // mantendo a borda contínua. Os offsets do box ficam só nas bordas externas.
        const mesmoAcima  = g > i && wraps[g]._estilo === wraps[g - 1]._estilo;
        const mesmoAbaixo = g < j && wraps[g]._estilo === wraps[g + 1]._estilo;
        if (g > i) {                       // não é o primeiro: encosta e some com o topo
          wraps[g].classList.add('para-continua-borda');
          c.style.borderTop = 'none';
          c.style.borderTopLeftRadius = '0';
          c.style.borderTopRightRadius = '0';
          if (mesmoAcima && wraps[g].dataset.sameSpacing) c.style.paddingTop = '0';
        }
        if (g < j) {                       // não é o último: some com a base
          c.style.borderBottom = 'none';
          c.style.borderBottomLeftRadius = '0';
          c.style.borderBottomRightRadius = '0';
          if (mesmoAbaixo && wraps[g].dataset.sameSpacing) c.style.paddingBottom = wraps[g].dataset.sameSpacing;
        }
      }
    }
    i = j + 1;
  }
  espacarCaixas();
  espacarMesmoEstilo();
  somarMargens();
}

// No InDesign o espaço entre dois parágrafos é a SOMA do SpaceAfter (de cima) com o
// SpaceBefore (de baixo) — o CSS, ao contrário, COLAPSA (usa o maior). Este passo
// recria a soma: onde ambos têm margem, junta as duas no topo do de baixo e zera a
// base do de cima. Ex.: título de capítulo (SpaceAfter 10mm) + subtítulo
// (SpaceBefore 10mm) → 20mm. Caixas ficam de fora (espacarCaixas já as ajustou).
function somarMargens() {
  const wraps = [...el.editor.querySelectorAll('.para')];
  const ehCaixa = w => w.classList.contains('para-caixa');
  for (let i = 1; i < wraps.length; i++) {
    const prev = wraps[i - 1], cur = wraps[i];
    if (ehCaixa(prev) || ehCaixa(cur)) continue;
    const pmb = parseFloat(getComputedStyle(prev).marginBottom) || 0;
    const cmt = parseFloat(getComputedStyle(cur).marginTop) || 0;
    if (pmb > 0 && cmt > 0) {
      cur.style.marginTop = `${(pmb + cmt).toFixed(1)}px`;
      prev.style.marginBottom = '0px';
    }
  }
}

// "Espaço entre parágrafos do mesmo estilo" (SameParaStyleSpacing): quando dois
// parágrafos consecutivos têm o mesmo estilo, o gap vem desse valor (menor que os
// SpaceBefore/After), no lugar do respiro padrão. Ex.: itens de corpo-recuo-bullet.
// Caixas são tratadas por espacarCaixas (e bordas mescladas exigem 0), então ficam
// de fora aqui.
function espacarMesmoEstilo() {
  const wraps = [...el.editor.querySelectorAll('.para')];
  for (let i = 1; i < wraps.length; i++) {
    const w = wraps[i], prev = wraps[i - 1];
    if (w.classList.contains('para-caixa')) continue;
    const sp = w.dataset.sameSpacing;
    if (sp && w._estilo && w._estilo === prev._estilo) w.style.marginTop = sp;
  }
}

// Dá um respiro extra entre uma caixa (borda ou shading) e os parágrafos normais
// vizinhos — o padding interno faz a caixa parecer "vazar" para o texto ao redor.
// Entre caixas consecutivas (título de destaque + caixa, ou bordas fundidas) o
// espaço fica zerado, para não abrir vãos dentro de uma mesma unidade.
function espacarCaixas() {
  const wraps = [...el.editor.querySelectorAll('.para')];
  const ehCaixa = w => w && w.classList.contains('para-caixa');
  const continua = w => w && w.classList.contains('para-continua-borda');
  wraps.forEach((w, i) => {
    if (!ehCaixa(w)) return;
    const sb = parseFloat(w.dataset.spaceBefore) || 0;   // SpaceBefore do estilo (px)
    const sa = parseFloat(w.dataset.spaceAfter)  || 0;   // SpaceAfter  do estilo (px)
    // Dentro de um grupo de borda mesclada a margem quebraria o contorno contínuo → 0.
    // Contra parágrafo normal: SpaceBefore/SpaceAfter com piso de 20px de respiro.
    // Entre caixas: por padrão encostam (0) — mantém a unidade "cabeçalho + caixa"
    // (ex.: "Dica prática" sobre a caixa tracejada, onde a de baixo é o CORPO). Mas
    // quando a caixa de baixo é um TÍTULO (novo bloco), ou a de cima encerra um grupo
    // mesclado (continua), aplica-se o espaço somado SpaceAfter(cima)+SpaceBefore(baixo),
    // como o InDesign. Contra parágrafo normal: SpaceBefore com piso de 20px de respiro.
    // Dentro de um grupo mesclado a margem quebraria o contorno → 0. O gap entre
    // caixas é controlado pelo topo do de baixo (o de cima zera a base).
    const prev = wraps[i - 1], next = wraps[i + 1];
    const saPrev = prev ? (parseFloat(prev.dataset.spaceAfter) || 0) : 0;
    const novoBloco = w.dataset.titulo === '1' || continua(prev);
    const top = continua(w) ? 0
      : ehCaixa(prev) ? (novoBloco ? saPrev + sb : 0)
      : Math.max(sb, 20);
    const bot = continua(next) ? 0
      : ehCaixa(next) ? 0
      : Math.max(sa, 20);
    w.style.marginTop    = `${top}px`;
    w.style.marginBottom = `${bot}px`;
  });
}

// Marca os corpos/células dentro de `root` para que o blur disparado ao removê-los
// (num re-render) seja ignorado — evita reprocessar edição sobre DOM já alterado.
function ignorarBlurDe(root) {
  root.querySelectorAll?.('.para-body, .tabela td, .tabela th').forEach(e => { e._ignorarBlur = true; });
}

// Injeta um <link> do Google Fonts para cada família usada. Se a família não
// existir no Google, o link simplesmente falha e o CSS cai no fallback genérico.
function carregarFontesGoogle(nomes) {
  for (const nome of nomes) {
    // Só remove tamanho anexado (com unidade pt/px); preserva números que fazem
    // parte do nome da família, como "Source Serif 4".
    const base = nome.replace(/\s+\d+(\.\d+)?\s*(pt|px)$/i, '').trim();
    const id = 'gf-' + base.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (document.getElementById(id)) continue;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(base)}:ital,wght@0,400;0,700;1,400;1,700&display=swap`;
    document.head.appendChild(link);
  }
}

function renderPara(p, estilos, apPara, apChar) {
  const wrap = document.createElement('div');
  wrap.className = 'para';
  wrap._psr = p.node;
  wrap._estilo = p.styleSelf;   // p/ espaçamento entre parágrafos do mesmo estilo
  // Parágrafo inteiro removido → colapsa ao ocultar as marcações (versão final).
  if (paragrafoTotalmenteRemovido(p)) wrap.classList.add('para-removida');
  // Marcação da comparação com o DOCX (só do app, sem relação com textCondition).
  if (state.comparacaoPsrs.has(p.node)) wrap.classList.add('para-diferenca');
  // Seleção de bloco / bloco recortado aguardando colagem.
  if (state.selBloco.includes(p.node))        wrap.classList.add('para-sel');
  if (state.clipboardModo === 'recortar' && state.clipboardParas.includes(p.node))
    wrap.classList.add('para-recortada');
  // Trecho do Word inserido tachado (comparação): estilo NEUTRO 14px — não
  // sabemos com qual estilo formatar, então não herda a aparência do parágrafo.
  const neutra = paragrafoTachadoComparacao(p);

  const paraApTop = neutra ? null : apPara.get(p.styleSelf);
  // Título com SplitDocument: separador de quebra de página antes do parágrafo.
  if (paraApTop?.novaPagina) {
    const hr = document.createElement('hr');
    hr.className = 'nova-pagina';
    wrap.appendChild(hr);
  }
  // Título: mais espaço antes e depois (o de antes um pouco maior). NÃO se aplica a
  // título DENTRO de caixa (parágrafo com borda) — senão abre um vão no meio da
  // caixa; ali o espaçamento vem do padding e a fusão de bordas cuida do resto.
  const temBorda = paraApTop && (paraApTop.borderTop || paraApTop.borderBottom || paraApTop.borderLeft || paraApTop.borderRight);
  const temCaixa = temBorda || !!(paraApTop && paraApTop.backgroundColor);
  // Caixa (borda ou shading) ganha um respiro extra dos parágrafos normais ao redor,
  // aplicado em espacarCaixas (que preserva o encosto entre caixas de uma unidade).
  if (temCaixa) {
    wrap.classList.add('para-caixa');
    // Espaço antes/depois do estilo (SpaceBefore/SpaceAfter) é respeitado por
    // espacarCaixas; sem valor, cai no respiro padrão.
    if (paraApTop.spaceBefore) wrap.dataset.spaceBefore = paraApTop.spaceBefore;
    if (paraApTop.spaceAfter)  wrap.dataset.spaceAfter  = paraApTop.spaceAfter;
    // Caixa-título inicia um novo bloco (não é "corpo" de um cabeçalho acima) →
    // espacarCaixas dá espaço em vez de encostar.
    if (paraApTop.titulo) wrap.dataset.titulo = '1';
  }
  if (paraApTop?.sameStyleSpacing != null) wrap.dataset.sameSpacing = paraApTop.sameStyleSpacing;
  if (paraApTop?.titulo && !temCaixa) {
    // Usa o SpaceBefore/SpaceAfter real do estilo quando houver (ex.: título de
    // capítulo com SpaceAfter de 10mm); sem valor, cai no respiro padrão de título.
    wrap.style.marginTop    = paraApTop.spaceBefore || '30px';
    wrap.style.marginBottom = paraApTop.spaceAfter  || '18px';
  }

  // Coluna esquerda (margem): rótulo do estilo do parágrafo. A troca de estilo
  // é feita pelo painel à direita (clicar no parágrafo → escolher na lista).
  const gutter = document.createElement('div');
  gutter.className = 'para-gutter';
  const rotulo = document.createElement('button');
  rotulo.className = 'para-estilo';
  rotulo.appendChild(nomeComGrupo(p.styleName));   // grupo em destaque
  rotulo.title = 'Clique para selecionar · Shift+clique para selecionar até aqui';
  rotulo.addEventListener('click', e => selecionarRotulo(p.node, wrap, e.shiftKey));
  gutter.appendChild(rotulo);
  wrap.appendChild(gutter);

  // Parágrafo-objeto (tabela ou imagem): renderiza o objeto no lugar do corpo.
  const objetos = p.runs.flatMap(r => r.inlines.filter(i => i.type === 'table' || i.type === 'image'));
  const temTextoReal = p.runs.some(r => r.inlines.some(i =>
    (i.type === 'text' && i.text) || i.type === 'note' || i.type === 'footnote'));

  if (objetos.length && !temTextoReal) {
    const meio = document.createElement('div');
    meio.className = 'para-objeto';
    aplicarAparencia(meio, paraApTop);   // borda/alinhamento do parágrafo-objeto
    for (const o of objetos) {
      if (o.type === 'table') meio.appendChild(renderTabela(o.node, apChar));
      else meio.appendChild(renderImagem(o));
    }
    wrap.appendChild(meio);
  } else {
  // Corpo editável — recebe a aparência do estilo de parágrafo
  const body = document.createElement('div');
  body.className = 'para-body';
  body.contentEditable = 'true';
  body.spellcheck = true;
  body._psr = p.node;                 // PSR do parágrafo (para aplicar estilos)
  body._textoBase = icml.paragraphBodyText(p.node);  // p/ detectar edições
  const paraAp = neutra ? null : apPara.get(p.styleSelf);
  aplicarAparencia(body, paraAp);
  if (neutra) body.classList.add('para-comp-neutra');
  if (paraAp?.bullet) {
    body.classList.add('para-bullet');
    body.dataset.bullet = paraAp.bulletChar || '•';   // caractere do marcador (• padrão)
    if (paraAp.bulletFont) body.style.setProperty('--bullet-fonte', paraAp.bulletFont);
    if (paraAp.bulletCor)  body.style.setProperty('--bullet-cor', paraAp.bulletCor);
    if (paraAp.bulletGap)  body.style.setProperty('--bullet-w', paraAp.bulletGap);
    // Caixa (padding inline) sobrepõe o padding-left do bullet: soma o recuo do
    // marcador (largura da tabulação) ao padding esquerdo da caixa para o marcador
    // não cair sobre o texto e manter-se recuado dentro da caixa.
    if (paraAp.padding) {
      const p = paraAp.padding.split(/\s+/);
      const pl = p[3] || p[1] || p[0] || '0';   // padding-left do shorthand
      body.style.paddingLeft = `calc(${pl} + var(--bullet-w, 1.6em))`;
    }
  }
  // <Br/> é a marca de fim de parágrafo — após splitParagraphsAtBreaks cada PSR
  // tem só o Br terminal, que não é renderizado (cada parágrafo já é um bloco).
  // A quebra de linha forçada (U+2028) é tratada dentro de renderRun.
  for (const run of p.runs) {
    for (const inline of run.inlines) {
      if (inline.type === 'text')          body.appendChild(renderRun(inline, run, apChar));
      else if (inline.type === 'note')     body.appendChild(renderNota(inline));
      else if (inline.type === 'footnote') body.appendChild(renderRodape(inline));
    }
  }
  body.addEventListener('input', () => sincronizarTexto(body));
  // Só finaliza num blur REAL (corpo ainda no DOM). Quando o parágrafo é
  // substituído por rerender, o corpo antigo dispara blur já desconectado — e
  // seus spans apontam para <Content> já modificados; rodar aqui corromperia.
  body.addEventListener('blur', () => { if (!body._ignorarBlur && body.isConnected) finalizarEdicao(p.node, body, wrap); });
  body.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();                       // Shift+Enter = quebra de linha forçada (U+2028)
      inserirQuebraLinha(body);
    } else if (e.key === 'Enter') {
      e.preventDefault();                       // Enter divide o parágrafo no cursor
      const ctx = contexto();
      if (!ctx) return;
      const refRem = state.condRemovido && refCondition(state.condRemovido);
      // Se do cursor até o fim só há conteúdo removido (ou nada), insere um
      // parágrafo LIMPO após este (idêntico ao botão +), sem arrastar o texto
      // struck para o novo parágrafo — assim o texto digitado nasce só "alterado".
      const novo = (refRem && !icml.hasLiveTextFrom(ctx.psr, ctx.start, refRem))
        ? icml.insertParagraphAfter(state.doc, state.story, ctx.psr, { styleSelf: p.styleSelf })
        : icml.splitParagraphAtOffset(state.doc, state.story, ctx.psr, ctx.start);
      render();
      colocarCursor(novo, 0);
    } else if (e.key === 'Backspace') {
      const selec = window.getSelection();
      if (!selec.isCollapsed) return;           // deixa o Backspace normal apagar a seleção
      const ctx = contexto();
      if (!ctx || ctx.start !== 0) return;       // só no início do parágrafo
      const anterior = psrAnterior(ctx.psr);
      if (!anterior) return;                     // já é o primeiro
      e.preventDefault();
      const juncao = icml.paragraphBodyText(anterior).length;
      icml.mergeParagraphWithPrevious(state.story, ctx.psr);
      render();
      colocarCursor(anterior, juncao);
    }
  });
  wrap.appendChild(body);
  }

  // Coluna direita: ações de parágrafo (adicionar abaixo / excluir)
  const acoes = document.createElement('div');
  acoes.className = 'para-acoes';

  const btnAdd = document.createElement('button');
  btnAdd.className = 'para-acao';
  btnAdd.textContent = '＋';
  btnAdd.title = 'Inserir um parágrafo em branco abaixo';
  btnAdd.addEventListener('click', () => {
    const novo = icml.insertParagraphAfter(state.doc, state.story, p.node, { styleSelf: p.styleSelf });
    render();
    colocarCursor(novo, 0);
    toast('Parágrafo adicionado.');
  });
  acoes.appendChild(btnAdd);

  const btnDel = document.createElement('button');
  const jaRemovido = paragrafoTotalmenteRemovido(p);
  btnDel.className = 'para-acao para-acao-del';
  btnDel.textContent = jaRemovido ? '↩' : '🗑';
  btnDel.title = jaRemovido ? 'Desfazer remoção do parágrafo' : 'Marcar o parágrafo como removido';
  btnDel.addEventListener('click', () => {
    if (jaRemovido) {
      restaurarParagrafo(p.node);
      rerenderPara(wrap);
      return toast('Remoção do parágrafo desfeita.');
    }
    const total = icml.paragraphBodyText(p.node).length;
    if (state.condRemovido && total) {
      marcarParagrafoRemovido(p.node);
      rerenderPara(wrap);
      toast('Parágrafo marcado como removido.');
    } else {
      // Parágrafo vazio (ou sem condition): remove de fato, se não for o único.
      if (!icml.deleteParagraph(state.story, p.node)) return toast('Não é possível excluir o único parágrafo.');
      render();
      toast('Parágrafo excluído.');
    }
  });
  acoes.appendChild(btnDel);

  wrap.appendChild(acoes);
  return wrap;
}

const QUEBRA_LINHA = ' ';   // LINE SEPARATOR = quebra de linha forçada do ICML

function renderRun(inline, run, apChar) {
  const span = document.createElement('span');
  span.className = 'run';
  span._content = inline.node;          // referência viva ao <Content>
  span._baseText = inline.text;         // texto no momento do render (baseline p/ o diff)
  // U+2028 (quebra de linha forçada) vira <br>, mantendo o caractere no round-trip.
  if (inline.text.includes(QUEBRA_LINHA)) {
    inline.text.split(QUEBRA_LINHA).forEach((parte, i) => {
      if (i > 0) span.appendChild(document.createElement('br'));
      span.appendChild(document.createTextNode(parte));
    });
  } else {
    span.textContent = inline.text;
  }
  // Aparência do estilo de caractere sobrepõe a do parágrafo (só onde definida).
  aplicarAparencia(span, apChar.get(run.styleSelf));
  // Formatação local do run (itálico/sobrescrito aplicados diretamente no CSR).
  const fontStyle = run.node.getAttribute('FontStyle') || '';
  if (/italic/i.test(fontStyle)) span.style.fontStyle = 'italic';
  if (/bold/i.test(fontStyle))   span.style.fontWeight = '700';
  // Tachado (StrikeThru) — texto do Word CORTADO no ICML (comparação).
  if (/^(true|1)$/i.test(run.node.getAttribute('StrikeThru') || '')) span.style.textDecoration = 'line-through';
  // Verde (CompAdd) — texto ADICIONADO pelo ICML em relação ao Word (comparação).
  if (/^(true|1)$/i.test(run.node.getAttribute('CompAdd') || '')) span.classList.add('run-comp-add');
  if (run.node.getAttribute('Position') === 'Superscript') {
    span.style.verticalAlign = 'super';
    span.style.fontSize = '0.8em';
  }
  // Text conditions. A referência em AppliedConditions é codificada (%20), mas o
  // Self da Condition tem espaço. A cor vai numa variável CSS para o toggle de
  // marcações funcionar; "Texto removido" ganha tachado e some ao ocultar.
  // Só as conditions de alteração/remoção são exibidas — as demais (do fluxo
  // editorial no InDesign) não têm relevância aqui e só distrairiam.
  const relevantes = new Set([state.condEdicao, state.condRemovido, state.condMovido].filter(Boolean));
  const conds = (run.node.getAttribute('AppliedConditions') || '').split(/\s+/).filter(Boolean);
  const cond = conds.map(c => decodeURIComponent(c)).find(c => relevantes.has(c));
  if (cond) {
    span.classList.add('run-cond');
    span.style.setProperty('--cond-cor', coresCondicao.get(cond));
    if (cond === state.condRemovido) span.classList.add('run-removido');
  }
  if (run.styleSelf && !run.styleSelf.includes('[No ')) {
    span.title = 'Estilo: ' + run.styleName;
  }
  return span;
}

function renderNota(inline) {
  const marca = document.createElement('span');
  marca.className = 'nota-marca';
  marca.contentEditable = 'false';
  marca.textContent = '📝';
  marca.title = inline.text;
  marca.addEventListener('click', () => alert('Nota:\n\n' + inline.text));
  return marca;
}

// Marcador de nota de rodapé: superscript numerado (via contador CSS), mostra o
// texto ao clicar. Não conta como texto de corpo (offset/sync o ignoram).
function renderRodape(inline) {
  const marca = document.createElement('sup');
  marca.className = 'rodape-marca';
  marca.contentEditable = 'false';
  marca.title = inline.text;
  marca.addEventListener('click', () => abrirModalRodape(inline.node));
  return marca;
}

// ── Tabela (edição só do texto das células) ───────────────────
// Renderiza a <Table> como uma grade HTML. Cada célula é editável; o texto é
// sincronizado de volta ao ICML. Não há adicionar/excluir/mesclar células — a
// estrutura (linhas, colunas, spans) é apenas reproduzida.
function renderTabela(tableNode, apChar) {
  const t = icml.readTable(state.doc, tableNode);
  const table = document.createElement('table');
  table.className = 'tabela';

  const porPos  = new Map(t.cells.map(c => [`${c.row}:${c.col}`, c]));
  const coberto = new Set();

  for (let r = 0; r < t.rowCount; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < t.colCount; c++) {
      if (coberto.has(`${r}:${c}`)) continue;
      const cell = porPos.get(`${r}:${c}`);
      const td = document.createElement(r < t.headerRows ? 'th' : 'td');
      if (cell) {
        if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
        if (cell.colSpan > 1) td.colSpan = cell.colSpan;
        for (let dr = 0; dr < cell.rowSpan; dr++)
          for (let dc = 0; dc < cell.colSpan; dc++)
            if (dr || dc) coberto.add(`${r + dr}:${c + dc}`);
        td.contentEditable = 'true';
        // Célula de parágrafo único: guarda o PSR para estilos e detecção de edição.
        if (cell.paras.length === 1) { td._psr = cell.paras[0].node; td._textoBase = icml.paragraphBodyText(td._psr); }
        renderCelula(td, cell, apChar);
        td.addEventListener('input', () => sincronizarTexto(td));
        td.addEventListener('blur',  () => {
          if (td._ignorarBlur || !td.isConnected) return;   // ignora blur de re-render
          if (td._psr) finalizarEdicao(td._psr, td, td.closest('.para')); else sincronizarTexto(td);
        });
      }
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  return table;
}

// Imagem: exibida (não editável). O caminho local é servido pelo endpoint
// /local-image (o navegador não carrega file: de uma página http). Se a imagem
// não for encontrada, mostra um marcador com o nome do arquivo.
function renderImagem(inline) {
  const wrap = document.createElement('div');
  wrap.className = 'para-imagem';
  const nome = inline.src ? inline.src.split(/[\\/]/).pop() : '(sem caminho)';
  if (inline.src) {
    const ext = (inline.src.split('.').pop() || '').toLowerCase();
    if (ext === 'ai' || ext === 'pdf') {
      // .ai/.pdf: o navegador não renderiza no <img>; rasteriza a 1ª página com a
      // pdf.js (o .ai salvo com compatibilidade PDF é um PDF válido).
      wrap.appendChild(marcadorImagem(nome + ' — carregando…'));
      renderPdfEmCanvas(wrap, inline.src, nome);
    } else {
      const img = document.createElement('img');
      img.src = '/local-image?path=' + encodeURIComponent(inline.src);
      img.alt = nome;
      img.title = inline.src;
      img.addEventListener('error', () => wrap.replaceChildren(marcadorImagem(nome)));
      wrap.appendChild(img);
    }
  } else {
    wrap.appendChild(marcadorImagem(nome));
  }
  return wrap;
}

// Carrega a pdf.js sob demanda (só quando aparece um .ai/.pdf) e memoiza.
let pdfjsPromise = null;
function carregarPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./vendor/pdf.min.mjs').then(lib => {
      lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

// Rasteriza a 1ª página de um .ai/.pdf num <canvas> e insere no lugar do marcador.
// Falha (ex.: .ai sem compatibilidade PDF) → cai no marcador de imagem ausente.
async function renderPdfEmCanvas(wrap, src, nome) {
  try {
    const pdfjsLib = await carregarPdfjs();
    const pdf = await pdfjsLib.getDocument({
      url: '/local-image?path=' + encodeURIComponent(src),
    }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });   // 2× p/ nitidez na tela
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.title = src;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    wrap.replaceChildren(canvas);
  } catch (err) {
    console.warn('Falha ao rasterizar', src, err);
    wrap.replaceChildren(marcadorImagem(nome));
  }
}

function marcadorImagem(nome) {
  const box = document.createElement('div');
  box.className = 'imagem-ausente';
  box.textContent = '🖼 ' + nome;
  return box;
}

function renderCelula(td, cell, apChar) {
  td.innerHTML = '';
  cell.paras.forEach((p, i) => {
    if (i > 0) td.appendChild(document.createElement('br'));  // separa parágrafos da célula
    for (const run of p.runs)
      for (const inline of run.inlines)
        if (inline.type === 'text') td.appendChild(renderRun(inline, run, apChar));
  });
}

// ── Modal de edição da nota de rodapé ─────────────────────────
// A <Footnote> é uma mini-story (PSR>CSR>Content). Editamos uma CÓPIA do 1º
// parágrafo dela (para Salvar/Cancelar), reaproveitando renderRun/
// sincronizarTexto/offsetDe. O <?ACE?> (número automático) é preservado pelo
// setContentText seguro da engine; itálico e sobrescrito são formatação local.
function abrirModalRodape(footnoteNode) {
  const paras = icml.readParagraphs(state.doc, footnoteNode);
  if (!paras.length) return;
  const original = paras[0].node;
  const holder = state.doc.createElement('Footnote');   // guarda a cópia editável
  holder.appendChild(original.cloneNode(true));

  // Só oferece os botões cujos estilos de caractere existem no ICML.
  const estilos = icml.findCharacterStyles(state.doc);
  el.rodapeItalico.hidden = !estilos.italic;
  el.rodapeSobre.hidden   = !estilos.superscript;

  state.pendingRodape = { footnote: footnoteNode, original, holder, estilos };
  renderRodapeEditor();
  el.painelRodape.hidden = false;
  el.rodapeEditor.focus();
}

function renderRodapeEditor() {
  const p = icml.readParagraphs(state.doc, state.pendingRodape.holder)[0];
  state.pendingRodape.psr = p.node;                     // PSR de trabalho (clone)
  const apChar = icml.characterStyleAppearances(state.doc);
  el.rodapeEditor.innerHTML = '';
  for (const run of p.runs)
    for (const inline of run.inlines)
      if (inline.type === 'text') el.rodapeEditor.appendChild(renderRun(inline, run, apChar));
}

// Aplica (toggle) um estilo de caractere nomeado à seleção da nota.
function formatarRodape(styleSelf) {
  if (!styleSelf) return;
  const selec = window.getSelection();
  if (!selec.rangeCount || !el.rodapeEditor.contains(selec.getRangeAt(0).startContainer))
    return toast('Selecione um trecho da nota primeiro.');
  const range = selec.getRangeAt(0);
  sincronizarTexto(el.rodapeEditor);
  let start = offsetDe(el.rodapeEditor, range.startContainer, range.startOffset);
  let end   = offsetDe(el.rodapeEditor, range.endContainer, range.endOffset);
  if (end < start) [start, end] = [end, start];
  if (end <= start) return toast('Selecione um trecho da nota primeiro.');
  icml.toggleCharacterStyle(state.pendingRodape.psr, start, end, styleSelf);
  renderRodapeEditor();
}

function salvarRodape() {
  sincronizarTexto(el.rodapeEditor);
  const { footnote, original, holder } = state.pendingRodape;
  footnote.replaceChild(holder.firstChild, original);   // cópia editada substitui o original
  fecharModalRodape();
  render();
  toast('Nota de rodapé atualizada.');
}

function fecharModalRodape() {
  el.painelRodape.hidden = true;
  state.pendingRodape = null;
}

el.rodapeEditor.addEventListener('input', () => sincronizarTexto(el.rodapeEditor));
el.rodapeItalico.addEventListener('mousedown', e => e.preventDefault());
el.rodapeItalico.addEventListener('click', () => formatarRodape(state.pendingRodape?.estilos.italic));
el.rodapeSobre.addEventListener('mousedown', e => e.preventDefault());
el.rodapeSobre.addEventListener('click', () => formatarRodape(state.pendingRodape?.estilos.superscript));
el.rodapeSalvar.addEventListener('click', salvarRodape);
el.rodapeCancelar.addEventListener('click', fecharModalRodape);

// ── Sincronização texto → ICML ────────────────────────────────
// Ao digitar num run vazio, o contentEditable costuma criar um nó de texto
// SOLTO fora do span. Percorremos os filhos em ordem e atribuímos cada nó de
// texto solto ao run corrente (sem mover nós, para preservar o cursor), de modo
// que nenhum caractere digitado se perca.
function sincronizarTexto(body) {
  const runs = [...body.querySelectorAll('span.run')];
  if (!runs.length) return new Set();
  const acumulado = new Map(runs.map(r => [r, '']));
  let atual = runs[0];
  for (const filho of body.childNodes) {
    if (filho.nodeType === 1 && filho.classList.contains('nota-marca')) continue;
    if (filho.nodeType === 1 && filho.classList.contains('run')) {
      atual = filho;
      acumulado.set(atual, acumulado.get(atual) + textoDoRun(filho));
    } else if (filho.nodeType === 3) {
      acumulado.set(atual, acumulado.get(atual) + filho.nodeValue);
    }
  }
  // Descritores dos runs sobreviventes: guarda o texto ANTIGO (antes de sobrescrever)
  // para o diff por run em finalizarEdicao, além do <Content> e do CSR de origem.
  const vivos = [];
  for (const [run, texto] of acumulado) {
    if (!run._content) continue;
    // `antigo` = baseline do render (estável entre inputs); NÃO ler de _content,
    // que este mesmo sincronizarTexto sobrescreve a cada tecla digitada.
    const antigo = run._baseText ?? run._content.textContent;
    icml.setContentText(run._content, texto);
    vivos.push({ content: run._content, csr: run._content.parentNode, antigo, novo: texto });
  }
  return vivos;
}

// Aplica a condition "Texto alterado" ao que mudou desde a última renderização.
// Adição/substituição → marca só o trecho alterado (diff por prefixo/sufixo).
// Remoção pura (nada adicionado) → marca o parágrafo INTEIRO.
// Marca um parágrafo INTEIRO como removido: o texto (ou re-insere `base` se o
// Content já estiver vazio) e também o <Br/> de fim de parágrafo.
// Todos os runs de texto do parágrafo têm a condition "Texto removido"?
function paragrafoTotalmenteRemovido(p) {
  if (!state.condRemovido || !icml.paragraphBodyText(p.node)) return false;
  return p.runs.every(run => {
    if (!run.inlines.some(i => i.type === 'text' && i.text)) return true;
    return (run.node.getAttribute('AppliedConditions') || '')
      .split(/\s+/).map(decodeURIComponent).includes(state.condRemovido);
  });
}

// Parágrafo inserido pela comparação: todo o texto marcado com StrikeThru (é o
// trecho do Word ausente no ICML). Renderizado com estilo neutro 14px.
function paragrafoTachadoComparacao(p) {
  const comTexto = p.runs.filter(r => r.inlines.some(i => i.type === 'text' && i.text));
  return comTexto.length > 0 &&
    comTexto.every(r => /^(true|1)$/i.test(r.node.getAttribute('StrikeThru') || ''));
}

function marcarParagrafoRemovido(psr, base = '') {
  if (!state.condRemovido) return;
  const ref = refCondition(state.condRemovido);
  const total = icml.paragraphBodyText(psr).length;
  if (total) icml.applyConditionToOffsets(psr, 0, total, ref);
  else if (base) icml.insertRun(psr, 0, base, ref);
  icml.applyConditionToBreak(psr, ref);   // caractere de fim de parágrafo
}

// Desfaz a remoção de um parágrafo: tira a condition do texto e do <Br/>.
function restaurarParagrafo(psr) {
  if (!state.condRemovido) return;
  const ref = refCondition(state.condRemovido);
  icml.removeConditionFromOffsets(psr, 0, icml.paragraphBodyText(psr).length, ref);
  icml.removeConditionFromBreak(psr, ref);
}

// Finaliza a edição de um corpo/célula. Se o parágrafo foi esvaziado (sem runs),
// o sincronizarTexto sai cedo e o diff não detecta — então marca todo o conteúdo
// restante como "Texto removido". Caso contrário, delega ao marcarEdicao.
function finalizarEdicao(psr, container, paraEl) {
  const base = container._textoBase ?? '';
  if (base && !container.querySelector('span.run')) {
    marcarParagrafoRemovido(psr, base);
    if (paraEl) rerenderPara(paraEl);
    return;
  }
  const vivos = sincronizarTexto(container);
  let mudou = false;
  // Runs apagados por inteiro (sem span): marca-os no lugar como "Texto removido",
  // preservando texto e estilo de caractere. Ficam POSICIONADOS entre os vizinhos,
  // então o diff por run abaixo não precisa (nem deve) re-inseri-los.
  const conjVivos = new Set(vivos.map(v => v.content));
  if (state.condRemovido) mudou = icml.markOrphanRunsRemoved(psr, conjVivos, refCondition(state.condRemovido)) || mudou;
  // Edições DENTRO de cada run sobrevivente (adição / remoção parcial).
  mudou = marcarEdicao(psr, vivos) || mudou;
  if (mudou && paraEl) rerenderPara(paraEl);
}

// Diff POR RUN: para cada run sobrevivente que mudou, marca o trecho ADICIONADO
// ("Texto alterado") e re-insere o APAGADO tachado ("Texto removido"), clonando o
// CSR do run (preserva estilo). Ancorar por run — em vez de um diff do parágrafo
// inteiro — evita que um run apagado no meio (já tratado in loco) seja duplicado.
// Processa da direita p/ a esquerda para que inserções não desloquem offsets ainda
// não processados. Retorna se alterou algo.
function marcarEdicao(psr, vivos) {
  if (!state.condEdicao) return false;
  const refEd = refCondition(state.condEdicao);
  const refRem = state.condRemovido && refCondition(state.condRemovido);
  let mudou = false;

  for (let i = vivos.length - 1; i >= 0; i--) {
    const { content, csr, antigo, novo } = vivos[i];
    if (antigo === novo) continue;
    const inicio = icml.contentStartOffset(psr, content);   // offset do run no parágrafo
    if (inicio < 0) continue;

    let p = 0;
    const min = Math.min(antigo.length, novo.length);
    while (p < min && antigo[p] === novo[p]) p++;
    let a = antigo.length, b = novo.length;
    while (a > p && b > p && antigo[a - 1] === novo[b - 1]) { a--; b--; }
    const apagado = antigo.slice(p, a);

    // ordem importa: marca o adicionado (offset-neutro) antes de inserir o apagado.
    if (b > p) {
      icml.applyConditionToOffsets(psr, inicio + p, inicio + b, refEd);
      // Texto adicionado é conteúdo NOVO — não pode carregar "Texto removido"
      // (herdado ao digitar dentro/junto de um run struck, ex.: parágrafo dividido
      // com ENTER sobre conteúdo removido). Limpa a marca de removido do trecho.
      if (refRem) icml.removeConditionFromOffsets(psr, inicio + p, inicio + b, refRem);
    }
    if (apagado && refRem) icml.insertRemovedRun(psr, inicio + p, apagado, csr, refRem);
    mudou = true;
  }
  return mudou;
}

// Referência de condition para AppliedConditions: codifica o nome (espaço → %20),
// mantendo o prefixo "Condition/".
function refCondition(self) {
  const i = self.indexOf('/');
  return i < 0 ? self : self.slice(0, i + 1) + encodeURIComponent(self.slice(i + 1));
}

// Shift+Enter: insere uma quebra de linha forçada no cursor. Coloca um <br> dentro
// do run atual (não entre runs, senão sincronizarTexto o ignora) e sincroniza — o
// textoDoRun converte o <br> em U+2028, gravando a quebra no <Content> do ICML.
function inserirQuebraLinha(body) {
  const selec = window.getSelection();
  if (!selec.rangeCount) return;
  const range = selec.getRangeAt(0);
  if (!body.contains(range.startContainer)) return;
  range.deleteContents();                       // substitui a seleção, se houver

  // Garante que o <br> caia DENTRO de um span.run (não solto no corpo).
  let alvo = range.startContainer;
  if (alvo === body) {
    const filho = body.childNodes[range.startOffset] || body.lastChild;
    const run = filho && filho.nodeType === 1 && filho.classList.contains('run')
      ? filho : body.querySelector('span.run');
    if (!run) return;
    range.selectNodeContents(run);
    range.collapse(false);                       // fim do run
  }

  const br = document.createElement('br');
  range.insertNode(br);
  range.setStartAfter(br);
  range.collapse(true);
  selec.removeAllRanges();
  selec.addRange(range);
  sincronizarTexto(body);                        // grava o U+2028 no ICML
}

// Texto lógico de um run: nós de texto + <br> reconstituído como U+2028.
function textoDoRun(span) {
  let s = '';
  for (const n of span.childNodes) {
    if (n.nodeType === 3) s += n.nodeValue;
    else if (n.nodeType === 1 && n.tagName === 'BR') s += QUEBRA_LINHA;
  }
  return s;
}

// ── Contexto de seleção (parágrafo + offsets) ─────────────────
// Funciona tanto no corpo do parágrafo (.para-body) quanto numa célula de
// tabela (td/th), ambos portando o PSR do seu conteúdo em `_psr`.
function contexto() {
  const selec = window.getSelection();
  if (!selec.rangeCount) return null;
  const range = selec.getRangeAt(0);
  const ed = ancestralEditavel(range.startContainer);
  if (!ed || ancestralEditavel(range.endContainer) !== ed || !ed._psr) return null;
  sincronizarTexto(ed); // garante que o ICML reflete o texto atual
  let start = offsetDe(ed, range.startContainer, range.startOffset);
  let end   = offsetDe(ed, range.endContainer, range.endOffset);
  if (end < start) [start, end] = [end, start];
  return { paraEl: ed.closest('.para'), body: ed, psr: ed._psr, start, end };
}

function ancestralEditavel(node) {
  const elemento = node.nodeType === 1 ? node : node.parentElement;
  return elemento ? elemento.closest('.para-body, .tabela td, .tabela th') : null;
}

// Offset de caractere no corpo do parágrafo. Percorre os filhos em ordem,
// descendo nos filhos dos spans .run (nós de texto e <br>, este contando como 1
// caractere = U+2028), ignorando as marcas de nota. Localiza o cursor mesmo em
// nó de texto solto recém-digitado ou dentro de um run com quebra forçada.
function offsetDe(body, node, nodeOffset) {
  let total = 0;
  for (const filho of body.childNodes) {
    if (filho.nodeType === 1 && filho.classList.contains('nota-marca')) continue;
    if (filho.nodeType === 3) {                      // nó de texto solto
      if (node === filho) return total + nodeOffset;
      total += filho.nodeValue.length;
    } else if (filho.nodeType === 1 && filho.classList.contains('run')) {
      // Seleção com o próprio span como container (offset = índice de filho):
      // 0 = início do span, >0 = fim do span.
      if (node === filho) return total + (nodeOffset > 0 ? textoDoRun(filho).length : 0);
      for (const sub of filho.childNodes) {
        if (node === sub) return total + (sub.nodeType === 3 ? nodeOffset : 0);
        if (sub.nodeType === 3)                total += sub.nodeValue.length;
        else if (sub.nodeType === 1 && sub.tagName === 'BR') total += 1;
      }
    }
  }
  return total;
}

// Assinatura de formatação por caractere de um parágrafo: para cada caractere do
// corpo, "<char><estilo>|<FontStyle>|<Position>". Alinhada aos offsets de
// applyConditionToOffsets (conta só <Content>, incluindo U+2028; ignora notas/Br).
function assinaturaFormatacao(psr) {
  const sig = [];
  for (const csr of Array.from(psr.childNodes)) {
    if (csr.nodeType !== 1 || csr.tagName !== 'CharacterStyleRange') continue;
    const fmt = '' + (csr.getAttribute('AppliedCharacterStyle') || '') + '|'
      + (csr.getAttribute('FontStyle') || '') + '|' + (csr.getAttribute('Position') || '');
    for (const c of Array.from(csr.childNodes)) {
      if (c.nodeType !== 1 || c.tagName !== 'Content') continue;
      const t = c.textContent;
      for (let i = 0; i < t.length; i++) sig.push(t[i] + fmt);
    }
  }
  return sig;
}

// Captura o estado pristino de cada parágrafo, indexado pelo TEXTO (não pelo nó —
// assim o baseline sobrevive a um undo/redo, que recria os nós ao reparsear).
function capturarFormatacaoOriginal() {
  state.original = new Map();   // texto pristino → assinatura de formatação por caractere
  for (const p of icml.readParagraphs(state.doc, state.story)) {
    const t = icml.paragraphBodyText(p.node);
    const sig = assinaturaFormatacao(p.node);
    // Texto duplicado com formatação diferente é ambíguo → desabilita o reconcile ali.
    if (state.original.has(t)) {
      if ((state.original.get(t) || []).join('') !== sig.join('')) state.original.set(t, null);
    } else state.original.set(t, sig);
  }
}

// Após uma operação de estilo, remove a marca "Texto adicionado" dos caracteres do
// trecho que voltaram EXATAMENTE ao original (mesmo caractere e mesma formatação).
// O baseline é achado pelo texto atual do parágrafo — o que só bate quando o texto
// está intacto desde o load (offsets alinhados); senão, no-op (degradação segura).
function reconciliarComOriginal(psr, start, end) {
  if (!state.condEdicao) return;
  const origSig = state.original.get(icml.paragraphBodyText(psr));
  if (!origSig) return;   // texto atual não corresponde a nenhum parágrafo original
  const atual = assinaturaFormatacao(psr);
  const ref = refCondition(state.condEdicao);
  const lim = Math.min(end, atual.length, origSig.length);
  let i = Math.max(0, start);
  while (i < lim) {
    if (atual[i] === origSig[i]) {
      let j = i;
      while (j < lim && atual[j] === origSig[j]) j++;
      icml.removeConditionFromOffsets(psr, i, j, ref);
      i = j;
    } else i++;
  }
}

// ── Ações da barra ────────────────────────────────────────────
function aplicarEstiloChar(styleSelf) {
  const ctx = contexto();
  if (!ctx || ctx.end <= ctx.start) return toast('Selecione um trecho de texto primeiro.');
  icml.applyCharacterStyleToOffsets(ctx.psr, ctx.start, ctx.end, styleSelf);
  // Mudar o estilo é uma alteração: marca o trecho como "Texto adicionado".
  if (state.condEdicao) icml.applyConditionToOffsets(ctx.psr, ctx.start, ctx.end, refCondition(state.condEdicao));
  // …mas se o trecho voltou ao estado original (ex.: negrito removido), desmarca.
  reconciliarComOriginal(ctx.psr, ctx.start, ctx.end);
  rerenderPara(ctx.paraEl);
  toast('Estilo aplicado.');
}

el.limparChar.addEventListener('mousedown', e => e.preventDefault());
el.limparChar.addEventListener('click', () => aplicarEstiloChar(SEM_ESTILO_CHAR));

// Desfazer remoção: tira a condition "Texto removido" da seleção.
el.btnRestaurar.addEventListener('mousedown', e => e.preventDefault());
el.btnRestaurar.addEventListener('click', () => {
  const ctx = contexto();
  if (!ctx || ctx.end <= ctx.start) return toast('Selecione o texto removido a restaurar.');
  icml.removeConditionFromOffsets(ctx.psr, ctx.start, ctx.end, refCondition(state.condRemovido));
  rerenderPara(ctx.paraEl);
  toast('Remoção desfeita.');
});

// Exibir/ocultar as marcações de text condition (destaques e texto removido).
el.btnMarcacoes.addEventListener('click', () => {
  const ocultas = el.editor.classList.toggle('marcacoes-ocultas');
  el.btnMarcacoes.textContent = ocultas ? 'Exibir marcações' : 'Ocultar marcações';
});

el.btnNota.addEventListener('mousedown', e => e.preventDefault());
el.btnNota.addEventListener('click', () => {
  const ctx = contexto();
  if (!ctx) return toast('Posicione o cursor no texto primeiro.');
  state.pendingNote = { psr: ctx.psr, offset: ctx.start, paraEl: ctx.paraEl };
  el.notaTexto.value = '';
  el.notaAutor.value = localStorage.getItem('revisor-nota-autor') || '';   // lembra o último autor
  el.painelNota.hidden = false;
  (el.notaAutor.value ? el.notaTexto : el.notaAutor).focus();
});

el.notaCancel.addEventListener('click', fecharPainelNota);
el.notaSalvar.addEventListener('click', () => {
  if (!state.pendingNote) return fecharPainelNota();
  const autor = el.notaAutor.value.trim();
  const texto = el.notaTexto.value.trim();
  if (!autor) { el.notaAutor.focus(); return toast('Informe o nome do autor da nota.'); }
  if (!texto) { el.notaTexto.focus(); return toast('Escreva o texto da nota.'); }
  const { psr, offset, paraEl } = state.pendingNote;
  localStorage.setItem('revisor-nota-autor', autor);   // guarda p/ a próxima nota
  icml.insertNoteAtOffset(state.doc, psr, offset, texto, { userName: autor });
  fecharPainelNota();
  rerenderPara(paraEl);
  toast('Nota inserida.');
});

function fecharPainelNota() {
  el.painelNota.hidden = true;
  state.pendingNote = null;
}

// PSR anterior no ICML (irmão ParagraphStyleRange precedente).
function psrAnterior(psr) {
  let p = psr.previousSibling;
  while (p && !(p.nodeType === 1 && p.tagName === 'ParagraphStyleRange')) p = p.previousSibling;
  return p;
}

// Coloca o cursor num parágrafo (por nó PSR) no offset de corpo indicado.
function colocarCursor(psrNode, offset) {
  const para = [...el.editor.querySelectorAll('.para')].find(x => x._psr === psrNode);
  if (!para) return;
  const body = para.querySelector('.para-body');
  body.focus();
  const spans = [...body.querySelectorAll('span.run')];
  const range = document.createRange();
  if (!spans.length) {
    range.setStart(body, 0);
  } else {
    let acc = 0, colocado = false;
    for (const span of spans) {
      const len = span.textContent.length;
      if (offset <= acc + len) {
        range.setStart(span.firstChild || span, Math.max(0, offset - acc));
        colocado = true;
        break;
      }
      acc += len;
    }
    if (!colocado) {
      const ultimo = spans[spans.length - 1];
      range.setStart(ultimo.firstChild || ultimo, ultimo.textContent.length);
    }
  }
  range.collapse(true);
  const selec = window.getSelection();
  selec.removeAllRanges();
  selec.addRange(range);
}

// Re-renderiza um único parágrafo a partir do ICML (após operação estrutural).
function rerenderPara(paraEl) {
  const estilos = icml.listParagraphStyles(state.doc);
  const apPara  = icml.paragraphStyleAppearances(state.doc);
  const apChar  = icml.characterStyleAppearances(state.doc);
  const paras = icml.readParagraphs(state.doc, state.story);
  const p = paras.find(x => x.node === paraEl._psr);
  if (!p) return;
  const novo = renderPara(p, estilos, apPara, apChar);
  ignorarBlurDe(paraEl);      // o corpo antigo dispara blur ao ser substituído
  paraEl.replaceWith(novo);
  juntarBordas();
  montarNavegador();
  if (!el.conteudoNavegacao.hidden) montarNavegacaoDoc();
  agendarSnapshot();
}

// ── Undo / Redo ───────────────────────────────────────────────
// Histórico de snapshots do documento inteiro (serializado). Observa cada
// re-render e captura o estado (debounced, p/ coalescer várias renders de uma
// mesma ação). Guarda até MAX passos. Não instrumenta cada operação — o doc é a
// fonte da verdade e todo edit termina num render.
function agendarSnapshot() {
  const h = state.hist;
  if (h.restaurando || !state.doc) return;
  clearTimeout(h.timer);
  h.timer = setTimeout(capturarSnapshot, 250);
}

function capturarSnapshot() {
  const h = state.hist;
  clearTimeout(h.timer); h.timer = null;
  if (!state.doc) return;
  const xml = icml.serializeIcml(state.doc, XMLSerializer);
  if (h.pos >= 0 && h.stack[h.pos] === xml) return;   // nada mudou desde o último
  h.stack = h.stack.slice(0, h.pos + 1);              // descarta o "redo" pendente
  h.stack.push(xml);
  if (h.stack.length > h.MAX + 1) h.stack.shift();     // mantém MAX passos + o atual
  h.pos = h.stack.length - 1;
  atualizarBotoesHistoria();
}

function reiniciarHistoria() {
  const h = state.hist;
  clearTimeout(h.timer);
  Object.assign(h, { stack: [], pos: -1, timer: null, restaurando: false });
  atualizarBotoesHistoria();
}

function desfazer() {
  const h = state.hist;
  if (h.timer) capturarSnapshot();       // garante que a última ação foi registrada
  if (h.pos <= 0) return;
  h.pos--;
  restaurarSnapshot(h.stack[h.pos]);
  toast('Desfeito.');
}

function refazer() {
  const h = state.hist;
  if (h.timer) capturarSnapshot();
  if (h.pos >= h.stack.length - 1) return;
  h.pos++;
  restaurarSnapshot(h.stack[h.pos]);
  toast('Refeito.');
}

// Reparseia o documento do snapshot e re-renderiza. NÃO recaptura o baseline
// pristino (state.original é do load e é indexado por texto, então continua válido).
function restaurarSnapshot(xml) {
  const h = state.hist;
  h.restaurando = true;
  const { doc, story } = icml.parseIcml(xml, DOMParser);
  state.doc = doc;
  state.story = story;
  state.condEdicao   = icml.ensureCondition(doc, 'Texto adicionado', [26, 188, 170]);
  state.condRemovido = icml.ensureCondition(doc, 'Texto removido', [235, 87, 87]);
  state.condMovido   = icml.ensureCondition(doc, 'Texto movido', [124, 92, 255]);
  coresCondicao = icml.conditionColors(doc);
  state.paraAtivo = null;
  state.selAnchor = null; state.selBloco = []; state.clipboardParas = []; state.clipboardModo = null;
  state.busca.matches = []; state.busca.idx = -1; atualizarContadorBusca();
  render();
  atualizarBarraParas();
  h.restaurando = false;
  atualizarBotoesHistoria();
}

function atualizarBotoesHistoria() {
  const h = state.hist;
  if (el.btnDesfazer) el.btnDesfazer.disabled = h.pos <= 0;
  if (el.btnRefazer)  el.btnRefazer.disabled  = h.pos >= h.stack.length - 1;
}

// ── Navegador de alterações (esquerda) ────────────────────────
// Lista os trechos com condition de controle (Texto alterado / Texto removido),
// agrupando runs consecutivos de mesmo tipo dentro de um parágrafo. Clicar rola
// até o trecho e o destaca momentaneamente.
function montarNavegador() {
  if (!el.listaAlteracoes) return;
  el.listaAlteracoes.innerHTML = '';
  const grupos = coletarAlteracoes();
  el.paContador.textContent = String(grupos.length);
  el.paVazio.hidden = grupos.length > 0;

  for (const g of grupos) {
    const item = document.createElement('button');
    item.className = 'pa-item tipo-' + g.tipo;
    const tipo = document.createElement('span');
    tipo.className = 'pa-tipo';
    tipo.textContent = g.tipo === 'removido' ? 'Texto removido' : 'Texto adicionado';
    const prev = document.createElement('span');
    prev.className = 'pa-preview';
    prev.textContent = previewTexto(g.texto);
    item.append(tipo, prev);
    item.addEventListener('click', () => irParaAlteracao(g));
    el.listaAlteracoes.appendChild(item);
  }
}

// Tipo de alteração de um run pelas conditions aplicadas (removido tem prioridade).
function tipoDoRun(run) {
  const refs = (run.node.getAttribute('AppliedConditions') || '')
    .split(/\s+/).filter(Boolean).map(decodeURIComponent);
  if (state.condRemovido && refs.includes(state.condRemovido)) return 'removido';
  if (state.condEdicao   && refs.includes(state.condEdicao))   return 'alterado';
  return null;
}

// Varre os parágrafos e agrupa trechos alterados consecutivos de mesmo tipo.
function coletarAlteracoes() {
  if (!state.doc) return [];
  const grupos = [];
  for (const p of icml.readParagraphs(state.doc, state.story)) {
    let atual = null;
    for (const run of p.runs) {
      const txt   = run.inlines.filter(i => i.type === 'text').map(i => i.text).join('');
      const tipo = tipoDoRun(run);
      if (!tipo) {
        // Um run sobrevivente de só espaço não encerra o trecho: mantém a
        // continuidade (ex.: espaço não apagado no meio de uma remoção contígua).
        if (atual && txt && !txt.trim()) atual.texto += txt;
        else atual = null;
        continue;
      }
      const nodes = run.inlines.filter(i => i.type === 'text' && i.node).map(i => i.node);
      if (!atual || atual.tipo !== tipo) {
        atual = { tipo, psr: p.node, texto: '', contents: [] };
        grupos.push(atual);
      }
      atual.texto += txt;
      atual.contents.push(...nodes);
    }
  }
  // Descarta grupos sem texto visível (ex.: só a marca de fim de parágrafo).
  return grupos.filter(g => g.texto.replace(/\s+/g, ' ').trim());
}

// Normaliza o texto para preview: colapsa espaços/quebras e limita a 100 chars.
function previewTexto(t) {
  const limpo = t.replace(/\s+/g, ' ').trim();
  return limpo.length > 100 ? limpo.slice(0, 100) + '…' : limpo;
}

// Rola até o parágrafo do trecho e pisca os runs correspondentes.
function irParaAlteracao(g) {
  const para = [...el.editor.querySelectorAll('.para')].find(x => x._psr === g.psr);
  if (!para) return;
  para.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const alvo = new Set(g.contents);
  for (const s of para.querySelectorAll('span.run')) {
    if (!alvo.has(s._content)) continue;
    s.classList.remove('run-flash');
    void s.offsetWidth;               // reinicia a animação
    s.classList.add('run-flash');
  }
}

// ── Aba Navegação (títulos/subtítulos) ────────────────────────
// Monta a lista de headings do documento (h1..h4, pelas tags de exportação EPUB
// dos estilos de parágrafo). Cada item rola até o parágrafo correspondente.
function montarNavegacaoDoc() {
  if (!el.listaNavegacao) return;
  el.listaNavegacao.innerHTML = '';
  const itens = coletarNavegacao();
  el.navVazio.hidden = itens.length > 0;
  for (const it of itens) {
    const b = document.createElement('button');
    b.className = 'nav-item nav-h' + it.nivel;
    b.textContent = it.texto || '(sem texto)';
    b.title = it.texto;
    b.addEventListener('click', () => irParaTitulo(it.psr));
    el.listaNavegacao.appendChild(b);
  }
}

// Percorre os parágrafos e coleta os que usam um estilo com tag de heading.
function coletarNavegacao() {
  if (!state.doc) return [];
  const niveis = icml.headingLevels(state.doc);
  if (!niveis.size) return [];
  const out = [];
  for (const p of icml.readParagraphs(state.doc, state.story)) {
    const nivel = niveis.get(p.styleSelf);
    if (!nivel) continue;
    out.push({ nivel, texto: icml.paragraphBodyText(p.node).replace(/\s+/g, ' ').trim(), psr: p.node });
  }
  return out;
}

// Rola até um parágrafo (por PSR) e pisca-o.
function irParaTitulo(psr) {
  const para = [...el.editor.querySelectorAll('.para')].find(x => x._psr === psr);
  if (!para) return;
  para.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const alvo = para.querySelector('.para-body') || para;
  alvo.classList.remove('run-flash');
  void alvo.offsetWidth;
  alvo.classList.add('run-flash');
}

function trocarAba(nome) {
  const abas = { navegacao: el.abaNavegacao, alteracoes: el.abaAlteracoes, comparacao: el.abaComparacao };
  const conteudos = { navegacao: el.conteudoNavegacao, alteracoes: el.conteudoAlteracoes, comparacao: el.conteudoComparacao };
  for (const k of Object.keys(abas)) {
    abas[k].classList.toggle('ativa', k === nome);
    conteudos[k].hidden = k !== nome;
  }
  if (nome === 'navegacao') montarNavegacaoDoc();
  if (nome === 'comparacao') montarComparacao();
}
el.abaNavegacao.addEventListener('click', () => trocarAba('navegacao'));
el.abaAlteracoes.addEventListener('click', () => trocarAba('alteracoes'));
el.abaComparacao.addEventListener('click', () => trocarAba('comparacao'));

// ── Localizar / substituir ────────────────────────────────────
// Busca apenas no texto VIVO (ignora o que já está "Texto removido"). A
// substituição segue o track-changes: o antigo vira "Texto removido" (tachado)
// e o novo "Texto alterado".
function recalcularBusca() {
  const termo = el.buscaTermo.value;
  const cs = el.buscaCase.checked;
  const refRem = state.condRemovido && refCondition(state.condRemovido);
  const matches = [];
  if (state.doc && termo) {
    for (const p of icml.readParagraphs(state.doc, state.story))
      for (const m of icml.findMatchesInParagraph(p.node, termo, cs, refRem))
        matches.push({ psr: p.node, start: m.start, end: m.end });
  }
  state.busca.termo = termo;
  state.busca.matches = matches;
  if (state.busca.idx >= matches.length) state.busca.idx = matches.length - 1;
  atualizarContadorBusca();
}

function atualizarContadorBusca() {
  const n = state.busca.matches.length;
  const i = state.busca.idx;
  el.buscaContador.textContent = n ? `${i < 0 ? 0 : i + 1}/${n}` : '0/0';
}

function localizar(dir) {
  const n = state.busca.matches.length;
  if (!n) { atualizarContadorBusca(); return toast('Nenhuma ocorrência.'); }
  if (state.busca.idx < 0) state.busca.idx = dir > 0 ? 0 : n - 1;
  else state.busca.idx = (state.busca.idx + dir + n) % n;
  irParaMatch(state.busca.idx);
  atualizarContadorBusca();
}

function irParaMatch(i) {
  const m = state.busca.matches[i];
  if (!m) return;
  const para = [...el.editor.querySelectorAll('.para')].find(x => x._psr === m.psr);
  const body = para && para.querySelector('.para-body');
  if (body) selecionarNoCorpo(body, m.start, m.end);
}

// Posição DOM (nó + offset) para um offset de corpo — inverso de offsetDe (conta
// <br> como 1 = U+2028, ignora marcas de nota).
function posicaoDom(body, alvo) {
  let total = 0;
  for (const filho of body.childNodes) {
    if (filho.nodeType === 1 && filho.classList.contains('nota-marca')) continue;
    if (filho.nodeType === 3) {
      const len = filho.nodeValue.length;
      if (alvo <= total + len) return { node: filho, offset: alvo - total };
      total += len;
    } else if (filho.nodeType === 1 && filho.classList.contains('run')) {
      for (const sub of filho.childNodes) {
        if (sub.nodeType === 3) {
          const len = sub.nodeValue.length;
          if (alvo <= total + len) return { node: sub, offset: alvo - total };
          total += len;
        } else if (sub.nodeType === 1 && sub.tagName === 'BR') {
          total += 1;
        }
      }
    }
  }
  return { node: body, offset: body.childNodes.length };
}

function selecionarNoCorpo(body, start, end) {
  const a = posicaoDom(body, start), b = posicaoDom(body, end);
  const range = document.createRange();
  try { range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset); }
  catch { return; }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const alvo = (a.node.nodeType === 1 ? a.node : a.node.parentElement) || body;
  alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function substituirAtual() {
  const m = state.busca.matches[state.busca.idx];
  if (!m) return localizar(1);          // nada selecionado ainda → vai ao próximo
  const refRem = state.condRemovido && refCondition(state.condRemovido);
  const refEd  = state.condEdicao && refCondition(state.condEdicao);
  icml.replaceRange(m.psr, m.start, m.end, el.buscaSubst.value, refRem, refEd);
  const para = [...el.editor.querySelectorAll('.para')].find(x => x._psr === m.psr);
  if (para) rerenderPara(para);
  const idx = state.busca.idx;
  recalcularBusca();                    // o trecho substituído sai da lista (agora removido)
  state.busca.idx = Math.min(idx, state.busca.matches.length - 1);
  if (state.busca.matches.length) irParaMatch(state.busca.idx);
  atualizarContadorBusca();
}

function substituirTudo() {
  if (!state.doc || !el.buscaTermo.value) return;
  const cs = el.buscaCase.checked, novo = el.buscaSubst.value;
  const refRem = state.condRemovido && refCondition(state.condRemovido);
  const refEd  = state.condEdicao && refCondition(state.condEdicao);
  let total = 0;
  for (const p of icml.readParagraphs(state.doc, state.story)) {
    const ms = icml.findMatchesInParagraph(p.node, el.buscaTermo.value, cs, refRem);
    for (let i = ms.length - 1; i >= 0; i--) {   // direita→esquerda: offsets estáveis
      icml.replaceRange(p.node, ms[i].start, ms[i].end, novo, refRem, refEd);
      total++;
    }
  }
  if (!total) return toast('Nenhuma ocorrência.');
  render();
  state.busca.idx = -1;
  recalcularBusca();
  toast(`${total} ocorrência(s) substituída(s).`);
}

el.buscaTermo.addEventListener('input', recalcularBusca);
el.buscaCase.addEventListener('change', () => { recalcularBusca(); if (state.busca.matches.length) localizar(1); });
el.buscaTermo.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); localizar(e.shiftKey ? -1 : 1); }
});
el.buscaSubst.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); substituirAtual(); }
});
el.buscaProximo.addEventListener('click', () => localizar(1));
el.buscaAnterior.addEventListener('click', () => localizar(-1));
el.buscaSubstituir.addEventListener('click', substituirAtual);
el.buscaSubstituirTudo.addEventListener('click', substituirTudo);

// Abrir/fechar a barra sob demanda (não ocupa uma linha o tempo todo).
function abrirBusca() {
  if (el.btnBusca.disabled) return;             // sem arquivo aberto
  el.barraBusca.hidden = false;
  document.body.classList.add('busca-aberta');
  el.btnBusca.classList.add('ativo');
  el.buscaTermo.focus();
  el.buscaTermo.select();
  if (el.buscaTermo.value) recalcularBusca();
}
function fecharBusca() {
  el.barraBusca.hidden = true;
  document.body.classList.remove('busca-aberta');
  el.btnBusca.classList.remove('ativo');
}
function alternarBusca() { el.barraBusca.hidden ? abrirBusca() : fecharBusca(); }

el.btnBusca.addEventListener('click', alternarBusca);
el.buscaFechar.addEventListener('click', fecharBusca);
el.btnDesfazer.addEventListener('click', desfazer);
el.btnRefazer.addEventListener('click', refazer);

// Ctrl+F abre a barra; Esc (dentro dela) fecha; Ctrl+Z desfaz, Ctrl+Shift+Z/Ctrl+Y refaz.
document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === 'f' && !el.btnBusca.disabled) {
    e.preventDefault();
    abrirBusca();
  } else if (e.key === 'Escape' && !el.barraBusca.hidden) {
    fecharBusca();
  } else if (ctrl && !editandoBusca(e) && (k === 'z' && !e.shiftKey)) {
    e.preventDefault();   // intercepta o undo nativo do contenteditable (que dessincronizaria)
    desfazer();
  } else if (ctrl && !editandoBusca(e) && ((k === 'z' && e.shiftKey) || k === 'y')) {
    e.preventDefault();
    refazer();
  }
});
// Nos campos da busca, deixa o undo nativo do input funcionar.
function editandoBusca(e) { return e.target === el.buscaTermo || e.target === el.buscaSubst; }

// ── Verificação de integridade (DOCX × ICML) ──────────────────
el.btnIntegridade.addEventListener('click', () => { if (!el.btnIntegridade.disabled) el.inputDocx.click(); });
el.inputDocx.addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.doc) return;
  try {
    toast('Comparando com o DOCX…');
    const ab = await file.arrayBuffer();
    const dx = await docx.readDocx(ab, DOMParser);
    state.comparacao = comparar.comparar(dx.blocks, comparar.icmlBlocks(state.doc, state.story));
    inserirTrechosAusentes(state.comparacao);   // parágrafo do Word ausente → tachado no ICML
    aplicarDiffModificados(state.comparacao);    // no parágrafo alterado: verde (add) + tachado (corte)
    state.comparacaoPsrs = new Set(state.comparacao.map(a => a.psr).filter(Boolean));
    render();                 // aplica as marcações nos parágrafos com diferença
    trocarAba('comparacao');  // mostra o painel e a lista
    toast(state.comparacao.length ? `${state.comparacao.length} divergência(s).` : 'Nenhuma divergência de texto.');
  } catch (err) {
    console.error(err);
    toast('Erro ao comparar: ' + err.message);
  }
});

const ROTULO_COMP = { enfase: 'Ênfase', texto: 'Texto', ausente: 'Ausente no InDesign', extra: 'Só no InDesign', tabela: 'Tabela' };
function montarComparacao() {
  const achados = state.comparacao;
  if (achados === null) {   // ainda não comparou
    el.pcContador.hidden = true;
    el.pcResumo.className = 'pa-resumo-comp';
    el.pcResumo.innerHTML = 'Clique em <b>⇄ Comparar DOCX</b> para conferir o texto contra o Word de origem.';
    el.listaComparacao.innerHTML = '';
    return;
  }
  el.pcContador.hidden = !achados.length;
  el.pcContador.textContent = String(achados.length);
  el.pcResumo.className = 'pa-resumo-comp ' + (achados.length ? 'pc-alerta' : 'pc-ok');
  el.pcResumo.textContent = achados.length
    ? `${achados.length} divergência(s) — clique para localizar no texto.`
    : 'Nenhuma divergência de texto — o conteúdo confere. ✓';
  el.listaComparacao.innerHTML = '';
  for (const a of achados) {
    const item = document.createElement('button');
    item.className = 'pc-item tipo-' + a.tipo + (a.psr ? '' : ' sem-alvo');
    const tag = document.createElement('span'); tag.className = 'pc-tag'; tag.textContent = ROTULO_COMP[a.tipo] || a.tipo;
    const msg = document.createElement('div'); msg.className = 'pc-msg'; msg.textContent = a.msg;
    item.append(tag, msg);
    if (a.contexto) { const ctx = document.createElement('div'); ctx.className = 'pc-ctx'; ctx.textContent = '“' + a.contexto + '”'; item.appendChild(ctx); }
    if (a.psr) item.addEventListener('click', () => irParaTitulo(a.psr));
    el.listaComparacao.appendChild(item);
  }
}

// Trechos do Word ausentes no ICML → insere cada um como parágrafo TACHADO
// (StrikeThru, não é textCondition) na posição correspondente do Word. Encadeia
// os que compartilham a mesma âncora para preservar a ordem. Marca o achado com o
// parágrafo inserido (para localizar/destacar).
function inserirTrechosAusentes(achados) {
  const primeiro = () => icml.readParagraphs(state.doc, state.story)[0]?.node || null;
  const porAncora = new Map();   // aposPsr (ou null) → último parágrafo inserido
  for (const a of achados) {
    if (a.tipo !== 'ausente' || !a.textoWord) continue;
    const ancora = porAncora.get(a.aposPsr ?? null) || a.aposPsr;
    // Estilo NEUTRO (não herda o do parágrafo âncora) — não sabemos o estilo certo.
    const opt = { text: a.textoWord, styleSelf: 'ParagraphStyle/$ID/NormalParagraphStyle' };
    let novo;
    if (ancora) novo = icml.insertParagraphAfter(state.doc, state.story, ancora, opt);
    else if (primeiro()) novo = icml.insertParagraphBefore(state.doc, state.story, primeiro(), opt);
    else continue;
    const csr = novo.getElementsByTagName('CharacterStyleRange')[0];
    if (csr) csr.setAttribute('StrikeThru', 'true');
    porAncora.set(a.aposPsr ?? null, novo);
    a.psr = novo;   // achado passa a apontar para o parágrafo inserido
  }
}

// Nos parágrafos ALTERADOS (Word = base): marca de verde o que o ICML adicionou e
// insere tachado o que o ICML cortou (texto do Word ausente), na posição do Word.
function aplicarDiffModificados(achados) {
  for (const a of achados) {
    if (a.tipo !== 'texto' || !a.psr) continue;
    for (const [s, e] of (a.green || [])) icml.markOffsets(a.psr, s, e, 'CompAdd', 'true');   // offset-neutro
    for (const c of [...(a.cuts || [])].sort((x, y) => y.at - x.at))   // direita → esquerda
      icml.insertStruckRun(a.psr, c.at, c.text);
  }
}

// Rola até o parágrafo e SELECIONA o trecho que difere (destaque, sem tocar no ICML).
function irParaTrechoDiferente(psr, start, end) {
  const para = [...el.editor.querySelectorAll('.para')].find(x => x._psr === psr);
  const body = para && para.querySelector('.para-body');
  if (!body) return irParaTitulo(psr);
  selecionarNoCorpo(body, start, end);   // já rola e destaca via seleção nativa
}

// ── Exportação ────────────────────────────────────────────────
el.exportar.addEventListener('click', () => {
  const xml = icml.serializeIcml(state.doc, XMLSerializer);
  const blob = new Blob([xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.fileName;
  a.click();
  URL.revokeObjectURL(url);
  toast('ICML exportado.');
});

// ── Toast ─────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('mostra');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('mostra'), 2200);
}

// ── Verificação de atualização de versão ──────────────────────
// Compara a versão instalada (version.json local, congelado na instalação) com a
// do repositório (version.json na branch main). Se a remota for mais nova, mostra
// um banner com link. Configure URL_VERSAO_REMOTA com o seu repositório GitHub.
const URL_VERSAO_REMOTA = 'https://raw.githubusercontent.com/luizbmc/conferildo/main/version.json';

function compararVersao(a, b) {   // 1 se a>b, -1 se a<b, 0 se igual
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return Math.sign(d); }
  return 0;
}

async function verificarAtualizacao() {
  if (URL_VERSAO_REMOTA.includes('USUARIO/REPO')) return;   // ainda não configurado
  try {
    const local = await (await fetch('version.json', { cache: 'no-store' })).json();
    const remoto = await (await fetch(URL_VERSAO_REMOTA + '?t=' + Date.now(), { cache: 'no-store' })).json();
    if (compararVersao(remoto.version, local.version) > 0) {
      el.bannerAttMsg.textContent = `Nova versão ${remoto.version} disponível (você tem a ${local.version}).`;
      el.bannerAttLink.href = remoto.url || 'https://github.com';
      el.bannerAtt.hidden = false;
    }
  } catch { /* offline ou sem acesso: silencioso */ }
}
el.bannerAttFechar.addEventListener('click', () => { el.bannerAtt.hidden = true; });
verificarAtualizacao();
