#!/usr/bin/env node
// Automatiza um release do Conferildo:
//   1. sobe a versão em package.json e version.json
//   2. commita e cria a tag vX.Y.Z, envia (git push --follow-tags)
//   3. gera o instalador (npm run dist)  [pule com --skip-build]
//   4. cria o Release no GitHub e anexa o .exe
//
// Uso:
//   node release.mjs <versao|patch|minor|major> [--notes "texto"] [--skip-build]
// Exemplos:
//   node release.mjs 0.2.0
//   node release.mjs minor --notes "Corrige comparação de tabelas."
//   node release.mjs 0.2.1 --skip-build     (usa um .exe já gerado)
//
// O token do GitHub é lido do Git Credential Manager (o mesmo dos seus pushes).
// Precisa de Node 18+ (usa fetch nativo). O passo 3 exige terminal como
// administrador ou Modo de Desenvolvedor ligado (limitação do electron-builder).

import { execSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const p = (rel) => `${ROOT}${rel}`;

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}
function die(msg) { console.error('\n✖ ' + msg); process.exit(1); }

// ---- argumentos -----------------------------------------------------------
const argv = process.argv.slice(2);
const skipBuild = argv.includes('--skip-build');
const notesIdx = argv.indexOf('--notes');
const notesArg = notesIdx >= 0 ? argv[notesIdx + 1] : null;
const bumpArg = argv.find((a) => !a.startsWith('--') && a !== notesArg);
if (!bumpArg) die('informe a versão (ex.: 0.2.0) ou patch|minor|major');

// ---- versão --------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(p('package.json'), 'utf8'));
const cur = pkg.version.split('.').map(Number);
let next;
if (['patch', 'minor', 'major'].includes(bumpArg)) {
  if (bumpArg === 'major') { cur[0]++; cur[1] = 0; cur[2] = 0; }
  else if (bumpArg === 'minor') { cur[1]++; cur[2] = 0; }
  else { cur[2]++; }
  next = cur.join('.');
} else if (/^\d+\.\d+\.\d+$/.test(bumpArg)) {
  next = bumpArg;
} else {
  die(`versão inválida: "${bumpArg}" (use X.Y.Z ou patch|minor|major)`);
}
const tag = `v${next}`;
const notes = notesArg || `Versão ${next} do Conferildo.`;
console.log(`→ ${pkg.version}  ⇒  ${next}   (tag ${tag})`);

// ---- owner/repo a partir do remoto ---------------------------------------
const remote = sh('git remote get-url origin');
const rm = remote.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
if (!rm) die('não consegui extrair owner/repo de: ' + remote);
const [, owner, repo] = rm;

// ---- 1+2: bump, commit, tag, push ----------------------------------------
if (pkg.version !== next) {
  pkg.version = next;
  fs.writeFileSync(p('package.json'), JSON.stringify(pkg, null, 2) + '\n');

  const vjPath = p('version.json');
  const vj = JSON.parse(fs.readFileSync(vjPath, 'utf8'));
  vj.version = next;
  vj.notas = notes;
  fs.writeFileSync(vjPath, JSON.stringify(vj, null, 2) + '\n');

  sh('git add package.json version.json');
  sh(`git commit -m "${tag}"`);
  console.log('✓ commit ' + tag);
} else {
  console.log('• package.json já está em ' + next + ' — pulando bump/commit');
}

if (!sh(`git tag -l ${tag}`)) {
  sh(`git tag -a ${tag} -m "Conferildo ${next}"`);
  console.log('✓ tag local ' + tag);
}
sh('git push --follow-tags', { stdio: 'inherit' });
console.log('✓ push (commits + tag)');

// ---- 3: build ------------------------------------------------------------
const exe = p(`dist/${pkg.build.productName} Setup ${next}.exe`);
if (!skipBuild) {
  console.log('→ gerando instalador (npm run dist)…');
  try {
    sh('npm run dist', { stdio: 'inherit' });
  } catch {
    die('npm run dist falhou. Rode este script num terminal como ADMINISTRADOR '
      + '(ou ligue o Modo de Desenvolvedor). Se já tem o .exe, use --skip-build.');
  }
}
if (!fs.existsSync(exe)) die(`instalador não encontrado: ${exe}`);
console.log('✓ instalador: ' + exe);

// ---- token ---------------------------------------------------------------
const cred = sh('git credential fill', { input: 'protocol=https\nhost=github.com\n\n' });
const token = (cred.split('\n').find((l) => l.startsWith('password=')) || '').slice('password='.length).trim();
if (!token) die('token não encontrado no Git Credential Manager');

const api = `https://api.github.com/repos/${owner}/${repo}`;
const H = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'conferildo-release' };

// ---- 4: cria (ou reaproveita) o release ----------------------------------
let rel;
let res = await fetch(`${api}/releases`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({ tag_name: tag, name: `Conferildo ${next}`, body: notes, draft: false, prerelease: false }),
});
if (res.status === 201) {
  rel = await res.json();
  console.log('✓ release criado: ' + rel.html_url);
} else if (res.status === 422) {
  // já existe — reaproveita
  res = await fetch(`${api}/releases/tags/${tag}`, { headers: H });
  if (!res.ok) die('release já existe mas não consegui obtê-lo: HTTP ' + res.status);
  rel = await res.json();
  console.log('• release já existia, reaproveitando: ' + rel.html_url);
} else {
  die('falha ao criar release: HTTP ' + res.status + ' ' + (await res.text()));
}

// ---- upload do asset (substitui se já houver com o mesmo nome) ------------
const assetName = `Conferildo-Setup-${next}.exe`;
const existing = (rel.assets || []).find((a) => a.name === assetName);
if (existing) {
  await fetch(`${api}/releases/assets/${existing.id}`, { method: 'DELETE', headers: H });
  console.log('• asset anterior de mesmo nome removido');
}
const uploadBase = rel.upload_url.split('{')[0];
console.log(`→ enviando ${assetName} (${(fs.statSync(exe).size / 1048576).toFixed(1)} MB)…`);
res = await fetch(`${uploadBase}?name=${assetName}`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/octet-stream' },
  body: fs.readFileSync(exe),
});
if (!res.ok) die('falha no upload do asset: HTTP ' + res.status + ' ' + (await res.text()));
const asset = await res.json();

console.log(`\n✅ Release ${tag} publicado.`);
console.log('   Página:   ' + rel.html_url);
console.log('   Download: ' + asset.browser_download_url);
