const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, Notification, globalShortcut } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');

let mainWindow;
let tray;

const LOG_FILE = path.join(app.getPath('userData'), 'debug.log');
function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch(e) {}
}

let timers = {};
let nextTimerId = 1;

const DATA_FILE = path.join(app.getPath('userData'), 'actions_v1.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings_v1.json');

let actionsData = [];
let settings = {
  notifEnabled: true,
  notifTimes: [300],
  addTimeAmount: 600,
  minimizeToTray: true,
  warnOnReplace: true,
  deleteOnFinish: true,
  waitForMusic: false,
  waitForMusicMaxSecs: 0,
  shortcuts: {
    cancel: 'CommandOrControl+Alt+S',
    pause:  'CommandOrControl+Alt+P',
    toggle: 'CommandOrControl+Alt+O'
  }
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      actionsData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } else {
      actionsData = [];
      saveActions();
    }
  } catch(e) { actionsData = []; }
  try {
    if (fs.existsSync(SETTINGS_FILE)) settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch(e) {}
}

function saveActions() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(actionsData, null, 2)); } catch(e) {} }
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch(e) {} }

function isMusicPlaying() {
  // Utilise un script C# compilé à la volée via PowerShell pour appeler WinRT de façon synchrone
  const psScript = `
$code = @"
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Windows.Media.Control;
public class MusicChecker {
  public static bool IsPlaying() {
    try {
      var mgr = GlobalSystemMediaTransportControlsSessionManager.RequestAsync().AsTask().GetAwaiter().GetResult();
      var sessions = mgr.GetSessions();
      foreach (var s in sessions) {
        var info = s.GetPlaybackInfo();
        if (info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing) return true;
      }
    } catch {}
    return false;
  }
}
"@
Add-Type -TypeDefinition $code -Language CSharp -ReferencedAssemblies @(
  [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBuffer].Assembly.Location,
  (Join-Path ([System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) "WinRT.Runtime.dll")
) -ErrorAction SilentlyContinue 2>$null
if ([MusicChecker]::IsPlaying()) { exit 0 } else { exit 1 }
`;
  const tmpFile = path.join(app.getPath('temp'), 'stp_music_check.ps1');
  try {
    fs.writeFileSync(tmpFile, psScript, 'utf8');
    execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`, { timeout: 8000, windowsHide: true });
    log('isMusicPlaying: TRUE');
    return true;
  } catch(e) {
    // Fallback : chercher des processus audio connus actifs
    try {
      const result = execSync(
        `powershell -NoProfile -NonInteractive -Command "Get-Process | Where-Object {$_.Name -match 'chrome|msedge|firefox|Spotify|vlc|wmplayer|groove|musicbee|foobar'} | Select-Object -First 1 -ExpandProperty Name"`,
        { timeout: 3000, windowsHide: true }
      ).toString().trim();
      const found = result.length > 0;
      log(`isMusicPlaying fallback: ${found ? 'TRUE — ' + result : 'FALSE'}`);
      return found;
    } catch(e2) {
      log('isMusicPlaying: FALSE — ' + e2.message);
      return false;
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 820,
    minHeight: 600,
    frame: false,
    backgroundColor: '#060A14',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (e) => {
    if (settings.minimizeToTray && Object.keys(timers).length > 0) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico')).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
  } catch(e) { tray = new Tray(nativeImage.createEmpty()); }

  tray.setToolTip('SleepTimer Pro');
  updateTrayMenu();
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

function updateWindowTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const ids = Object.keys(timers);
  if (ids.length === 0) {
    mainWindow.setTitle('SleepTimer Pro');
  } else {
    const t = timers[ids[0]];
    mainWindow.setTitle(`SleepTimer Pro — ${formatTime(t.remaining)} · ${getTypeName(t.type)}`);
  }
}

function updateTrayMenu() {
  const activeTimers = Object.values(timers);
  const timerItems = activeTimers.length === 0
    ? [{ label: 'Aucun timer actif', enabled: false }]
    : activeTimers.map(t => ({
        label: `${t.actionName} — ${t.waitingMusic ? 'Attente fin musique…' : formatTime(t.remaining)}`,
        enabled: false
      }));

  const menu = Menu.buildFromTemplate([
    ...timerItems,
    { type: 'separator' },
    { label: 'Ouvrir', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Tout annuler', enabled: activeTimers.length > 0, click: () => cancelAllTimers() },
    { type: 'separator' },
    { label: 'Quitter', click: () => { Object.keys(timers).forEach(id => clearInterval(timers[id].interval)); app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

function startMusicWait(id, actionData) {
  const t = timers[id];
  if (!t) return;

  t.waitingMusic = true;
  t.musicWaitStart = Date.now();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('timer-waiting-music', { id });
  }
  updateTrayMenu();

  const maxMs = (settings.waitForMusicMaxSecs && settings.waitForMusicMaxSecs > 0)
    ? settings.waitForMusicMaxSecs * 1000
    : null;

  t.musicInterval = setInterval(() => {
    if (!timers[id]) { clearInterval(t.musicInterval); return; }

    const elapsed = Date.now() - t.musicWaitStart;
    if (maxMs && elapsed >= maxMs) {
      clearInterval(t.musicInterval);
      delete timers[id];
      updateTrayMenu();
      updateWindowTitle();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('timer-cancelled', id);
      executeAction(actionData.type, id);
      return;
    }

    const playing = isMusicPlaying();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('timer-music-status', { id, playing, elapsed: Math.floor(elapsed/1000), maxSecs: settings.waitForMusicMaxSecs||0 });
    }

    if (!playing) {
      clearInterval(t.musicInterval);
      delete timers[id];
      updateTrayMenu();
      updateWindowTitle();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('timer-cancelled', id);
      executeAction(actionData.type, id);
    }
  }, 5000);
}

function startTimer(id, seconds, actionData) {
  if (timers[id]) clearInterval(timers[id].interval);

  timers[id] = {
    id,
    remaining: seconds,
    total: seconds,
    actionName: actionData.actionName,
    actionIcon: actionData.actionIcon,
    type: actionData.type,
    paused: false,
    waitingMusic: false,
    // Pré-remplir les seuils déjà dépassés dès le démarrage (évite les notifs immédiates)
    notifSentSet: new Set(
      (Array.isArray(settings.notifTimes) ? settings.notifTimes : [settings.notifTimes || 300])
        .filter(threshold => threshold >= seconds)
    ),
    interval: null
  };

  let lastTick = Date.now();

  timers[id].interval = setInterval(() => {
    const t = timers[id];
    if (!t || t.paused) { lastTick = Date.now(); return; }

    const now = Date.now();
    const delta = Math.min(Math.round((now - lastTick) / 1000), 60);
    lastTick = now;
    t.remaining = Math.max(0, t.remaining - delta);

    if (settings.notifEnabled) {
      const thresholds = Array.isArray(settings.notifTimes) ? settings.notifTimes : [settings.notifTimes || 300];
      thresholds.forEach(threshold => {
        if (t.remaining <= threshold && !t.notifSentSet.has(threshold)) {
          t.notifSentSet.add(threshold);
          sendWindowsNotification(id, t, threshold);
        }
      });
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('timer-tick', { id, remaining: t.remaining, total: t.total });
    }
    updateTrayMenu();
    updateWindowTitle();

    if (t.remaining <= 0) {
      clearInterval(t.interval);
      const shouldWait = (actionData.waitForMusic !== undefined ? actionData.waitForMusic : settings.waitForMusic);
      log(`Timer ${id} fini — shouldWait=${shouldWait}, settings.waitForMusic=${settings.waitForMusic}, action.waitForMusic=${actionData.waitForMusic}`);
      if (shouldWait && isMusicPlaying()) {
        startMusicWait(id, actionData);
      } else {
        delete timers[id];
        updateTrayMenu();
        updateWindowTitle();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('timer-cancelled', id);
        executeAction(actionData.type, id);
      }
    }
  }, 1000);

  updateTrayMenu();
}

function sendWindowsNotification(timerId, t, threshold) {
  if (!Notification.isSupported()) return;

  const timeStr = formatTime(threshold);
  const notif = new Notification({
    title: `SleepTimer Pro — ${t.actionName}`,
    body: `${getTypeName(t.type)} dans ${timeStr}. Cliquez pour ajouter ${formatTime(settings.addTimeAmount)}.`,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    timeoutType: 'never'
  });

  notif.on('click', () => {
    if (timers[timerId]) {
      timers[timerId].remaining += settings.addTimeAmount;
      timers[timerId].total += settings.addTimeAmount;
      timers[timerId].notifSentSet = new Set([...timers[timerId].notifSentSet].filter(s => s < timers[timerId].remaining));
      mainWindow.webContents.send('timer-tick', {
        id: timerId,
        remaining: timers[timerId].remaining,
        total: timers[timerId].total
      });
      mainWindow.webContents.send('time-added', { id: timerId, added: settings.addTimeAmount });
    }
  });

  notif.show();
}

function cancelTimer(id) {
  if (timers[id]) {
    clearInterval(timers[id].interval);
    if (timers[id].musicInterval) clearInterval(timers[id].musicInterval);
    delete timers[id];
  }
  updateTrayMenu();
  updateWindowTitle();
  mainWindow.webContents.send('timer-cancelled', id);
}

function cancelAllTimers() {
  Object.keys(timers).forEach(id => {
    clearInterval(timers[id].interval);
    if (timers[id].musicInterval) clearInterval(timers[id].musicInterval);
    mainWindow.webContents.send('timer-cancelled', parseInt(id));
  });
  timers = {};
  updateTrayMenu();
}

function executeAction(type, timerId) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('action-executing', { type, timerId });
  }

  const commands = {
    shutdown:  ['shutdown', ['/s', '/t', '3']],
    restart:   ['shutdown', ['/r', '/t', '3']],
    sleep:     ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0', '1', '0']],
    hibernate: ['shutdown', ['/h']],
    lock:      ['rundll32.exe', ['user32.dll,LockWorkStation']],
    logoff:    ['shutdown', ['/l']],
  };

  const cmdArgs = commands[type] || commands.sleep;

  setTimeout(() => {
    try {
      const child = spawn(cmdArgs[0], cmdArgs[1], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();

      if (type === 'lock' || type === 'logoff') {
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('action-done');
          }
        }, 1500);
      }
    } catch(err) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('action-error', err.message);
      }
    }
  }, 3000);
}

function formatTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h${String(m).padStart(2,'0')}`;
  if (m > 0) return `${m}m${String(s).padStart(2,'0')}s`;
  return `${s}s`;
}

function getTypeName(type) {
  return { sleep:'Veille', shutdown:'Extinction', restart:'Redémarrage', hibernate:'Hibernation', lock:'Verrouillage', logoff:'Déconnexion' }[type] || type;
}

ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window-close', () => {
  if (settings.minimizeToTray && Object.keys(timers).length > 0) mainWindow.hide();
  else app.quit();
});

