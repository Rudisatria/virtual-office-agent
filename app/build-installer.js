// Builds dist/VirtualOfficeSetup.exe: the installer for friends' laptops (Windows, no admin rights needed).
// It carries the office's files (everything tracked by git) and this laptop's Node.js inside, so the other laptop
// needs nothing else installed. Uses the C# compiler that ships with Windows. Run: npm.cmd run installer:build
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { zip } = require('../config');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(csc)) { console.error('The C# compiler was not found at ' + csc); process.exit(1); }

// The office's files: what git tracks (so local logs, backups and builds stay out), minus files only for this repo.
// HANDOFF.md and AGENTS.md are notes for coding agents and hold personal details: they never ship.
const SKIP = /^(\.git|start-mac\.command$|start-windows\.bat$|HANDOFF\.md$|AGENTS\.md$|tests\/|docs\/)/;
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(f => f && !SKIP.test(f));
const files = tracked.map(f => ({ name: f, data: fs.readFileSync(path.join(ROOT, f)) }));
// Node.js itself (the one running this build), with a note on its license
files.push({ name: 'node/node.exe', data: fs.readFileSync(process.execPath) });
files.push({ name: 'node/NOTICE.txt', data: Buffer.from(`This folder holds Node.js ${process.version} (https://nodejs.org), used to run the office.\r\nNode.js is released under the MIT license: https://github.com/nodejs/node/blob/main/LICENSE\r\n`) });

fs.mkdirSync(DIST, { recursive: true });
const payload = path.join(DIST, 'payload.zip');
console.log('Packing ' + files.length + ' files…');
fs.writeFileSync(payload, zip(files, true));
console.log('payload.zip: ' + (fs.statSync(payload).size / 1048576).toFixed(1) + ' MB');

const out = path.join(DIST, 'VirtualOfficeSetup.exe');
execFileSync(csc, ['/nologo', '/target:winexe', '/optimize+', '/out:' + out, '/win32icon:' + path.join(__dirname, 'claude-office.ico'),
  '/resource:' + payload + ',payload.zip',
  '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  path.join(__dirname, 'installer', 'Setup.cs')], { stdio: 'inherit' });
if (!process.argv.includes('--keep-payload')) fs.unlinkSync(payload);   // --keep-payload: leave it in dist/ for checking
console.log('Built ' + out + ' (' + (fs.statSync(out).size / 1048576).toFixed(1) + ' MB)');
