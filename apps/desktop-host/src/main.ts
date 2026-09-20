/*
 * Copyright (c) Samir Sarkic and Simon Roth
 *
 * This file is part of RiaCore.
 *
 * RiaCore is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell } from 'electron';
import * as path from 'node:path';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { installNavigationGuard, type GuardedWebContents } from './navigation-guard.js';
import { UtilityProcessManager } from './utility-process-manager.js';
import { registerIpcRelay } from './ipc-relay.js';
import { createGraphCoreWindowManager } from './graph-core-window.js';
import { registerWindowChannels } from './window-channels.js';
import { InvalidationBus } from './invalidation-bus.js';
import { SpawnManager } from './spawn-manager.js';
import { ensureAppLogsDirectory, getAppLogger } from './app-logger.js';
import { getAppConfig } from './app-config.js';
import { getRecentWorkspaces, addRecentWorkspace } from './recent-workspaces.js';
// Deep import: pulling in `@riacore/app-core` from the barrel would
// transitively load the native DB module (a native module whose ABI segfaults under
// Electron's modified Node runtime — the entire reason for the
// utility-process worker). The settings store has no native deps, so a
// direct path-import keeps the main process free of the native bindings.
import { LlmSettingsStore } from '@riacore/app-core/dist/llm/llm-settings-store.js';
import { CrossNsLinkSettingsStore } from '@riacore/app-core/dist/settings/cross-ns-link-settings-store.js';
import { ExportSettingsStore } from '@riacore/app-core/dist/settings/export-settings-store.js';
// Pure path helpers, no native deps — safe to load in the main process.
import { toWorkspaceRelative } from '@riacore/importer-sdk';
import {
  buildSplashCss,
  loadStartupTheme,
  saveStartupTheme,
  setStartupThemeLogger,
  type StartupTheme,
} from './startup-theme.js';
import type { RendererLogEntry } from '@riacore/app-contracts';

// Set the app name before anything calls app.getPath('userData') so that
// userData resolves to %APPDATA%/RiaCore in both dev and packaged builds.
// Without this, dev mode uses %APPDATA%/Electron and recent-workspaces.json
// lands in a different directory than the one the menu reads from.
app.setName('RiaCore');

/** Exported so the shutdown handler (Task 6.2) can access it. */
export let manager: UtilityProcessManager;

/**
 * File-backed store for LLM settings and the encrypted Bedrock credential
 * blob. Constructed in the Electron main process because it depends on
 * `Electron.safeStorage` (encrypt/decrypt) and `app.getPath('userData')`
 * (storage location) — both of which are unavailable in the worker /
 * sidecar Node child process.
 *
 * Exported so the future LLM IPC bridge (Task 6.14) can route encrypted
 * settings through to the worker without exposing `safeStorage` itself.
 *
 * Requirement 11.2, Requirement 12.4.
 */
export let llmSettingsStore: LlmSettingsStore;

/**
 * File-backed store for the cross-namespace-link preference (what the
 * Imported Requirement picker does when a match's namespace isn't connected
 * yet). Constructed in the main process because it depends on
 * `app.getPath('userData')`, unavailable in the worker / sidecar Node child
 * process — same placement rationale as `llmSettingsStore`, minus the
 * `safeStorage` dependency (this store holds no secrets).
 */
export let crossNsLinkSettingsStore: CrossNsLinkSettingsStore;

/**
 * File-backed store for the report-export preferences (currently whether the
 * semi-quantitative risk-rating values are written into exported reports).
 * Main-process resident for the same reason as `crossNsLinkSettingsStore`:
 * it needs `app.getPath('userData')`.
 */
export let exportSettingsStore: ExportSettingsStore;

/** Build the "Open Recent" submenu items from the persisted list. */
function buildRecentSubmenu(): Electron.MenuItemConstructorOptions[] {
  const recents = getRecentWorkspaces();
  if (recents.length === 0) {
    return [{ label: 'No Recent Workspaces', enabled: false }];
  }
  return recents.map((workingDir): Electron.MenuItemConstructorOptions => ({
    label: workingDir,
    click: (_item, focusedWindow) => {
      (focusedWindow as BrowserWindow | undefined)?.webContents.send(
        'menu.fileAction',
        `open-recent:${workingDir}`,
      );
    },
  }));
}

