// ── Leitura de IDML ───────────────────────────────────────────
// O IDML é um ZIP com o documento inteiro do InDesign. As stories (Stories/*.xml)
// têm a mesma estrutura de parágrafos/CSRs do ICML e os estilos ficam à parte
// (Resources/Styles.xml, cores em Resources/Graphic.xml, conditions no
// designmap.xml). Aqui montamos, em memória, um ICML equivalente à story PRINCIPAL
// (a de mais texto — o miolo), para o editor e a comparação usarem sem mudança.
//
// Só serve para revisar/comparar: o ICML montado não é exportado (o InDesign
// precisa do ICML exportado por ele para atualizar o vínculo).

import { unzip } from './docx.js';

const textoDe = xml => (xml.match(/<Content>[^<]*<\/Content>/g) || []).reduce((n, c) => n + c.length - 19, 0);

// Conteúdo de dentro do invólucro <idPkg:X …>…</idPkg:X> de uma parte do IDML.
function miolo(xml, tag) {
  if (!xml) return '';
  const ini = xml.indexOf('<idPkg:' + tag);
  const fim = xml.lastIndexOf('</idPkg:' + tag + '>');
  if (ini < 0 || fim < 0) return '';
  return xml.slice(xml.indexOf('>', ini) + 1, fim);
}

/**
 * IDML (ArrayBuffer) → { xml, storyId, caracteres, outras } — `xml` é um ICML com os
 * estilos, cores, conditions e a story principal; `outras` = nº de stories ignoradas.
 */
export async function idmlParaIcml(arrayBuffer) {
  const partes = await unzip(arrayBuffer, n =>
    n === 'designmap.xml' || n === 'Resources/Styles.xml' || n === 'Resources/Graphic.xml' ||
    (n.startsWith('Stories/') && n.endsWith('.xml')));
  const stories = Object.keys(partes).filter(n => n.startsWith('Stories/'));
  if (!partes['designmap.xml'] || !stories.length) throw new Error('Arquivo .idml inválido (sem designmap ou stories).');

  let principal = null, maior = -1;
  for (const n of stories) {
    const t = textoDe(partes[n]);
    if (t > maior) { maior = t; principal = n; }
  }
  const story = miolo(partes[principal], 'Story');
  const versao = (partes['designmap.xml'].match(/DOMVersion="([^"]+)"/) || [])[1] || '';
  const conditions = (partes['designmap.xml'].match(/<Condition\s[^>]*?(?:\/>|>[\s\S]*?<\/Condition>)/g) || []).join('\n');

  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<?aid style="50" type="snippet" readerVersion="6.0" featureSet="257"?>\n' +
    '<?aid SnippetType="InCopyInterchange"?>\n' +
    `<Document DOMVersion="${versao}" Self="d">\n` +
    miolo(partes['Resources/Graphic.xml'], 'Graphic') + '\n' +
    conditions + '\n' +
    miolo(partes['Resources/Styles.xml'], 'Styles') + '\n' +
    story + '\n</Document>\n';
  const storyId = (story.match(/<Story\s[^>]*Self="([^"]+)"/) || [])[1] || principal;
  return { xml, storyId, caracteres: maior, outras: stories.length - 1 };
}