ipcMain.on('start-timer', (e, data) => {
  Object.keys(timers).forEach(id => {
    clearInterval(timers[id].interval);
    if (timers[id].musicInterval) clearInterval(timers[id].musicInterval);
    mainWindow.webContents.send('timer-cancelled', parseInt(id));
  });
  timers = {};
  const id = nextTimerId++;
  startTimer(id, data.seconds, data);
  e.reply('timer-started', { id, ...data });
});

ipcMain.on('cancel-timer', (e, id) => cancelTimer(id));

ipcMain.on('pause-timer', (e, { id, paused }) => {
  if (timers[id]) {
    timers[id].paused = paused;
    if (!paused) {
      Object.keys(timers).forEach(tid => {
        if (parseInt(tid) !== id) timers[tid].paused = true;
      });
      mainWindow.webContents.send('others-paused', id);
    }
    updateTrayMenu();
  }
});

ipcMain.on('add-time', (e, { id, seconds }) => {
  if (timers[id]) {
    timers[id].remaining += seconds;
    timers[id].total += seconds;
    timers[id].notifSentSet = new Set(
      [...timers[id].notifSentSet].filter(s => s < timers[id].remaining)
    );
    mainWindow.webContents.send('timer-tick', { id, remaining: timers[id].remaining, total: timers[id].total });
  }
});

