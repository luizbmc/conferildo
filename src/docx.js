// ── Leitura de DOCX ───────────────────────────────────────────
// Extrai de um .docx (ZIP OOXML) os blocos de conteúdo na ordem do documento:
// parágrafos (com texto e ênfase negrito/itálico por caractere) e tabelas (com o
// texto de cada célula). A ênfase é resolvida tanto da formatação direta (<w:b/>,
// <w:i/>) quanto dos estilos de caractere (<w:rStyle>) definidos em styles.xml.
//
// O unzip usa APIs nativas (DecompressionStream) — sem dependências.

const W = 'w:';   // prefixo do namespace WordprocessingML

// Descomprime um Uint8Array deflate-raw (método 8 do ZIP) para string UTF-8.
async function inflateRaw(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate-raw'));
  return new TextDecoder('utf-8').decode(await new Response(stream).arrayBuffer());
}

// Extrai as entradas `wanted` (nomes) de um ZIP (ArrayBuffer) → { nome: string }.
export async function unzip(arrayBuffer, wanted) {
  const dv = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const dec = new TextDecoder('utf-8');
  // End Of Central Directory
  let i = dv.byteLength - 22;
  while (i >= 0 && dv.getUint32(i, true) !== 0x06054b50) i--;
  if (i < 0) throw new Error('Arquivo .docx inválido (ZIP não reconhecido).');
  const count = dv.getUint16(i + 10, true);
  let p = dv.getUint32(i + 16, true);
  const out = {};
  for (let n = 0; n < count; n++) {
    const method  = dv.getUint16(p + 10, true);
    const csize   = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commLen  = dv.getUint16(p + 32, true);
    const lho      = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (wanted.includes(name)) {
      const lfn = dv.getUint16(lho + 26, true), lex = dv.getUint16(lho + 28, true);
      const ds = lho + 30 + lfn + lex;
      const comp = bytes.subarray(ds, ds + csize);
      out[name] = method === 8 ? await inflateRaw(comp) : dec.decode(comp);
    }
    p += 46 + nameLen + extraLen + commLen;
  }
  return out;
}

// Lê um .docx a partir de um ArrayBuffer → { blocks } (ver parseDocx).
export async function readDocx(arrayBuffer, DOMParser) {
  const files = await unzip(arrayBuffer, ['word/document.xml', 'word/styles.xml']);
  if (!files['word/document.xml']) throw new Error('word/document.xml não encontrado no .docx.');
  return parseDocx(files['word/document.xml'], files['word/styles.xml'] || '', DOMParser);
}

// Filhos elemento por nome qualificado (ex.: "w:p").
function kids(el, tag) {
  const out = [];
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 1 && n.tagName === tag) out.push(n);
  return out;
}
function firstKid(el, tag) { return kids(el, tag)[0] || null; }
// Descendentes por nome (qualquer profundidade).
function desc(el, tag) { return Array.from(el.getElementsByTagName(tag)); }

// <w:b>/<w:i> → boolean (val ausente = true; "0"/"false" = false). undefined se ausente.
function toggle(el) {
  if (!el) return undefined;
  const v = el.getAttribute(W + 'val');
  if (v == null) return true;
  return !(v === '0' || v === 'false' || v === 'off');
}

// Mapa styleId → { bold, italic, basedOn } dos estilos de CARACTERE do styles.xml.
function lerEstilosCaractere(stylesXml, DOMParser) {
  const map = new Map();
  if (!stylesXml) return map;
  const doc = new DOMParser().parseFromString(stylesXml, 'application/xml');
  for (const s of desc(doc.documentElement, W + 'style')) {
    if (s.getAttribute(W + 'type') !== 'character') continue;
    const id = s.getAttribute(W + 'styleId');
    if (!id) continue;
    const rPr = firstKid(s, W + 'rPr');
    const basedOn = firstKid(s, W + 'basedOn');
    map.set(id, {
      bold:   rPr ? toggle(firstKid(rPr, W + 'b')) : undefined,
      italic: rPr ? toggle(firstKid(rPr, W + 'i')) : undefined,
      basedOn: basedOn ? basedOn.getAttribute(W + 'val') : null,
    });
  }
  return map;
}

