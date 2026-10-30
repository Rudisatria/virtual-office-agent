// Builds, with the C# compiler that ships with Windows (.NET Framework 4):
//  - app/<name>.scr                      the screensaver (shows the office, locks on any touch)
//  - app/Show office and lock.exe        starts that screensaver right now (used by the "Show office and lock" shortcut)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(csc)) { console.error('The C# compiler was not found at ' + csc); process.exit(1); }
const icon = name => '/win32icon:' + path.join(__dirname, name);
const build = (out, src, refs, ico = 'claude-office.ico') => {
  execFileSync(csc, ['/nologo', '/target:winexe', '/optimize+', '/out:' + out, icon(ico), ...refs.map(r => '/r:' + r), path.join(__dirname, 'screensaver', src)], { stdio: 'inherit' });
  console.log('Built ' + out);
};
// --name sets the screensaver's name (its file name is what Windows lists); the installer uses "Virtual Office"
const at = process.argv.indexOf('--name'), NAME = at > 0 && process.argv[at + 1] ? process.argv[at + 1] : 'Virtual Office';
build(path.join(__dirname, NAME + '.scr'), 'Saver.cs', ['System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Management.dll']);
build(path.join(__dirname, 'Show office and lock.exe'), 'LockOffice.cs', [], 'lock.ico');
