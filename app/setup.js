// The installer's steps after Setup.exe has unpacked the office into its folder. Run with the office's own Node:
//   node app/setup.js [--screensaver] [--startup] [--no-start]
// Builds the screensaver, creates the shortcuts, registers the uninstaller in Windows' app list, then starts the
// office, which opens its Setup page on a first install. Each step prints one line for Setup.exe to show.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DATA } = require('../config');

const APP = path.join(__dirname, '..');
const NAME = 'Virtual Office';
const VERSION = require('../package.json').version;
const screensaver = process.argv.includes('--screensaver'), startup = process.argv.includes('--startup');
const node = (script, ...args) => execFileSync(process.execPath, [path.join(APP, script), ...args], { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const step = (label, fn) => {
  try { fn(); console.log('OK   ' + label); return true; }
  catch (e) { console.log('SKIP ' + label + ': ' + String(e.stderr || e.message).trim().split('\n').pop()); return false; }
};

fs.mkdirSync(DATA, { recursive: true });
const built = step('Screensaver and "Show office and lock" built', () => node('app/build-screensaver.js', '--name', NAME));
const saver = built && screensaver && step('The office is your screensaver now', () => node('app/screensaver-config.js', 'set', path.join(APP, 'app', NAME + '.scr')));
step('Shortcuts on the desktop and in the Start menu', () => node('app/install-shortcut.js', '--name', NAME, ...(startup ? ['--startup'] : [])));
step("Listed in Windows' Settings → Apps, so it can be uninstalled there", () => {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VirtualOffice';
  const add = (name, type, value) => execFileSync('reg.exe', ['add', key, '/v', name, '/t', type, '/d', String(value), '/f'], { stdio: 'ignore' });
  add('DisplayName', 'REG_SZ', NAME);
  add('DisplayVersion', 'REG_SZ', VERSION);
  add('Publisher', 'REG_SZ', NAME);
  add('DisplayIcon', 'REG_SZ', path.join(APP, 'app', 'claude-office.ico'));
  add('InstallLocation', 'REG_SZ', APP);
  add('UninstallString', 'REG_SZ', '"' + path.join(APP, 'Uninstall.exe') + '"');
  add('NoModify', 'REG_DWORD', 1);
  add('NoRepair', 'REG_DWORD', 1);
});
// What was installed, for the uninstaller
fs.writeFileSync(path.join(DATA, 'install.json'), JSON.stringify({ app: APP, name: NAME, version: VERSION, screensaver: !!saver, startup, at: new Date().toISOString() }, null, 2) + '\n');
// Updating, or settings kept from an earlier install: shortcuts and screensaver take the office's own name
step('Shortcuts named after your office', () => node('app/apply-name.js'));
if (!process.argv.includes('--no-start')) step('Office started', () => spawn(process.execPath, [path.join(APP, 'app', 'launch.js')], { cwd: APP, detached: true, stdio: 'ignore', windowsHide: true }).unref());
