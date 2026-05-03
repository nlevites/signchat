import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  session,
  shell,
  systemPreferences,
} from "electron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;

async function ensureMediaPermissions(): Promise<void> {
  if (process.platform !== "darwin") return;
  // Best-effort prompts. We can't request mic + camera before any
  // BrowserWindow exists; just resolve so window creation can proceed,
  // and let the renderer's first getUserMedia trigger the OS dialog.
  try {
    await systemPreferences.askForMediaAccess("camera");
  } catch {
    // ignore
  }
  try {
    await systemPreferences.askForMediaAccess("microphone");
  } catch {
    // ignore
  }
}

function createWindow(): void {
  const preloadPath = resolve(__dirname, "../preload/index.cjs");
  mainWindow = new BrowserWindow({
    width: 720,
    height: 920,
    minWidth: 520,
    minHeight: 720,
    backgroundColor: "#0a0a0a",
    title: "Sign Chat Bridge",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Auto-grant getUserMedia (camera + mic) so the renderer's permission
  // prompt isn't gated behind an Electron-internal "allow" dialog —
  // macOS still gates the actual hardware access via the OS prompt.
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      if (permission === "media") return callback(true);
      callback(false);
    },
  );

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
    if (!app.isPackaged) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    void mainWindow.loadFile(
      resolve(__dirname, "../renderer/index.html"),
    );
  }
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("clipboard:write", (_event, text: string) => {
  if (typeof text === "string") clipboard.writeText(text);
});

/**
 * Inject permissive CORS headers on every HTTP response so the renderer
 * (running off the Vite dev server at localhost:5173 in dev, or
 * file://.../renderer/index.html in prod) can call the Vercel mint
 * endpoints cross-origin.
 *
 * Safe in Electron because the renderer only ever loads our own bundle —
 * no untrusted JS could exploit the loosened CORS. Production Bridge
 * still uses signed/capped credentials, so the API surface is the
 * security boundary, not CORS.
 */
function installCorsBypass(): void {
  const ses = session.defaultSession;
  ses.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders: Record<string, string[]> = {
      ...(details.responseHeaders ?? {}),
    };
    responseHeaders["access-control-allow-origin"] = ["*"];
    responseHeaders["access-control-allow-headers"] = ["*"];
    responseHeaders["access-control-allow-methods"] = [
      "GET, POST, PUT, DELETE, OPTIONS",
    ];
    responseHeaders["access-control-allow-credentials"] = ["true"];

    // Next.js answers OPTIONS preflights with 405; rewrite to 204 so the
    // browser accepts the preflight and proceeds with the real POST.
    if (details.method === "OPTIONS") {
      callback({
        responseHeaders,
        statusLine: "HTTP/1.1 204 No Content",
      });
      return;
    }
    callback({ responseHeaders });
  });
}

void app.whenReady().then(async () => {
  buildMenu();
  installCorsBypass();
  await ensureMediaPermissions();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