/**
 * Files `shell.openPath` may hand to the OS. `shell.openPath` executes whatever
 * the shell association says, so an unrestricted path is an "execute arbitrary
 * program" primitive for anything that reaches the bridge. The renderer only
 * ever opens logs and exported reports, so allow those and directories.
 */
const OPENABLE_EXTENSIONS = new Set([
  '.log', '.txt', '.md', '.rst', '.json', '.yaml', '.yml',
  '.csv', '.xlsx', '.pdf', '.html',
]);

function attachNativeEditContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const hasSelection = params.selectionText.trim().length > 0;
    const template: Electron.MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' },
        ]
      : hasSelection
        ? [
            { role: 'copy' },
            { type: 'separator' },
            { role: 'selectAll' },
          ]
        : [];

    if (template.length === 0) return;

    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

async function bootstrap(): Promise<void> {
  // Disable WPAD proxy auto-discovery — on corporate Windows networks this
  // causes a ~20 second timeout on the first network request from the renderer.
  // The renderer only connects to localhost (Vite dev server) or loads local
  // files, so proxy resolution is never needed.
  app.commandLine.appendSwitch('no-proxy-server');

  // Dev-only: expose the renderer's CDP port so Playwright can attach to the
  // running app for UI verification (see qualification/ui_tests/test_setup.md).
  // Never enabled in packaged builds.
  if (!app.isPackaged && process.env.RIA_CDP_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.RIA_CDP_PORT);
  }

  // Single-instance lock — prevents a second RIA process from opening the same
  // KuzuDB workspace concurrently, which would cause DB corruption and ria-data
  // write races (see docs/particular/MultiInstanceHandling.md).
  // When a second launch is attempted, Electron forwards its argv here and the
  // second process exits immediately.
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
    return;
  }
  app.on('second-instance', (_event, _argv, _workingDirectory) => {
    // A second RIA launch was attempted. Focus and restore the existing window.
    // The second process has already been told to quit by Electron.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    getAppLogger().info('Second RIA instance launch rejected; focused existing window');
  });

  await app.whenReady();

  // --- About panel & application menu ---
  // In dev, icons are relative to dist/. In packaged builds, the icon is
  // bundled alongside the app via prepare-package.
  const aboutIconPath = app.isPackaged
    ? path.join(app.getAppPath(), 'build', 'icons', 'png', '48x48.png')
    : path.join(__dirname, '../build/icons/png/48x48.png');

  // In dev, app.getVersion() returns the Electron version because there is no
  // packaged package.json. Read the monorepo root package.json instead.
  const rootPkgPath = app.isPackaged
    ? path.join(app.getAppPath(), 'package.json')
    : path.join(__dirname, '../../..', 'package.json');
  const appVersion: string = JSON.parse(readFileSync(rootPkgPath, 'utf8')).version;

  app.setAboutPanelOptions({
    applicationName: 'RiaCore',
    applicationVersion: appVersion,
    copyright: '© 2026 RiaCore',
    iconPath: aboutIconPath,
  });

  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Workspace…',
          accelerator: 'CmdOrCtrl+O',
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu.fileAction', 'open-workspace');
          },
        },
        {
          label: 'Open Recent',
          id: 'file-open-recent',
          submenu: buildRecentSubmenu(),
        },
        {
          label: 'Create Workspace…',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu.fileAction', 'create-workspace');
          },
        },
        {
          label: 'Close Workspace',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu.fileAction', 'close-workspace');
          },
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu.fileAction', 'save');
          },
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu.fileAction', 'open-settings');
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Git',
      submenu: [
        {
          label: 'Commit…',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu.gitAction', 'commit');
          },
        },
        { type: 'separator' },
        {
          label: 'Namespace-Diff…',
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu.gitAction', 'namespace-diff');
          },
        },
      ],
    },
    {
      label: 'Report',
      submenu: [
        {
          id: 'report-export-sphinx-needs',
          label: 'Export Safety Report (.rst)',
          enabled: false,
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send(
              'menu.reportAction', 'export-sphinx-needs'
            );
          },
        },
        {
          id: 'report-export-xlsx',
          label: 'Export Safety Report (.xlsx)',
          enabled: false,
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send(
              'menu.reportAction', 'export-xlsx'
            );
          },
        },
        {
          id: 'report-show-status-cards',
          label: 'Show Status Cards',
          enabled: false,
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send(
              'menu.reportAction', 'show-status-cards'
            );
          },
        },
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
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          id: 'edit-add-malfunction',
          label: 'Add Malfunction',
          accelerator: 'CmdOrCtrl+N',
          enabled: false,
          click: () => { BrowserWindow.getFocusedWindow()?.webContents.send('menu.addMalfunction'); },
        },
        {
          id: 'edit-delete-malfunction',
          label: 'Delete Malfunction',
          accelerator: 'CmdOrCtrl+Delete',
          enabled: false,
          click: () => { BrowserWindow.getFocusedWindow()?.webContents.send('menu.deleteMalfunction'); },
        },
        { type: 'separator' },
        {
          id: 'edit-show-in-tree',
          label: 'Show in Tree',
          accelerator: 'CmdOrCtrl+T',
          enabled: false,
          click: () => { BrowserWindow.getFocusedWindow()?.webContents.send('menu.showInTree'); },
        },
        {
          id: 'edit-show-reference-in-tree',
          label: 'Show Reference in Tree',
          accelerator: 'CmdOrCtrl+Shift+T',
          enabled: false,
          click: () => { BrowserWindow.getFocusedWindow()?.webContents.send('menu.showReferenceInTree'); },
        },
        { type: 'separator' },
        {
          id: 'edit-copy-malfunction',
          label: 'Copy Malfunction',
          accelerator: 'CmdOrCtrl+D',
          enabled: false,
          click: () => { BrowserWindow.getFocusedWindow()?.webContents.send('menu.copyMalfunction'); },
        },
        {
          id: 'edit-paste-malfunction',
          label: 'Paste Malfunction',
          accelerator: 'CmdOrCtrl+Shift+D',
          enabled: false,
          click: () => { BrowserWindow.getFocusedWindow()?.webContents.send('menu.pasteMalfunction'); },
        },
        { type: 'separator' },
        {
          id: 'edit-import-all',
          label: 'Run All Imports',
          click: () => { BrowserWindow.getFocusedWindow()?.webContents.send('menu.importAll'); },
        },
        { type: 'separator' },
        {
          id: 'propagation-start',
          label: 'Start Propagation',
          accelerator: 'CmdOrCtrl+P',
          enabled: false,
          click: () => { BrowserWindow.getFocusedWindow()?.webContents.send('menu.startPropagation'); },
        },
        {
          id: 'propagation-end',
          label: 'End Propagation to',
          accelerator: 'CmdOrCtrl+Shift+P',
          enabled: false,
          click: () => { BrowserWindow.getFocusedWindow()?.webContents.send('menu.endPropagation'); },
        },
        {
          id: 'propagation-cancel',
          label: 'Cancel Propagation',
          enabled: false,
          click: () => { BrowserWindow.getFocusedWindow()?.webContents.send('menu.cancelPropagation'); },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Graph-Core',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => {
            graphCoreWindowManager.openOrFocus();
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        // `role: 'close'` keeps its native CmdOrCtrl+W accelerator. This no
        // longer collides with File → Close Workspace, which now uses
        // CmdOrCtrl+Shift+W.
        { role: 'close' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'App Logs',
          click: () => {
            const logsPath = ensureAppLogsDirectory();
            shell.openPath(logsPath);
          },
        },
        { type: 'separator' },
        {
          label: 'About RiaCore',
          click: (_item, focusedWindow) => {
            (focusedWindow as BrowserWindow | undefined)?.webContents.send('menu.helpAction', 'about');
          },
        },
      ],
    },
  ];

  const appMenu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(appMenu);

  // Update propagation menu item states from the renderer
  ipcMain.on('menu.propagationState', (_event, state: {
    malfunctionSelected: boolean;
    propagationStarted: boolean;
    propagationEndAvailable: boolean;
  }) => {
    const menu = Menu.getApplicationMenu();
    const startItem  = menu?.getMenuItemById('propagation-start');
    const endItem    = menu?.getMenuItemById('propagation-end');
    const cancelItem = menu?.getMenuItemById('propagation-cancel');
    if (startItem)  startItem.enabled  = state.malfunctionSelected && !state.propagationStarted;
    if (endItem)    endItem.enabled    = state.propagationEndAvailable;
    if (cancelItem) cancelItem.enabled = state.propagationStarted;
  });

  // Enable/disable Copy/Paste Malfunction based on renderer selection and clipboard state.
  ipcMain.on('menu.malfunctionClipboardState', (_event, state: {
    canCopy: boolean;
    canPaste: boolean;
  }) => {
    const menu = Menu.getApplicationMenu();
    const copyItem  = menu?.getMenuItemById('edit-copy-malfunction');
    const pasteItem = menu?.getMenuItemById('edit-paste-malfunction');
    if (copyItem)  copyItem.enabled  = state.canCopy;
    if (pasteItem) pasteItem.enabled = state.canPaste;
  });

  // Enable/disable Show in Tree menu items based on renderer selection state.
  ipcMain.on('menu.showInTreeState', (_event, state: {
    showInTreeAvailable: boolean;
    showReferenceInTreeAvailable: boolean;
  }) => {
    const menu = Menu.getApplicationMenu();
    const showInTreeItem = menu?.getMenuItemById('edit-show-in-tree');
    const showRefItem = menu?.getMenuItemById('edit-show-reference-in-tree');
    if (showInTreeItem) showInTreeItem.enabled = state.showInTreeAvailable;
    if (showRefItem) showRefItem.enabled = state.showReferenceInTreeAvailable;
  });

  // Enable/disable the Add Malfunction menu item based on whether an
  // architecture node (which can host malfunctions) is selected in the tree.
  ipcMain.on('menu.addMalfunctionState', (_event, state: { canAddMalfunction: boolean }) => {
    const menu = Menu.getApplicationMenu();
    const addMalfunctionItem = menu?.getMenuItemById('edit-add-malfunction');
    if (addMalfunctionItem) addMalfunctionItem.enabled = state.canAddMalfunction;
  });

  // Enable/disable the Delete Malfunction menu item based on whether a
  // malfunction node is currently selected in the tree.
  ipcMain.on('menu.deleteMalfunctionState', (_event, state: { canDeleteMalfunction: boolean }) => {
    const menu = Menu.getApplicationMenu();
    const deleteMalfunctionItem = menu?.getMenuItemById('edit-delete-malfunction');
    if (deleteMalfunctionItem) deleteMalfunctionItem.enabled = state.canDeleteMalfunction;
  });

  // Enable/disable the Report menu items based on whether
  // a Safety_Namespace is active in the renderer.
  ipcMain.on('menu.safetyNamespaceState', (_event, state: { active: boolean }) => {
    const menu = Menu.getApplicationMenu();
    const sphinxItem = menu?.getMenuItemById('report-export-sphinx-needs');
    const xlsxItem   = menu?.getMenuItemById('report-export-xlsx');
    const cardsItem  = menu?.getMenuItemById('report-show-status-cards');
    if (sphinxItem) sphinxItem.enabled = state.active;
    if (xlsxItem)   xlsxItem.enabled   = state.active;
    if (cardsItem)  cardsItem.enabled  = state.active;
  });

  // Recent workspaces — get list
  ipcMain.handle('workspace.getRecent', () => getRecentWorkspaces());

  // Recent workspaces — record a newly opened workspace and rebuild the submenu.
  // MenuItem.submenu is read-only after the menu is built, so we must replace
  // the entire application menu to reflect the updated recent-workspaces list.
  ipcMain.handle('workspace.addRecent', (_event, workingDir: string) => {
    const updated = addRecentWorkspace(workingDir);
    // Patch the template in-place: find the Open Recent item and swap its submenu,
    // then rebuild the whole menu from the updated template.
    const recentEntry = menuTemplate
      .find((m) => m.label === 'File')
      ?.submenu as Electron.MenuItemConstructorOptions[] | undefined;
    const recentItem = recentEntry?.find((m) => m.id === 'file-open-recent');
    if (recentItem) {
      recentItem.submenu = buildRecentSubmenu();
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
    return updated;
  });

  const logger = getAppLogger();
  setStartupThemeLogger(logger);
  logger.info('Application bootstrap started', {
    isPackaged: app.isPackaged,
    pid: process.pid,
  });

  // Must be registered before any BrowserWindow is constructed so that every
  // webContents in the app is covered from creation. Without it a link click in
  // (for example) LLM review output navigates the window to a remote origin that
  // then inherits the whole `window.riacore` preload bridge.
  installNavigationGuard({
    onWebContentsCreated: (handler) => {
      app.on('web-contents-created', (_event, contents) => handler(contents as unknown as GuardedWebContents));
    },
    openExternal: (url) => shell.openExternal(url),
    logger,
    scope: {
      rendererRoot: path.resolve(__dirname, '..', 'renderer'),
      devServerUrl: process.env.VITE_DEV_SERVER_URL,
    },
  });

  // Construct the LLM settings store. Lives in the main process because
  // `Electron.safeStorage` and `app.getPath('userData')` are only
  // available here — the worker / sidecar Node child cannot encrypt or
  // decrypt the credential blob itself. The store is exported as a
  // module-level binding so the upcoming LLM IPC bridge (Task 6.14) can
  // route encrypted settings to the worker without leaking
  // `safeStorage` across process boundaries.
  // Requirement 11.2, Requirement 12.4.
  llmSettingsStore = new LlmSettingsStore({
    safeStorage,
    userDataDir: () => app.getPath('userData'),
  });
  crossNsLinkSettingsStore = new CrossNsLinkSettingsStore({
    userDataDir: () => app.getPath('userData'),
  });
  exportSettingsStore = new ExportSettingsStore({
    userDataDir: () => app.getPath('userData'),
  });

  // Spawn the utility process and wait for the "ready" handshake.
  // Requirements: 1.1, 1.2
  manager = new UtilityProcessManager({ appVersion });
  await manager.start();
  logger.info('Utility process manager started');

  // Register IPC relay — delegates every channel to the utility process.
  // llm.getSettings and llm.saveSettings are handled in main (require safeStorage).
  // Requirement: 1.3, 11.2, 12.4
  registerIpcRelay(manager, llmSettingsStore, crossNsLinkSettingsStore, exportSettingsStore);

  // Wire load-progress push events from the worker to all renderer windows.
  // Requirements: 16.3, 16.4
  manager.onLoadProgress((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('persistor.loadProgress', event);
    }
  });

  // Wire LLM stream push events from the worker to all renderer windows.
  // The worker pushes `WorkerLlmStream` messages via `process.send()`;
  // the manager forwards them here so we can relay to the renderer over
  // the one-way `llm.stream` channel.
  // Requirements: 8.3, 11.2
  manager.onLlmStream((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('llm.stream', event);
    }
  });

  // Pick an initial window background that matches the OS theme to avoid
  // a white flash on dark-mode systems before the renderer paints. We hold
  // the window hidden until the renderer has finished loading and only then
  // call show().
  //
  // Setting themeSource = 'system' makes Electron actively track the OS theme
  // from window creation onward, so the native (Windows) title bar is painted
  // dark from the first frame instead of flashing light first. See
  // https://github.com/electron/electron/issues/23479
  nativeTheme.themeSource = 'system';

  // Load the persisted startup-theme snapshot. On the first launch this falls
  // back to the OS color-scheme preference; on subsequent launches it carries
  // the exact background/foreground the renderer last used so we can paint
  // the OS window with that color before any HTML loads. This is the same
  // approach VS Code uses (`IPartsSplash`) to eliminate the white flash on
  // dark-mode systems.
  const startupTheme = loadStartupTheme(nativeTheme.shouldUseDarkColors);
  const initialBackgroundColor = startupTheme.backgroundColor;
  logger.info('Loaded startup theme snapshot', {
    isDark: startupTheme.isDark,
    backgroundColor: startupTheme.backgroundColor,
    savedAt: startupTheme.savedAt,
  });

  // In dev __dirname is dist/ so ../build resolves correctly.
  // In packaged builds the icon is embedded in the executable by electron-builder.
  // iconPath is undefined when packaged so Electron uses the embedded executable icon.
  const iconExt = process.platform === 'darwin' ? 'icns' : process.platform === 'win32' ? 'ico' : 'png';
  const iconPath = app.isPackaged
    ? undefined
    : process.platform === 'linux'
      ? path.join(__dirname, '../build/icons/png/512x512.png')
      : path.join(__dirname, `../build/icons/${process.platform === 'darwin' ? 'mac' : 'win'}/icon.${iconExt}`);

  // Create the Graph-Core window manager.
  // Requirements: 2.1, 3.1, 4.1
  const graphCoreWindowManager = createGraphCoreWindowManager({
    preloadPath: path.join(__dirname, 'preload.js'),
    iconPath,
    backgroundColor: initialBackgroundColor,
    loadGraphCoreView: async (window) => {
      const devUrl = process.env.VITE_DEV_SERVER_URL;
      if (devUrl) {
        await window.loadURL(`${devUrl}?view=graph-core`);
      } else {
        await window.loadFile(path.join(__dirname, '../renderer/index.html'), {
          search: '?view=graph-core',
        });
      }
    },
    createBrowserWindow: (opts) => {
      const win = new BrowserWindow(opts);
      attachNativeEditContextMenu(win);
      return win;
    },
    logger,
  });

  // Create the Invalidation_Bus for cross-window cache-invalidation hints.
  // Requirements: 15.3
  const invalidationBus = new InvalidationBus(logger);

  // Create the Spawn_Manager for the single shared Safety Analysis window.
  // Requirements: 3.1, 3.5, 3.6
  const spawnManager = new SpawnManager({
    preloadPath: path.join(__dirname, 'preload.js'),
    iconPath,
    backgroundColor: initialBackgroundColor,
    loadSpawnView: async (window) => {
      const devUrl = process.env.VITE_DEV_SERVER_URL;
      if (devUrl) {
        await window.loadURL(`${devUrl}?view=safety-analysis-spawn`);
      } else {
        await window.loadFile(path.join(__dirname, '../renderer/index.html'), {
          search: '?view=safety-analysis-spawn',
        });
      }
    },
    createBrowserWindow: (opts) => {
      const win = new BrowserWindow(opts);
      attachNativeEditContextMenu(win);
      return win;
    },
    invalidationBus,
    logger,
  });

  // Register main-process-only IPC handlers for window management.
  // Requirements: 9.3, 4.3, 15.2
  registerWindowChannels(graphCoreWindowManager, invalidationBus, spawnManager);

  // dialog.openDirectory — must run in the main process (Electron dialog API)
  // The title is caller-supplied: this dialog is used both for picking a
  // workspace root and for picking import source folders.
  //
  // With `relativeTo`, the chosen folder is returned relative to that root, which
  // is what makes a picked import source portable. Doing it here keeps
  // `toWorkspaceRelative` the single authority, so the value the dialog hands
  // back is exactly the value that gets stored.
  ipcMain.handle('dialog.openDirectory', async (event, options?: { title?: string; defaultPath?: string; relativeTo?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      title: options?.title ?? 'Select workspace root (the folder that contains ria-data/)',
      ...(options?.defaultPath ? { defaultPath: options.defaultPath } : {}),
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    const picked = result.filePaths[0] ?? null;
    if (!picked || !options?.relativeTo) return picked;
    return toWorkspaceRelative(options.relativeTo, picked);
  });

  // dialog.saveFile — choose a destination file path (Electron dialog API)
  ipcMain.handle('dialog.saveFile', async (event, options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win!, {
      title: options?.title ?? 'Save file',
      defaultPath: options?.defaultPath,
      filters: options?.filters,
    });
    return result.canceled ? null : result.filePath ?? null;
  });

  // shell.openPath — open a file or folder in the OS default app / Explorer.
  // Restricted to directories and the document types the app actually produces:
  // the underlying API launches whatever program the shell association names, so
  // an unrestricted path lets anything holding the bridge run an executable.
  ipcMain.handle('shell.openPath', async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new Error('shell.openPath requires a non-empty path');
    }

    const resolved = path.resolve(filePath);

    let isDirectory: boolean;
    try {
      isDirectory = statSync(resolved).isDirectory();
    } catch {
      logger.warn('Refused shell.openPath: target does not exist', { filePath: resolved });
      throw new Error(`Cannot open "${resolved}": the file or folder does not exist.`);
    }

    if (!isDirectory && !OPENABLE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      logger.warn('Refused shell.openPath: file type is not openable', { filePath: resolved });
      throw new Error(
        `Cannot open "${path.basename(resolved)}": only logs, reports and folders can be opened from RiaCore.`,
      );
    }

    const errorMessage = await shell.openPath(resolved);
    if (errorMessage) {
      logger.error('shell.openPath failed', { filePath: resolved, errorMessage });
      throw new Error(errorMessage);
    }
  });

  // context-menu — show a native OS context menu and return the clicked item id
  ipcMain.handle('context-menu.show', async (event, items: { id: string; label: string }[]) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;

    return new Promise<string | null>((resolve) => {
      const menu = Menu.buildFromTemplate(
        items.map((item) => ({
          label: item.label,
          click: () => resolve(item.id),
        })),
      );
      menu.popup({
        window: win,
        callback: () => resolve(null), // menu closed without selection
      });
    });
  });

  ipcMain.handle('app.openLogsDirectory', async () => {
    const logsPath = ensureAppLogsDirectory();

    const errorMessage = await shell.openPath(logsPath);
    if (errorMessage) {
      logger.error('Failed to open app logs directory', { logsPath, errorMessage });
      throw new Error(errorMessage);
    }

    logger.info('Opened app logs directory', { logsPath });

    return logsPath;
  });

  ipcMain.handle('app.getConfig', async () => {
    return getAppConfig();
  });

  /**
   * Renderer pushes the colors antd actually rendered with so we can persist
   * them for next launch. Validation is in `saveStartupTheme`; bad payloads
   * are silently dropped.
   */
  ipcMain.on('window.persistTheme', (_event, payload: unknown) => {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof (payload as { isDark?: unknown }).isDark !== 'boolean' ||
      typeof (payload as { backgroundColor?: unknown }).backgroundColor !== 'string' ||
      typeof (payload as { foregroundColor?: unknown }).foregroundColor !== 'string'
    ) {
      logger.warn('Ignoring window.persistTheme: invalid payload', { payload });
      return;
    }
    const theme: StartupTheme = {
      savedAt: new Date().toISOString(),
      isDark: (payload as { isDark: boolean }).isDark,
      backgroundColor: (payload as { backgroundColor: string }).backgroundColor,
      foregroundColor: (payload as { foregroundColor: string }).foregroundColor,
    };
    saveStartupTheme(theme);
  });

  ipcMain.handle('app.logRendererEvent', async (_event, entry: RendererLogEntry) => {
    const context = {
      type: entry.type,
      component: entry.component ?? null,
      stack: entry.stack,
      ...(entry.context ?? {}),
    };

    switch (entry.level) {
      case 'debug':
        logger.debug(`Renderer event: ${entry.message}`, context);
        return;
      case 'warn':
        logger.warn(`Renderer event: ${entry.message}`, context);
        return;
      case 'info':
        logger.info(`Renderer event: ${entry.message}`, context);
        return;
      default:
        logger.error(`Renderer event: ${entry.message}`, context);
    }
  });

  ipcMain.handle('workspace.openLogsDirectory', async (_event, workingDir: string) => {
    const logsPath = path.join(workingDir, 'logs');
    mkdirSync(logsPath, { recursive: true });

    const errorMessage = await shell.openPath(logsPath);
    if (errorMessage) {
      logger.error('Failed to open workspace logs directory', { workingDir, logsPath, errorMessage });
      throw new Error(errorMessage);
    }

    logger.info('Opened workspace logs directory', { workingDir, logsPath });
    return logsPath;
  });

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: iconPath,
    // Start the window already shown but at full transparency so Windows
    // doesn't run its window-open fade/slide animation (which briefly shows
    // the area behind the window and reads as a flash on dark systems).
    // We then ramp opacity to 1 once the renderer has actually painted.
    show: true,
    opacity: 0,
    backgroundColor: initialBackgroundColor,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  attachNativeEditContextMenu(mainWindow);

  // Inject the persisted-theme splash CSS as early as possible so Chromium's
  // very first paint already shows the correct background, not the default
  // white surface. `did-start-loading` fires before the document is parsed,
  // so the rule is in place before any HTML is rendered. Defense-in-depth:
  // the opacity trick above is what actually hides the flash, but if the
  // fallback timer reveals the window before antd has rendered, this CSS
  // ensures the user sees a themed background, not white.
  // See VS Code's `IPartsSplash` for the same pattern at much larger scale.
  const splashCss = buildSplashCss(startupTheme);
  let splashCssKey: string | null = null;
  mainWindow.webContents.on('did-start-loading', () => {
    mainWindow.webContents
      .insertCSS(splashCss, { cssOrigin: 'user' })
      .then((key) => {
        splashCssKey = key;
      })
      .catch((err) => {
        logger.warn('Failed to inject splash CSS', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });
  // Once the renderer has committed its themed paint, remove the splash CSS
  // so it doesn't override antd's later styling. We piggyback on the existing
  // paintReady IPC; the removal happens in the listener below.
  const removeSplashCss = () => {
    if (!splashCssKey || mainWindow.isDestroyed()) return;
    const key = splashCssKey;
    splashCssKey = null;
    mainWindow.webContents
      .removeInsertedCSS(key)
      .catch((err) => logger.warn('Failed to remove splash CSS', {
        error: err instanceof Error ? err.message : String(err),
      }));
  };

  // Reveal the window only after the renderer signals that React has committed
  // its first themed paint (see apps/renderer/src/main.tsx). The window was
  // created with opacity: 0 so it's already on screen but invisible — ramping
  // opacity to 1 here triggers no Win11 window-open animation, unlike calling
  // show() on a hidden window.
  //
  // Fallback: if the signal never arrives (e.g. renderer crash, very slow
  // startup, slow first import), reveal 5 seconds after `did-finish-load`
  // so the user is never stuck with no window. The splash CSS injected
  // above keeps the canvas themed if the fallback fires before antd renders.
  let mainWindowShown = false;
  const showMainWindowOnce = () => {
    if (mainWindowShown || mainWindow.isDestroyed()) return;
    mainWindowShown = true;
    mainWindow.setOpacity(1);
  };
  const paintReadyListener = (event: Electron.IpcMainEvent) => {
    if (event.sender === mainWindow.webContents) {
      ipcMain.removeListener('window.paintReady', paintReadyListener);
      // Remove the splash CSS now that antd's real styling is in place.
      // Without this, the !important splash rules would override later
      // theme changes (e.g. user toggling dark/light at runtime).
      removeSplashCss();
      showMainWindowOnce();
    }
    // Other windows (spawn, graph-core) may also send paintReady; ignore here.
  };
  ipcMain.on('window.paintReady', paintReadyListener);
  mainWindow.on('closed', () => {
    ipcMain.removeListener('window.paintReady', paintReadyListener);
  });
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(showMainWindowOnce, 5000);
  });

  // Register the main window with the Invalidation_Bus.
  // Requirements: 15.3
  invalidationBus.registerWindow(mainWindow);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    logger.info('Loading renderer from dev server', { devUrl });
    await mainWindow.loadURL(devUrl);
  } else {
    logger.info('Loading packaged renderer file');
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Shutdown ordering: close Graph-Core window and Spawn_Window before the worker shuts down.
  // Requirements: 10.1, 10.2, 10.3, 3.8
  mainWindow.on('close', () => {
    // DIAGNOSTIC (temporary): correlate window-close timestamp against the
    // last persistor.store / canvas-mutation log lines to investigate the
    // intermittent missing-tile/missing-connection bug on reopen. Remove
    // once root-caused.
    logger.info('[DIAG] Main window close event fired', { ts: new Date().toISOString() });
    graphCoreWindowManager.close().catch((err) => {
      logger.error('Failed to close Graph-Core window during main-window shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    spawnManager.close().catch((err) => {
      logger.error('Failed to close Spawn_Window during main-window shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  // Requirement 1.4, 7.1, 7.3 — graceful shutdown before quitting
  app.on('window-all-closed', async () => {
    logger.info('All windows closed; beginning shutdown');
    await manager.shutdown();
    app.quit();
  });
}

bootstrap().catch((err) => {
  const logger = app.isReady() ? getAppLogger() : null;
  logger?.fatal('Bootstrap failed', { error: err instanceof Error ? err.message : String(err) });
  console.error('[RiaCore] Bootstrap failed:', err);
  dialog.showErrorBox(
    'RiaCore Startup Error',
    `The application failed to start:\n\n${String(err)}`
  );
  app.exit(1);
});
