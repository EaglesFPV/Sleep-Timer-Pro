const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, Notification, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs   = require('fs');
const https = require('https');

let mainWindow;
let tray;
let timers = {};
let nextTimerId = 1;


const DATA_FILE     = path.join(app.getPath('userData'), 'actions_v1.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings_v1.json');
const HISTORY_FILE  = path.join(app.getPath('userData'), 'history_v1.json');

let actionsData = [];
let historyData = [];
let settings = {
  notifEnabled: true,
  notifTimes: [300],
  addTimeAmount: 600,
  minimizeToTray: true,
  deleteOnFinish: true,
  waitForMusic: false,
  waitForMusicMaxSecs: 0,
  maxTimers: 10,
  shortcutsEnabled: true,
  shortcuts: {
    cancel: 'CommandOrControl+Alt+S',
    pause:  'CommandOrControl+Alt+P',
    toggle: 'CommandOrControl+Alt+O'
  },
  shortcutsEnabledMap: {
    cancel: true,
    pause: true,
    toggle: true
  }
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) actionsData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    else { actionsData = []; saveActions(); }
  } catch { actionsData = []; }
  try {
    if (fs.existsSync(SETTINGS_FILE)) settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {}
  try {
    if (fs.existsSync(HISTORY_FILE)) historyData = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {}
}

function saveActions()  { try { fs.writeFileSync(DATA_FILE,     JSON.stringify(actionsData, null, 2)); } catch {} }
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings,    null, 2)); } catch {} }
function saveHistory()  { try { fs.writeFileSync(HISTORY_FILE,  JSON.stringify(historyData, null, 2)); } catch {} }

function getMusicState() {
  const psScript = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTaskSpecific = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTaskSpecific.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSession,Windows.Media.Control,ContentType=WindowsRuntime]
try {
  $mgr = Await([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions = $mgr.GetSessions()
  $found = $false
  foreach ($s in $sessions) {
    $info = $s.GetPlaybackInfo()
    $status = $info.PlaybackStatus.ToString()
    if ($status -eq 'Playing') {
      $found = $true
      try {
        $media = Await($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        Write-Output "PLAYING:True"
        Write-Output "TRACK:$($media.Title)|||$($media.Artist)"
      } catch {
        Write-Output "PLAYING:True"
        Write-Output "TRACK:"
      }
      break
    }
  }
  if (-not $found) { Write-Output "PLAYING:False"; Write-Output "TRACK:" }
} catch {
  Write-Output "PLAYING:False"
  Write-Output "TRACK:"
}
exit 0
`;
  const tmpFile = path.join(app.getPath('temp'), 'stp_music_check.ps1');
  try {
    fs.writeFileSync(tmpFile, psScript, 'utf8');
    const out        = execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`, { timeout: 8000, windowsHide: true }).toString();
    const playing    = out.includes('PLAYING:True');
    const trackMatch = out.match(/TRACK:(.*)/);
    const track      = trackMatch ? trackMatch[1].trim() : '';
    return { playing, track };
  } catch {
    return { playing: false, track: '' };
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
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    show: false
  });
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    autoUpdater.checkForUpdatesAndNotify();
  });
  // Restaurer l'état des timers actifs quand le renderer est rechargé
  mainWindow.webContents.on('did-finish-load', () => {
    const activeTimersList = Object.values(timers).map(t => ({
      id:          t.id,
      seconds:     t.remaining,
      total:       t.total,
      actionName:  t.actionName,
      actionIcon:  t.actionIcon,
      type:        t.type,
      color:       t.color,
      paused:      t.paused,
      waitingMusic:t.waitingMusic || false,
      startedAt:   t.startedAt || null,
    }));
    if (activeTimersList.length > 0) {
      mainWindow.webContents.send('restore-timers', activeTimersList);
    }
  });
  mainWindow.on('close', e => {
    if (settings.minimizeToTray && Object.keys(timers).length > 0) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  if (tray && !tray.isDestroyed()) return; // éviter les doublons
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico')).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
  } catch { tray = new Tray(nativeImage.createEmpty()); }
  tray.setToolTip('SleepTimer Pro');
  updateTrayMenu();
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', info => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('update-available', info.version);
    // Notification tray
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'SleepTimer Pro — Mise à jour disponible',
        body:  `v${info.version} est disponible, téléchargement en cours…`,
        icon:  path.join(__dirname, 'assets', 'icon.ico'),
        silent: false
      });
      n.on('click', () => { mainWindow.show(); mainWindow.focus(); });
      n.show();
    }
  });

  autoUpdater.on('update-downloaded', info => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('update-downloaded', info.version);
    // Notification tray cliquable pour installer
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'SleepTimer Pro — Mise à jour prête',
        body:  `v${info.version} téléchargée. Cliquez pour installer et redémarrer.`,
        icon:  path.join(__dirname, 'assets', 'icon.ico'),
        timeoutType: 'never'
      });
      n.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.removeAllListeners('close');
          mainWindow.hide();
        }
        globalShortcut.unregisterAll();
        setImmediate(() => autoUpdater.quitAndInstall(true, true));
      });
      n.show();
    }
  });

  autoUpdater.on('error', () => {});

  setTimeout(() => {
    try { autoUpdater.checkForUpdates(); } catch {}
  }, 3000);
}

function updateWindowTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const ids = Object.keys(timers);
  mainWindow.setTitle(ids.length
    ? `SleepTimer Pro — ${formatTime(timers[ids[0]].remaining)} · ${getTypeName(timers[ids[0]].type)}`
    : 'SleepTimer Pro'
  );
}

function updateTrayMenu() {
  const activeTimers = Object.values(timers);
  const timerItems   = activeTimers.length === 0
    ? [{ label: 'Aucun timer actif', enabled: false }]
    : activeTimers.map(t => ({ label: `${t.actionName} — ${t.waitingMusic ? 'Attente fin musique…' : formatTime(t.remaining)}`, enabled: false }));
  const menu = Menu.buildFromTemplate([
    ...timerItems,
    { type: 'separator' },
    { label: 'Ouvrir',       click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Tout annuler', enabled: activeTimers.length > 0, click: () => cancelAllTimers() },
    { type: 'separator' },
    { label: 'Quitter', click: () => { Object.keys(timers).forEach(id => clearInterval(timers[id].interval)); app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

function startMusicWait(id, actionData) {
  const t = timers[id];
  if (!t) return;
  t.waitingMusic   = true;
  t.musicWaitStart = Date.now();
  const initialState = getMusicState();
  t.initialTrack = initialState.track;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('timer-waiting-music', { id });
  updateTrayMenu();
  const maxMs = settings.waitForMusicMaxSecs > 0 ? settings.waitForMusicMaxSecs * 1000 : null;
  t.musicInterval = setInterval(() => {
    if (!timers[id]) { clearInterval(t.musicInterval); return; }
    const elapsed = Date.now() - t.musicWaitStart;
    if (maxMs && elapsed >= maxMs) {
      clearInterval(t.musicInterval);
      finishTimer(id, actionData);
      return;
    }
    const state = getMusicState();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('timer-music-status', { id, playing: state.playing, elapsed: Math.floor(elapsed / 1000), maxSecs: settings.waitForMusicMaxSecs || 0 });
    }
    const paused       = !state.playing;
    const trackChanged = t.initialTrack !== undefined && state.track !== t.initialTrack;
    if (paused || trackChanged) {
      clearInterval(t.musicInterval);
      finishTimer(id, actionData);
    }
  }, 5000);
}

function finishTimer(id, actionData) {
  delete timers[id];
  updateTrayMenu();
  updateWindowTitle();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('timer-cancelled', id);
  executeAction(actionData.type, id);
}

function startTimer(id, seconds, actionData) {
  if (timers[id]) clearInterval(timers[id].interval);
  const thresholds = Array.isArray(settings.notifTimes) ? settings.notifTimes : [settings.notifTimes || 300];
  timers[id] = {
    id, remaining: seconds, total: seconds,
    actionName: actionData.actionName, actionIcon: actionData.actionIcon, type: actionData.type,
    color: actionData.color || '#5B8DEF',
    paused: false, waitingMusic: false,
    startedAt: Date.now(),
    notifSentSet: new Set(thresholds.filter(t => t >= seconds)),
    interval: null
  };
  let lastTick = Date.now();
  timers[id].interval = setInterval(() => {
    const t = timers[id];
    if (!t || t.paused) { lastTick = Date.now(); return; }
    const now   = Date.now();
    const delta = Math.min(Math.round((now - lastTick) / 1000), 60);
    lastTick    = now;
    t.remaining = Math.max(0, t.remaining - delta);
    if (settings.notifEnabled) {
      thresholds.forEach(threshold => {
        if (t.remaining <= threshold && !t.notifSentSet.has(threshold)) {
          t.notifSentSet.add(threshold);
          sendWindowsNotification(id, t, threshold);
        }
      });
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('timer-tick', { id, remaining: t.remaining, total: t.total });
    updateTrayMenu();
    updateWindowTitle();
    if (t.remaining <= 0) {
      clearInterval(t.interval);
      const shouldWait = actionData.waitForMusic != null ? actionData.waitForMusic : settings.waitForMusic;
      const musicState = getMusicState();
      if (shouldWait && musicState.playing) startMusicWait(id, actionData);
      else finishTimer(id, actionData);
    }
  }, 1000);
  updateTrayMenu();
}

function sendWindowsNotification(timerId, t, threshold) {
  if (!Notification.isSupported()) return;
  const notif = new Notification({
    title: `SleepTimer Pro — ${t.actionName}`,
    body:  `${getTypeName(t.type)} dans ${formatTime(threshold)}. Cliquez pour ajouter ${formatTime(settings.addTimeAmount)}.`,
    icon:  path.join(__dirname, 'assets', 'icon.ico'),
    timeoutType: 'never'
  });
  notif.on('click', () => {
    if (!timers[timerId]) return;
    timers[timerId].remaining    += settings.addTimeAmount;
    timers[timerId].total        += settings.addTimeAmount;
    timers[timerId].notifSentSet  = new Set([...timers[timerId].notifSentSet].filter(s => s < timers[timerId].remaining));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('timer-tick',   { id: timerId, remaining: timers[timerId].remaining, total: timers[timerId].total });
      mainWindow.webContents.send('time-added',   { id: timerId, added: settings.addTimeAmount });
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
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('timer-cancelled', id);
}

function cancelAllTimers() {
  Object.keys(timers).forEach(id => {
    clearInterval(timers[id].interval);
    if (timers[id].musicInterval) clearInterval(timers[id].musicInterval);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('timer-cancelled', parseInt(id));
  });
  timers = {};
  updateTrayMenu();
  updateWindowTitle();
}

function executeAction(type, timerId) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('action-executing', { type, timerId });
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
      const child = spawn(cmdArgs[0], cmdArgs[1], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      if (type === 'lock' || type === 'logoff') {
        setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('action-done'); }, 1500);
      }
    } catch (err) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('action-error', err.message);
    }
  }, 3000);
}

function formatTime(secs) {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function getTypeName(type) {
  return { sleep:'Veille', shutdown:'Extinction', restart:'Redémarrage', hibernate:'Hibernation', lock:'Verrouillage', logoff:'Déconnexion' }[type] || type;
}

ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window-close',   () => {
  if (settings.minimizeToTray && Object.keys(timers).length > 0) mainWindow.hide();
  else app.quit();
});

ipcMain.on('start-timer', (e, data) => {
  const max = settings.maxTimers || 10;
  if (Object.keys(timers).length >= max) { e.reply('timer-limit-reached', max); return; }
  Object.keys(timers).forEach(id => {
    if (!timers[id].paused) {
      timers[id].paused = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('timer-paused-by-new', parseInt(id));
    }
  });
  const id = nextTimerId++;
  startTimer(id, data.seconds, data);
  e.reply('timer-started', { id, ...data });
});

ipcMain.on('cancel-timer', (e, id) => cancelTimer(id));

ipcMain.on('pause-timer', (e, { id, paused }) => {
  if (!timers[id]) return;
  timers[id].paused = paused;
  if (!paused) {
    Object.keys(timers).forEach(tid => { if (parseInt(tid) !== id) timers[tid].paused = true; });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('others-paused', id);
  }
  updateTrayMenu();
});

ipcMain.on('add-time', (e, { id, seconds }) => {
  if (!timers[id]) return;
  timers[id].remaining    += seconds;
  timers[id].total        += seconds;
  timers[id].notifSentSet  = new Set([...timers[id].notifSentSet].filter(s => s < timers[id].remaining));
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('timer-tick', { id, remaining: timers[id].remaining, total: timers[id].total });
});

ipcMain.on('send-contact', (e, { name, email, message }) => {
  const body = JSON.stringify({
    service_id:  'service_xyj3ngm',
    template_id: 'template_dfohpm8',
    user_id:     '4Q0Bp9F4uPxecu8vf',
    template_params: { name, email, message, title: 'SleepTimer Pro' }
  });
  const req = https.request({
    hostname: 'api.emailjs.com',
    path:     '/api/v1.0/email/send',
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      if (res.statusCode === 200) e.reply('contact-result', { ok: true });
      else e.reply('contact-result', { ok: false, err: data });
    });
  });
  req.on('error', err => e.reply('contact-result', { ok: false, err: err.message }));
  req.write(body);
  req.end();
});

