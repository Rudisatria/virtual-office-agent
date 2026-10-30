// Removes what the installer and the Setup page added, run by Uninstall.exe with the office's own Node:
//   node app/uninstall.js [--remove-settings]
// Stops the office, removes its Claude Code and Codex hooks and the skills the office installed (never your own),
// puts your previous screensaver back, and removes the shortcuts and the entry in Windows' app list.
// Uninstall.exe deletes the office folder itself afterwards. The Chrome extension has to be removed in Chrome.
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { DATA, HOME, MARK } = require('../config');

const APP = path.join(__dirname, '..');
let info = {};
try { info = JSON.parse(fs.readFileSync(path.join(DATA, 'install.json'), 'utf8')); } catch {}
const node = (script, ...args) => execFileSync(process.execPath, [path.join(APP, script), ...args], { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const step = (label, fn) => {
  try { fn(); console.log('OK   ' + label); }
  catch (e) { console.log('SKIP ' + label + ': ' + String(e.stderr || e.message).trim().split('\n').pop()); }
};

(async () => {
  await new Promise(res => {   // stop the office server, if it's running
    const req = http.request({ host: '127.0.0.1', port: 4321, path: '/shutdown', method: 'POST', headers: { 'X-Office': 'stop' }, timeout: 1500 }, r => { r.resume(); r.on('end', res); });
    req.on('error', res); req.on('timeout', () => { req.destroy(); res(); }); req.end();
  });
  console.log('OK   Office stopped');
  step('Claude Code hooks removed', () => node('install.js', '--uninstall', '--only-this'));
  if (fs.existsSync(path.join(HOME, '.codex', 'hooks.json'))) step('Codex hooks removed', () => node('install-codex.js', '--uninstall', '--only-this'));
  step('Skills the office installed removed (your own skills are kept)', () => {
    for (const dir of [path.join(HOME, '.claude', 'skills'), path.join(HOME, '.codex', 'skills')]) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) if (fs.existsSync(path.join(dir, name, MARK))) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  });
  if (info.screensaver) step('Previous screensaver settings restored', () => node('app/screensaver-config.js', 'restore'));
  step('Shortcuts removed', () => node('app/install-shortcut.js', '--uninstall', '--name', info.name || 'Virtual Office'));
  step("Removed from Windows' app list", () => execFileSync('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VirtualOffice', '/f'], { stdio: 'ignore' }));
  if (process.argv.includes('--remove-settings')) step('Settings and edited skills removed', () => fs.rmSync(DATA, { recursive: true, force: true }));
  else { try { fs.unlinkSync(path.join(DATA, 'install.json')); } catch {} console.log('OK   Your settings and edited skills are kept in ' + DATA); }
})();
