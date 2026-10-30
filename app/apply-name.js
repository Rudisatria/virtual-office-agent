// Gives an installed office's shortcuts, screensaver and entry in Windows' app list the office's current name
// (set in Setup). Run by the server after Setup saves a new name, and by app/setup.js. Only for installed copies
// (the ones with %LOCALAPPDATA%\ClaudeOffice\install.json pointing at this folder); does nothing otherwise.
//   node app/apply-name.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const APP = path.join(__dirname, '..');
const INFO = path.join(config.DATA, 'install.json');
// A name that works as a file name (Windows forbids \ / : * ? " < > |)
const fileName = name => String(name).replace(/[\\/:*?"<>|]/g, '').replace(/[. ]+$/, '').trim() || 'Virtual Office';

let info;
try { info = JSON.parse(fs.readFileSync(INFO, 'utf8')); } catch { console.log('Not an installed copy, nothing to rename.'); process.exit(0); }
if (path.resolve(info.app) !== path.resolve(APP)) { console.log('Installed elsewhere, nothing to rename here.'); process.exit(0); }
const cfg = config.load();
const name = cfg.firstRun ? 'Virtual Office' : fileName(cfg.officeName);
if (name === info.name && !process.argv.includes('--force')) { console.log('Names already match: ' + name); process.exit(0); }

const node = (script, ...args) => execFileSync(process.execPath, [path.join(APP, script), ...args], { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const old = info.name;
// shortcuts: remove the ones with the old name, create them with the new one
if (old && old !== name) node('app/install-shortcut.js', '--uninstall', '--name', old);
node('app/install-shortcut.js', '--name', name, ...(info.startup ? ['--startup'] : []));
// screensaver: a file with the new name (Windows lists screensavers by file name), switched over if it's in use
node('app/build-screensaver.js', '--name', name);
const scr = n => path.join(APP, 'app', n + '.scr');
if (info.screensaver) node('app/screensaver-config.js', 'set', scr(name));
if (old && old !== name) try { fs.unlinkSync(scr(old)); } catch {}
// Windows' app list
execFileSync('reg.exe', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VirtualOffice', '/v', 'DisplayName', '/t', 'REG_SZ', '/d', name, '/f'], { stdio: 'ignore' });
fs.writeFileSync(INFO, JSON.stringify({ ...info, name }, null, 2) + '\n');
console.log('Shortcuts, screensaver and app list now say: ' + name);
