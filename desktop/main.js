const {
  app, BrowserWindow, protocol, session, dialog, shell, Menu, screen
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 允许在无 GPU/无显示的服务器环境里做验证（CI/容器），不要影响正常 Windows 用户
if (process.argv.includes('--disable-gpu') || process.env.PROMPTVAULT_HEADLESS) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('in-process-gpu');
}
if (process.argv.includes('--no-sandbox') || process.env.PROMPTVAULT_NO_SANDBOX) {
  app.commandLine.appendSwitch('no-sandbox');
}

// 便携版：electron-builder 的 portable 启动器会设置 PORTABLE_EXECUTABLE_DIR
// 把 userData 放到 exe 同目录的 PromptVaultData/ 下，实现「exe 和数据一起带走」
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
if (portableDir && app.isPackaged) {
  const dataDir = path.join(portableDir, 'PromptVaultData');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', dataDir);
    app.setPath('logs', path.join(dataDir, 'logs'));
  } catch (err) {
    console.error('无法创建便携数据目录，回退到默认位置', err);
  }
}

// 必须在 app.whenReady 之前注册自定义协议
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

const isDev = !app.isPackaged;
const userDataPath = app.getPath('userData');
const stateFile = path.join(userDataPath, 'window-state.json');

// 渲染层根目录：开发时直接指向上一级（网页版源码）；打包后用工程内的 renderer/
const rendererRoot = isDev
  ? path.resolve(__dirname, '..')
  : path.join(__dirname, 'renderer');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
};

let mainWindow = null;

function loadWindowState() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const state = JSON.parse(raw);
    if (state && typeof state === 'object') return state;
  } catch {
    // 首次启动或文件损坏时忽略
  }
  return { width: 1440, height: 900, x: undefined, y: undefined, maximized: false };
}

function saveWindowState() {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const state = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: mainWindow.isMaximized()
  };
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
  } catch (err) {
    console.error('保存窗口状态失败', err);
  }
}

function ensureInDisplayArea(state) {
  const displays = screen.getAllDisplays();
  if (!displays.length) return state;

  // 校验窗口是否至少有一部分在某个显示器工作区内
  const { x, y, width, height } = state;
  const inBounds = displays.some(({ workArea }) => (
    x + width > workArea.x &&
    x < workArea.x + workArea.width &&
    y + height > workArea.y &&
    y < workArea.y + workArea.height
  ));

  if (!inBounds) {
    // 恢复到主显示器居中
    const primary = screen.getPrimaryDisplay();
    const { width: pw, height: ph } = primary.workAreaSize;
    return {
      ...state,
      x: Math.round((pw - Math.min(state.width, pw - 100)) / 2),
      y: Math.round((ph - Math.min(state.height, ph - 100)) / 2),
      maximized: false
    };
  }
  return state;
}

function createWindow() {
  const saved = ensureInDisplayArea(loadWindowState());

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#f5f6f8',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });

  if (saved.maximized) {
    mainWindow.maximize();
  }

  mainWindow.loadURL('app://local/index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools();
  });

  mainWindow.on('close', () => {
    saveWindowState();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 阻止页面内导航离开自定义协议
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://local/')) {
      e.preventDefault();
    }
  });

  // 外链统一用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url && !url.startsWith('app://local/')) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  // 下载时用系统保存对话框（只弹一次）。
  //
  // ⚠️ 这里不能用 dialog.showSaveDialog：它是异步的，在 Promise resolve 之前
  // item 还没有 savePath，Electron 会先自己弹一个默认保存框 —— 用户会看到
  // 两个保存窗口。正确做法是 setSaveDialogOptions，让 Electron 用它自己的
  // 对话框、但采用我们给的默认路径和标题。
  mainWindow.webContents.session.on('will-download', (e, item) => {
    let suggested = (item.getFilename() || '').trim();
    // blob: URL 拿不到文件名时 Chromium 会给个 "download"，用时间戳兜底，
    // 免得连续导出全叫 download、互相覆盖
    if (!suggested || suggested === 'download') {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      suggested = `promptvault-${ts}`;
    }
    item.setSaveDialogOptions({
      title: '保存文件',
      defaultPath: path.join(app.getPath('downloads'), suggested)
    });
  });

  // 渲染进程崩溃或挂起时给出可读提示
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '页面异常',
      message: '渲染进程异常退出',
      detail: `原因：${details.reason}\n退出码：${details.exitCode}\n\n点击“重载”恢复页面。`,
      buttons: ['重载', '关闭应用'],
      defaultId: 0
    }).then(({ response }) => {
      if (response === 0) {
        mainWindow.reload();
      } else {
        app.quit();
      }
    });
  });

  mainWindow.webContents.on('unresponsive', () => {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '页面无响应',
      message: 'PromptVault 长时间未响应',
      detail: '是否等待恢复？',
      buttons: ['等待', '重载', '关闭应用'],
      defaultId: 0
    }).then(({ response }) => {
      if (response === 1) mainWindow.reload();
      if (response === 2) app.quit();
    });
  });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '重新加载',
          accelerator: 'CmdOrCtrl+R',
          visible: isDev,
          click: () => mainWindow && mainWindow.reload()
        },
        {
          label: '强制重新加载',
          accelerator: 'CmdOrCtrl+Shift+R',
          visible: isDev,
          click: () => mainWindow && mainWindow.webContents.reloadIgnoringCache()
        },
        { type: 'separator', visible: isDev },
        {
          label: '开发者工具',
          accelerator: 'F12',
          visible: isDev,
          click: () => mainWindow && mainWindow.webContents.toggleDevTools()
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'Alt+F4',
          click: () => app.quit()
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '放大', role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus' },
        { label: '缩小', role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
        { label: '重置缩放', role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 PromptVault',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于 PromptVault',
              message: 'PromptVault 提示词图库管理台',
              detail: `版本：1.0.0\nElectron：${process.versions.electron}\nChromium：${process.versions.chrome}\nNode：${process.versions.node}`
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 单实例：第二次启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.whenReady().then(() => {
  // 注册自定义协议：把 app://local/ 映射到渲染层目录
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '' || pathname === '/') pathname = '/index.html';

      const targetPath = path.normalize(path.join(rendererRoot, pathname));
      // 路径穿越校验
      if (!targetPath.startsWith(path.normalize(rendererRoot))) {
        return new Response('Forbidden', { status: 403, statusText: 'Forbidden' });
      }

      const data = await fs.promises.readFile(targetPath);
      const ext = path.extname(targetPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      return new Response(data, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': isDev ? 'no-cache' : 'public, max-age=3600'
        }
      });
    } catch (err) {
      if (err.code === 'ENOENT') {
        return new Response('Not Found', { status: 404, statusText: 'Not Found' });
      }
      console.error('协议处理错误', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  });

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(err => {
  console.error('应用启动失败', err);
  app.quit();
});
