// Adds the Virtual Office shortcuts (or removes them with --uninstall):
//  - desktop and Start menu: open the office
//  - with --startup, also the Windows Startup folder: start the office server in the background when you sign in
//  - the virtual-office:// link, so the office page's server button can start the server
const { execFileSync } = require('child_process');
const path = require('path');

const uninstall = process.argv.includes('--uninstall');
const startup = process.argv.includes('--startup');
const q = s => "'" + String(s).replace(/'/g, "''") + "'"; // PowerShell single-quoted string
const launch = '"' + path.join(__dirname, 'launch.js') + '"';
const icon = path.join(__dirname, 'claude-office.ico') + ',0', lockIcon = path.join(__dirname, 'lock.ico') + ',0';
// --name sets the shortcuts' name (the installer passes the one it used, so uninstalling finds them again)
const at = process.argv.indexOf('--name'), NAME = at > 0 && process.argv[at + 1] ? process.argv[at + 1] : 'Virtual Office';

// "Show office and lock" (built by npm run saver:build) starts the office screensaver right away, already locked
const lockExe = path.join(__dirname, 'Show office and lock.exe');
const LOCK = 'Show office and lock';

// [folder, file name, arguments, description, program (default: node.exe), icon]; uninstall removes all of them
const shortcuts = [
  ['Desktop', NAME + '.lnk', launch, 'Open ' + NAME],
  ['Programs', NAME + '.lnk', launch, 'Open ' + NAME],
  ['Startup', NAME + ' (background).lnk', launch + ' --background', 'Start the ' + NAME + ' server when you sign in'],
  ['Desktop', LOCK + '.lnk', '', 'Lock the screen and keep the office showing', lockExe, lockIcon],
  ['Programs', LOCK + '.lnk', '', 'Lock the screen and keep the office showing', lockExe, lockIcon]
].filter(s => uninstall || s[0] !== 'Startup' || startup)
 .filter(s => uninstall || !s[4] || require('fs').existsSync(s[4]));

// Inline commands only: creates the shortcuts through Windows' own shortcut API, no script files
const ps = '$shell = New-Object -ComObject WScript.Shell\n' + shortcuts.map(([folder, file, args, desc, program, ico]) => `
$lnk = Join-Path ([Environment]::GetFolderPath(${q(folder)})) ${q(file)}
if (${uninstall ? '$true' : '$false'}) { if (Test-Path $lnk) { Remove-Item $lnk; "Removed $lnk" } }
else {
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = ${q(program || process.execPath)}; $s.Arguments = ${q(args)}; $s.WorkingDirectory = ${q(path.join(__dirname, '..'))}
  $s.IconLocation = ${q(ico || icon)}; $s.WindowStyle = 7; $s.Description = ${q(desc)}
  $s.Save(); "Created $lnk"
}`).join('\n') + `
# virtual-office:// link: the "Server not running · click to start" button in the office opens it to start the server
# (rudi-office:// was its old name; removed when found)
$old = 'HKCU:\\Software\\Classes\\rudi-office'
if (Test-Path $old) { Remove-Item $old -Recurse }
$key = 'HKCU:\\Software\\Classes\\virtual-office'
if (${uninstall ? '$true' : '$false'}) { if (Test-Path $key) { Remove-Item $key -Recurse; "Removed the virtual-office:// link" } }
else {
  New-Item -Path "$key\\shell\\open\\command" -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value ${q('URL:' + NAME)}
  Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
  Set-ItemProperty -Path "$key\\shell\\open\\command" -Name '(default)' -Value ${q('"' + process.execPath + '" ' + launch + ' --background')}
  "Registered the virtual-office:// link (starts the server from the office page)"
}`;
process.stdout.write(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }));
