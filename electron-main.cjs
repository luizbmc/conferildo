// Processo principal do Electron. Sobe o servidor interno numa porta livre e abre
// a janela do app apontando para ele — o usuário não precisa iniciar nada.
const { app, BrowserWindow, shell } = require('electron');

let janela;

async function criarJanela() {
  const { startServer } = await import('./server.js');   // ESM a partir do CJS
  const { port } = await startServer({ port: 0 });        // 127.0.0.1:<livre>
  console.log('[Revisor de Provas] servidor interno em http://127.0.0.1:' + port);

  janela = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Conferildo',
    autoHideMenuBar: true,               // sem barra de menu por padrão
    backgroundColor: '#f8fafc',
    webPreferences: { contextIsolation: true },
  });

  await janela.loadURL(`http://127.0.0.1:${port}/index.html`);

  // Links externos (ex.: Google Fonts) abrem no navegador padrão, não numa janela nova.
  janela.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(criarJanela);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) criarJanela();
});

app.on('window-all-closed', () => app.quit());
