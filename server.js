// Servidor local do app: serve os arquivos estáticos E um endpoint /local-image
// que lê imagens do disco (as imagens referenciadas pelo ICML ficam fora da pasta
// do app, e o navegador não carrega file: de uma página http).
//
// Usado de dois jeitos:
//  • `node server.js [porta]`     → modo desenvolvimento (abre no navegador)
//  • import { startServer }       → dentro do Electron (porta efêmera, invisível)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.icml': 'application/xml', '.xml': 'application/xml', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};
const IMG = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.tif', '.tiff']);

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');

  // Imagem local: /local-image?path=C:/Users/.../img.png (só extensões de imagem)
  if (url.pathname === '/local-image') {
    const p = url.searchParams.get('path') || '';
    if (!IMG.has(extname(p).toLowerCase())) { res.statusCode = 400; return res.end('bad type'); }
    try {
      const buf = await readFile(p);
      res.setHeader('Content-Type', MIME[extname(p).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      return res.end(buf);
    } catch { res.statusCode = 404; return res.end('not found'); }
  }

  // Estáticos do app
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) { res.statusCode = 403; return res.end('forbidden'); }
  try {
    const buf = await readFile(filePath);
    res.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(buf);
  } catch { res.statusCode = 404; res.end('not found'); }
}

// Sobe o servidor em 127.0.0.1. `port: 0` escolhe uma porta livre (usado no Electron).
// Resolve com { server, port } (a porta real atribuída).
export function startServer({ port = 0 } = {}) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Execução direta (`node server.js [porta]`) → modo desenvolvimento.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const porta = Number(process.argv[2]) || Number(process.env.PORT) || 4000;
  startServer({ port: porta }).then(({ port }) =>
    console.log(`Revisor de Provas em http://localhost:${port}`));
}
