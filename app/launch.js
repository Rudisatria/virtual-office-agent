// Virtual Office app launcher.
// Starts the office server in the background if it isn't running (it then keeps running, so hooks and the
// browser extension always have somewhere to send events), then opens the office in a Chrome app window.
//   node launch.js              start the server if needed and open the office window (the desktop icon)
//   node launch.js --background start the server if needed, no window (runs when you sign in to Windows)
// Logs: %LOCALAPPDATA%\ClaudeOffice
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.CLAUDE_OFFICE_PORT || process.env.PORT) || 4321;
const URL = 'http://127.0.0.1:' + PORT + '/';
const DATA = process.env.OFFICE_DATA || path.join(process.env.LOCALAPPDATA || require('os').tmpdir(), 'ClaudeOffice');
const background = process.argv.includes('--background');
const ifUnviewed = process.argv.includes('--if-unviewed');

// The shortcut starts us with a console window; hand off to a hidden copy and close it right away
if (!process.argv.includes('--child')) {
  spawn(process.execPath, [__filename, '--child', ...process.argv.slice(2)], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  process.exit(0);
}

fs.mkdirSync(DATA, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const status = () => new Promise(res => {
  const req = http.get(URL + 'health', { timeout: 1500 }, r => {
    let body = '';
    r.on('data', c => { body += c; });
    r.on('end', () => {
      try { const health = JSON.parse(body); res(r.statusCode === 200 && health.ok ? health : null); }
      catch { res(null); }
    });
  });
  req.on('error', () => res(null)); req.on('timeout', () => { req.destroy(); res(null); });
});
function showError(text) {
  // A plain Windows message box, so problems aren't silent when there's no console
  const msg = "'" + text.replace(/'/g, "''") + "'";
  execFile('powershell.exe', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(${msg}, 'Virtual office', 'OK', 'Error')`], { windowsHide: true });
}
const BROWSERS = [
  path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
];

(async () => {
  let health = await status();
  if (!health) {
    const log = fs.openSync(path.join(DATA, 'server.log'), 'a');
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    server.unref();
    let ready = false;
    // Another session may start the same server first; wait for either process to become ready.
    for (let i = 0; i < 40 && !ready; i++) { await sleep(250); health = await status(); ready = !!health; }
    if (!ready) {
      if (server.exitCode === null) server.kill();
      showError("The office server didn't start. Details are in:\n" + path.join(DATA, 'server.log'));
      return;
    }
  }
  if (background || (ifUnviewed && health.viewers > 0)) process.exit(0);
  // Chrome in app mode: its own window and taskbar entry, no tabs or address bar.
  // Started without windowsHide: Chrome uses that hidden start for its first window, which then stays invisible and
  // unpainted (a blank white window once Windows shows it) while the next click opens a second, working one.
  const browser = BROWSERS.find(p => fs.existsSync(p));
  if (!browser) { showError('Chrome is required to open the virtual office.'); return; }
  spawn(browser, ['--app=' + URL, '--user-data-dir=' + path.join(DATA, 'window'), '--window-size=1500,950', '--no-first-run', '--no-default-browser-check'],
    { detached: true, stdio: 'ignore' }).unref();
  process.exit(0);
})();