ipcMain.on('get-auto-launch', e => {
  const enabled = app.getLoginItemSettings().openAtLogin;
  e.reply('auto-launch-status', enabled);
});
ipcMain.on('toggle-auto-launch', e => {
  const current = app.getLoginItemSettings().openAtLogin;
  app.setLoginItemSettings({ openAtLogin: !current, openAsHidden: true });
  e.reply('auto-launch-status', !current);
});
ipcMain.on('get-actions',    e          => e.reply('actions-data',  actionsData));
ipcMain.on('save-actions',   (e, data)  => { actionsData = data; saveActions(); });
ipcMain.on('get-settings',   e          => e.reply('settings-data', settings));
ipcMain.on('get-history',    e          => e.reply('history-data',  historyData));
ipcMain.on('save-history',   (e, data)  => { historyData = data; saveHistory(); });
ipcMain.on('save-settings',  (e, data)  => {
  settings = { ...settings, ...data };
  saveSettings();
  if (data.shortcuts !== undefined || data.shortcutsEnabled !== undefined || data.shortcutsEnabledMap !== undefined) registerShortcuts();
});
ipcMain.on('get-app-info',   e          => e.reply('app-info', { version: app.getVersion(), repo: 'https://github.com/EaglesFPV/Sleep-Timer-Pro' }));
ipcMain.on('update-install', () => {
  // Détacher tous les listeners de fermeture pour éviter le "ne répond pas"
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeAllListeners('close');
    mainWindow.hide();
  }
  // Désactiver les raccourcis globaux
  globalShortcut.unregisterAll();
  // isSilent=true : pas d'écran installateur, isForceRunAfter=true : relance l'app après
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
});
ipcMain.on('check-updates', () => { try { autoUpdater.checkForUpdates(); } catch {} });

