import { app, BrowserWindow, dialog, Menu, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import type { Settings } from '../shared/types';
import { detectClaude } from './claude/detect';
import { resolveLoginPath } from './env';
import { registerIpc, type Services } from './ipc';
import { Store } from './store';

const DEV_URL = process.env.OBSIDIAN_DEV_URL; // set only by scripts/dev.mjs
const isDev = !!DEV_URL && !app.isPackaged;

if (process.env.OBSIDIAN_USER_DATA) app.setPath('userData', process.env.OBSIDIAN_USER_DATA); // used by e2e tests
app.setName('OBSIDIAN');

let win: BrowserWindow | null = null;
let services: Services | null = null;
let quitConfirmed = false;
const store = new Store(app.getPath('userData'));

const rendererIndex = path.join(__dirname, '../renderer/index.html');

function isTrustedSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (!win || e.sender !== win.webContents) return false;
  const url = e.senderFrame?.url ?? '';
  return isDev ? url.startsWith(DEV_URL!) : url.startsWith('file://');
}

function toAccelerator(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.replace(/\bMod\b/g, 'CmdOrCtrl').replace(/\bAlt\b/g, 'Alt');
}

function buildMenu(settings: Settings) {
  const sc = settings.shortcuts;
  const cmd = (label: string, command: string, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => ({
    label,
    accelerator: toAccelerator(sc[command]),
    click: () => win?.webContents.send('menu:command', command),
    ...extra,
  });
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'OBSIDIAN',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              cmd('Settings…', 'view.settings'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'Session',
      submenu: [
        cmd('New Claude Code Session', 'session.newClaude'),
        cmd('New Shell Session', 'session.newShell'),
        cmd('Continue Most Recent Conversation', 'session.continue'),
        cmd('Resume From Claude History…', 'session.picker'),
        { type: 'separator' },
        cmd('Open Project…', 'project.open'),
        cmd('Quick Open File…', 'file.quickOpen'),
        { type: 'separator' },
        cmd('Next Session', 'session.next'),
        cmd('Previous Session', 'session.prev'),
        { type: 'separator' },
        cmd('Close Session', 'session.close'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        cmd('Find in Terminal', 'terminal.find'),
        cmd('Clear Terminal', 'terminal.clear'),
      ],
    },
    {
      label: 'View',
      submenu: [
        cmd('Command Palette…', 'palette.open'),
        { type: 'separator' },
        cmd('Mission Control (Home)', 'view.home'),
        cmd('Toggle Navigator', 'view.toggleLeft'),
        cmd('Toggle Intelligence Panel', 'view.toggleRight'),
        cmd('Toggle Bottom Panel', 'view.toggleBottom'),
        { type: 'separator' },
        cmd('Increase Terminal Font', 'terminal.zoomIn'),
        cmd('Decrease Terminal Font', 'terminal.zoomOut'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[]) : [])] },
    {
      role: 'help',
      submenu: [
        { label: 'Claude Code Documentation', click: () => shell.openExternal('https://code.claude.com/docs') },
        cmd('Show Diagnostics', 'view.diagnostics'),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0f14',
    title: 'OBSIDIAN',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 20, y: 19 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: isDev || !!process.env.OBSIDIAN_DEVTOOLS,
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.on('show', () => win?.webContents.send('menu:command', 'app.visible'));
  win.on('hide', () => win?.webContents.send('menu:command', 'app.hidden'));
  win.on('minimize', () => win?.webContents.send('menu:command', 'app.hidden'));
  win.on('restore', () => win?.webContents.send('menu:command', 'app.visible'));

  // No in-app navigation and no new windows. http(s) links go to the default browser.
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL!) : url.startsWith('file://');
    if (!allowed) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (quitConfirmed || !services) return;
    const running = services.sessions.runningCount();
    if (running === 0) return;
    e.preventDefault();
    void confirmQuit(running);
  });
  win.on('closed', () => {
    win = null;
  });

  if (isDev) void win.loadURL(DEV_URL!);
  else void win.loadFile(rendererIndex);
}

async function confirmQuit(running: number) {
  const res = await dialog.showMessageBox(win!, {
    type: 'warning',
    buttons: [`End ${running} Session${running === 1 ? '' : 's'} and Quit`, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `${running} session${running === 1 ? ' is' : 's are'} still running.`,
    detail: 'Quitting OBSIDIAN ends every process it started. Claude Code conversations are saved by Claude Code and can be resumed later.',
  });
  if (res.response !== 0) return;
  quitConfirmed = true;
  await shutdown();
  app.quit();
}

async function shutdown() {
  if (!services) return;
  services.poller.stop();
  services.watcher.closeAll();
  await services.sessions.killAll();
  store.flush();
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

app.whenReady().then(() => {
  // Deny every permission request (camera, notifications, geolocation, …).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  services = registerIpc({
    store,
    window: () => win,
    isTrustedSender,
    onShortcutsChanged: buildMenu,
  });
  buildMenu(store.get('settings'));
  createWindow();
  // Warm up detection in the background so the first session starts quickly.
  void resolveLoginPath().then(() => detectClaude(store.get('settings').claudePath));
});

app.on('before-quit', (e) => {
  if (quitConfirmed || !services) return;
  const running = services.sessions.runningCount();
  if (running > 0 && win) {
    e.preventDefault();
    void confirmQuit(running);
    return;
  }
  quitConfirmed = true;
  e.preventDefault();
  void shutdown().then(() => app.quit());
});

app.on('window-all-closed', () => app.quit());

process.on('SIGTERM', () => {
  quitConfirmed = true;
  void shutdown().then(() => app.exit(0));
});
