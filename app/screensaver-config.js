// Makes the office your Windows screensaver, locking the screen when you come back (or puts your old settings back).
//   node screensaver-config.js set <path to .scr>   saves your current screensaver settings, then switches to the office
//   node screensaver-config.js restore              puts the settings saved by "set" back
// Settings live in HKCU\Control Panel\Desktop; the saved copy in %LOCALAPPDATA%\ClaudeOffice\screensaver-previous.json.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DATA } = require('../config');

const KEY = 'HKCU\\Control Panel\\Desktop';
const NAMES = ['SCRNSAVE.EXE', 'ScreenSaveActive', 'ScreenSaverIsSecure', 'ScreenSaveTimeOut'];
const SAVED = path.join(DATA, 'screensaver-previous.json');

function get(name) {
  try {
    const out = execFileSync('reg.exe', ['query', KEY, '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = new RegExp('^\\s*' + name.replace('.', '\\.') + '\\s+REG_\\w+\\s+(.*)$', 'mi').exec(out);
    return m ? m[1].trim() : null;
  } catch { return null; }   // not set
}
const put = (name, value) => execFileSync('reg.exe', ['add', KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore' });
const del = name => { try { execFileSync('reg.exe', ['delete', KEY, '/v', name, '/f'], { stdio: 'ignore' }); } catch {} };

// Windows starts the screensaver more reliably from a path without spaces, so use the short (8.3) form when there is one
function shortPath(p) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:SCR).ShortPath'],
      { encoding: 'utf8', env: { ...process.env, SCR: p }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || p;
  } catch { return p; }
}

const [cmd, scr] = process.argv.slice(2);
if (cmd === 'set') {
  if (!scr || !fs.existsSync(scr)) { console.error('Screensaver file not found: ' + scr); process.exit(1); }
  if (!fs.existsSync(SAVED)) {   // keep the very first settings, so reinstalling doesn't save the office's own as "previous"
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(SAVED, JSON.stringify(Object.fromEntries(NAMES.map(n => [n, get(n)])), null, 2) + '\n');
  }
  put('SCRNSAVE.EXE', shortPath(scr));
  put('ScreenSaveActive', '1');
  put('ScreenSaverIsSecure', '1');               // "On resume, display logon screen"
  if (!get('ScreenSaveTimeOut')) put('ScreenSaveTimeOut', '300');
  console.log('The office is now your screensaver (it locks the screen when you come back).');
} else if (cmd === 'restore') {
  if (!fs.existsSync(SAVED)) { console.log('No saved screensaver settings, nothing to restore.'); process.exit(0); }
  const prev = JSON.parse(fs.readFileSync(SAVED, 'utf8'));
  for (const n of NAMES) { if (prev[n] == null) del(n); else put(n, prev[n]); }
  fs.unlinkSync(SAVED);
  console.log('Your previous screensaver settings are back.');
} else {
  console.error('Usage: node screensaver-config.js set <file.scr> | restore');
  process.exit(1);
}