// Resolve bold/italic de um estilo de caractere seguindo a cadeia basedOn.
function estiloEmphasis(id, estilos, prop, visto = new Set()) {
  if (!id || visto.has(id) || !estilos.has(id)) return undefined;
  visto.add(id);
  const s = estilos.get(id);
  if (s[prop] !== undefined) return s[prop];
  return estiloEmphasis(s.basedOn, estilos, prop, visto);
}

// Ênfase efetiva de um run: estilo de caractere (rStyle) sobreposto pela formatação
// direta (rPr). NÃO resolve o estilo de PARÁGRAFO — ênfase de parágrafo inteiro
// (título/assinatura) não é intra-parágrafo e não deve ser tratada como destaque.
function runEmphasis(rPr, estilos) {
  let bold = false, italic = false;
  if (rPr) {
    const rStyle = firstKid(rPr, W + 'rStyle');
    if (rStyle) {
      const id = rStyle.getAttribute(W + 'val');
      bold   = !!estiloEmphasis(id, estilos, 'bold');
      italic = !!estiloEmphasis(id, estilos, 'italic');
    }
    const b = toggle(firstKid(rPr, W + 'b'));
    const it = toggle(firstKid(rPr, W + 'i'));
    if (b !== undefined) bold = b;
    if (it !== undefined) italic = it;
  }
  return { bold, italic };
}

// Texto de um <w:r>: junta os <w:t> (preserva espaços) e trata <w:tab/>/<w:br/>.
function textoDoRun(r) {
  let s = '';
  for (const n of Array.from(r.childNodes)) {
    if (n.nodeType !== 1) continue;
    if (n.tagName === W + 't') s += n.textContent;
    else if (n.tagName === W + 'tab') s += '\t';
    else if (n.tagName === W + 'br' || n.tagName === W + 'cr') s += '\n';
  }
  return s;
}

// Um <w:p> → { type:'para', text, chars:[{c,bold,italic}], hasImage }.
// Usa os runs DESCENDENTES (em ordem do documento) para incluir o texto dentro de
// <w:hyperlink> (o texto visível de um link) e de outros invólucros inline.
function parseParagrafo(pEl, estilos) {
  const chars = [];
  let hasImage = false;
  for (const r of desc(pEl, W + 'r')) {
    if (desc(r, W + 'drawing').length || desc(r, W + 'pict').length || desc(r, W + 'object').length) hasImage = true;
    const emp = runEmphasis(firstKid(r, W + 'rPr'), estilos);
    const t = textoDoRun(r);
    for (const c of t) chars.push({ c, bold: emp.bold, italic: emp.italic });
  }
  return { type: 'para', text: chars.map(x => x.c).join(''), chars, hasImage };
}

// Um <w:tbl> → { type:'table', rows:[[textoCelula,...],...], nCells }.
function parseTabela(tblEl, estilos) {
  const rows = [];
  let nCells = 0;
  for (const tr of kids(tblEl, W + 'tr')) {
    const row = [];
    for (const tc of kids(tr, W + 'tc')) {
      const txt = kids(tc, W + 'p').map(p => parseParagrafo(p, estilos).text).join('\n');
      row.push(txt);
      nCells++;
    }
    rows.push(row);
  }
  return { type: 'table', rows, nCells };
}

// Parseia document.xml + styles.xml → { blocks: [...] } na ordem do corpo.
export function parseDocx(docXml, stylesXml, DOMParser) {
  const estilos = lerEstilosCaractere(stylesXml, DOMParser);
  const doc = new DOMParser().parseFromString(docXml, 'application/xml');
  const body = firstKid(doc.documentElement, W + 'body') || doc.documentElement;
  const blocks = [];
  for (const n of Array.from(body.childNodes)) {
    if (n.nodeType !== 1) continue;
    if (n.tagName === W + 'p')   blocks.push(parseParagrafo(n, estilos));
    else if (n.tagName === W + 'tbl') blocks.push(parseTabela(n, estilos));
  }
  return { blocks };
}