ipcMain.on('get-actions', (e) => e.reply('actions-data', actionsData));
ipcMain.on('save-actions', (e, data) => { actionsData = data; saveActions(); });
ipcMain.on('get-settings', (e) => e.reply('settings-data', settings));
ipcMain.on('save-settings', (e, data) => { settings = { ...settings, ...data }; saveSettings(); if (data.shortcuts) registerShortcuts(); });
ipcMain.on('execute-now', (e, type) => {
  dialog.showMessageBox(mainWindow, {
    type: 'warning', buttons: ['Annuler', 'Confirmer'], defaultId: 0, cancelId: 0,
    title: 'Confirmation', message: `Exécuter maintenant : ${getTypeName(type)} ?`
  }).then(r => { if (r.response === 1) executeAction(type, null); });
});

app.whenReady().then(() => {
  loadData();
  createWindow();
  createTray();
  registerShortcuts();
});

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const sc = { ...{ cancel: 'CommandOrControl+Alt+S', pause: 'CommandOrControl+Alt+P', toggle: 'CommandOrControl+Alt+O' }, ...(settings.shortcuts || {}) };

  globalShortcut.register(sc.cancel, () => {
    const ids = Object.keys(timers);
    if (ids.length > 0) {
      ids.forEach(id => {
        clearInterval(timers[id].interval);
        if (timers[id].musicInterval) clearInterval(timers[id].musicInterval);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('timer-cancelled', parseInt(id));
      });
      timers = {};
      updateTrayMenu(); updateWindowTitle();
    } else {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    }
  });

  globalShortcut.register(sc.pause, () => {
    const ids = Object.keys(timers);
    if (ids.length === 0) return;
    const id = parseInt(ids[0]);
    timers[id].paused = !timers[id].paused;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shortcut-pause', { id, paused: timers[id].paused });
    }
    updateTrayMenu();
  });

  globalShortcut.register(sc.toggle, () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

app.on('window-all-closed', () => {
  app.quit();
});