ipcMain.on('execute-now', (e, type) => {
  dialog.showMessageBox(mainWindow, {
    type: 'warning', buttons: ['Annuler', 'Confirmer'], defaultId: 0, cancelId: 0,
    title: 'Confirmation', message: `Exécuter maintenant : ${getTypeName(type)} ?`
  }).then(r => { if (r.response === 1) executeAction(type, null); });
});

// FIX #1 — Corrige "electron.app.SleepTimerPro" dans les notifications Windows
app.setAppUserModelId('SleepTimer Pro');

app.whenReady().then(() => {
  loadData();
  createWindow();
  createTray();
  setupAutoUpdater();
  registerShortcuts();
});

function registerShortcuts() {
  globalShortcut.unregisterAll();
  if (!settings.shortcutsEnabled) return;
  const sc = { cancel:'CommandOrControl+Alt+S', pause:'CommandOrControl+Alt+P', toggle:'CommandOrControl+Alt+O', ...(settings.shortcuts || {}) };
  const en = { cancel:true, pause:true, toggle:true, ...(settings.shortcutsEnabledMap || {}) };

  if (en.cancel) globalShortcut.register(sc.cancel, () => {
    const ids = Object.keys(timers);
    if (!ids.length) return;
    const msg = ids.length > 1 ? `Annuler les ${ids.length} timers en cours ?` : 'Annuler le timer en cours ?';
    const popup = new BrowserWindow({
      width: 340,
      height: 160,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: '#0C1120',
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    popup.loadFile(path.join(__dirname, 'popup.html'), { query: { msg } });
    ipcMain.once('popup-confirm', () => { if (!popup.isDestroyed()) popup.close(); cancelAllTimers(); });
    ipcMain.once('popup-cancel',  () => { if (!popup.isDestroyed()) popup.close(); });
    popup.on('blur', () => { if (!popup.isDestroyed()) popup.close(); });
  });

  if (en.pause) globalShortcut.register(sc.pause, () => {
    const ids = Object.keys(timers);
    if (!ids.length) return;
    const id = parseInt(ids[0]);
    timers[id].paused = !timers[id].paused;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('shortcut-pause', { id, paused: timers[id].paused });
    updateTrayMenu();
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'SleepTimer Pro',
        body: timers[id].paused ? `${timers[id].actionName} — mis en pause` : `${timers[id].actionName} — repris`,
        icon: path.join(__dirname, 'assets', 'icon.ico'),
        silent: true
      });
      n.show();
    }
  });

  if (en.toggle) globalShortcut.register(sc.toggle, () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });

}

app.on('window-all-closed', () => app.quit());
