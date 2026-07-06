# Revisor de Provas

Editor web de arquivos **ICML** (stories do InDesign/InCopy) para revisão de provas.
O revisor edita o texto, aplica estilos de caractere por **seleção arbitrária** e insere
**notas** — tudo preservando a formatação do designer feita no InDesign.

## Como funciona

O ICML é o formato de story linkável nativo do InDesign (fluxo InCopy). O app carrega o
`.icml`, deixa revisar, e exporta um `.icml` que pode ser recolocado/atualizado no InDesign
pelo painel Links.

O princípio central é a **edição cirúrgica**: o app nunca reconstrói o documento a partir
de um modelo simplificado. Mantém o DOM do ICML como fonte da verdade e muta apenas os nós
tocados. Assim, o cabeçalho (fontes, cores, estilos), o pacote XMP e os overrides locais do
designer (Leading, Tracking, SpaceBefore…) sobrevivem intactos.

Ao aplicar um estilo a uma seleção arbitrária, o `CharacterStyleRange` é dividido no ponto
exato, clonando atributos e `<Properties>` para os novos pedaços — sem perder formatação.

## Uso

### App instalável (recomendado para os revisores)

O app roda como um programa de desktop (Electron), sem precisar iniciar servidor.

```bash
npm install
npm run app        # abre a janela do app (desenvolvimento)
npm run dist       # gera o instalador Windows em dist/ (ex.: "Revisor de Provas Setup x.y.z.exe")
```

O instalador (`npm run dist`) produz um `.exe` que o revisor executa uma vez para instalar;
depois é só abrir "Revisor de Provas" pelo atalho — nada de terminal ou servidor. Por baixo,
o Electron sobe o mesmo `server.js` numa porta local livre (invisível) e abre a janela nele,
então o carregamento de imagens locais (`/local-image`) continua funcionando.

> **Ao gerar o instalador** (`npm run dist`): o `electron-builder` extrai a ferramenta de
> code-sign, que cria *symlinks*. No Windows isso exige o **Modo de Desenvolvedor** ligado
> (Configurações → Privacidade e segurança → Para desenvolvedores → Modo de Desenvolvedor)
> **ou** rodar o comando num terminal **como administrador**. Isso vale só para quem *gera*
> o instalador; o `.exe` resultante instala normalmente para os revisores. O app em si
> (`npm run app`) roda sem essa exigência.

### Modo navegador (desenvolvimento)

```bash
npm run serve      # http://localhost:4000 (server.js: estáticos + /local-image)
```

Abra o navegador, arraste um `.icml` para a janela (ou "Abrir ICML"). Para revisar:

- **Editar texto**: clique no parágrafo e digite.
- **Criar parágrafo**: Enter divide o parágrafo no cursor; o botão "＋ parágrafo"
  (aparece ao passar o mouse) insere um parágrafo em branco abaixo.
- **Excluir/mesclar parágrafo**: o botão "🗑" exclui; Backspace no início do parágrafo
  funde-o com o anterior. O último parágrafo não pode ser excluído.
- **Estilo de caractere**: selecione um trecho e clique no estilo (ex.: *bold*,
  *destaque-sublinhado*). "✕ estilo" remove.
- **Estilo de parágrafo**: use o seletor acima de cada parágrafo.
- **Nota**: posicione o cursor, "＋ Adicionar nota", escreva e insira. Notas existentes
  aparecem como 📝 (passe o mouse para ler).
- **Nota de rodapé** (`<Footnote>`): aparece como um número em superscript (¹²³) na
  posição da referência. Clique para abrir um modal que edita o texto, com botões de
  **itálico** e **sobrescrito** aplicáveis à seleção. Os botões só aparecem se o ICML tiver
  os estilos de caractere correspondentes. O número automático do InDesign (`<?ACE?>`) é
  preservado.
- **Tabela** (`<Table>`): renderizada como grade, com o **texto de cada célula editável**.
  A estrutura (linhas, colunas, mesclas/spans) é apenas reproduzida — não é possível
  adicionar, excluir ou mesclar células.
- **Imagem** (`<Rectangle ContentType="GraphicType">`): exibida a partir do caminho local
  em `LinkResourceURI`. Como o navegador não carrega `file:` de uma página http, o
  `server.js` expõe um endpoint `/local-image` que lê a imagem do disco. Se o arquivo não
  existir, mostra um marcador com o nome. A imagem é só visualização (não editável).
- **Exportar ICML**: baixa o arquivo revisado para recolocar no InDesign.

## Testes

```bash
npm test
```

Os testes provam, sobre um ICML real, que o round-trip não tem perdas, que a edição de
texto altera só o `<Content>`, que a aplicação de estilo por seleção arbitrária divide o
run no ponto exato preservando a formatação vizinha, e que a inserção de nota funciona.

## Estrutura

- `src/icml.js` — núcleo: parse/serialização e operações de edição cirúrgica (agnóstico de
  ambiente; recebe `DOMParser`/`XMLSerializer` por injeção — nativos no navegador,
  `@xmldom/xmldom` nos testes).
- `src/app.js` — a interface do editor (liga a engine ao DOM da página).
- `src/docx.js` — leitura de `.docx` (unzip nativo + parse OOXML) para a verificação de
  integridade.
- `src/comparar.js` — compara o texto do DOCX (base) com o do ICML e produz os achados.
- `index.html`, `src/styles.css` — a casca visual.
- `server.js` — servidor local (estáticos + `/local-image`); exporta `startServer` para o
  Electron e roda em modo dev com `node server.js`.
- `electron-main.cjs` — processo principal do Electron (sobe o servidor interno e abre a
  janela). Empacotado com `electron-builder` (config em `package.json` → `build`).
- `test/*.test.mjs` — testes do núcleo e da comparação.

## Limitações conhecidas (MVP)

- O link com o InDesign é manual (exportar → recolocar). A versão com link vivo no painel
  Links seria o próximo passo (via ICML linkado nativamente ou plugin).
