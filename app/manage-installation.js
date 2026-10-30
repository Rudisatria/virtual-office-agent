// Launches the office's own Windows installer and uninstaller from the Setup page.
// The update path comes from a native file dialog, never from an HTTP request body.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

function pickInstaller() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Choose the Virtual Office update installer'
$dialog.Filter = 'Virtual Office installer (VirtualOfficeSetup.exe)|VirtualOfficeSetup.exe'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$downloads = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'
if (Test-Path -LiteralPath $downloads) { $dialog.InitialDirectory = $downloads }
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
try {
  $owner.Show()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.FileName)
  }
} finally { $owner.Close(); $owner.Dispose(); $dialog.Dispose() }
`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 300000, maxBuffer: 8192 }, (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || error.message).trim()));
        else resolve(stdout.trim() || null);
      });
  });
}

function installerInfo(file) {
  if (path.basename(file).toLowerCase() !== 'virtualofficesetup.exe') throw new Error('Choose VirtualOfficeSetup.exe.');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 1024 * 1024 || stat.size > 150 * 1024 * 1024) throw new Error('The installer file has an unexpected size.');
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(64), signature = Buffer.alloc(4);
    fs.readSync(fd, header, 0, header.length, 0);
    const peOffset = header.readUInt32LE(0x3c);
    if (header.toString('ascii', 0, 2) !== 'MZ' || peOffset < 64 || peOffset > stat.size - 4) throw new Error('The selected file is not a Windows installer.');
    fs.readSync(fd, signature, 0, 4, peOffset);
    if (signature.toString('hex') !== '50450000') throw new Error('The selected file is not a Windows installer.');
  } finally { fs.closeSync(fd); }
  return { name: path.basename(file), modified: stat.mtime.toISOString(), size: stat.size };
}

function launchVisible(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [], { detached: true, windowsHide: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function createManager(options = {}) {
  const root = options.root || path.join(__dirname, '..');
  const picker = options.picker || pickInstaller;
  const launch = options.launch || launchVisible;
  const installed = () => process.platform === 'win32' && fs.existsSync(path.join(root, 'Uninstall.exe'));
  let selection = null, selecting = false;
  return {
    installed,
    async select() {
      if (!installed()) throw new Error('Install the office first.');
      if (selecting) throw new Error('The update file picker is already open.');
      selection = null;
      selecting = true;
      try {
        const file = await picker();
        if (!file) return { cancelled: true };
        const info = installerInfo(file);
        selection = { file, token: crypto.randomBytes(16).toString('hex'), expires: Date.now() + 300000 };
        return { ...info, token: selection.token };
      } finally { selecting = false; }
    },
    async run(token) {
      if (!installed()) throw new Error('Install the office first.');
      if (!selection || token !== selection.token || Date.now() > selection.expires) throw new Error('Choose the update installer again.');
      installerInfo(selection.file); // It might have been moved or replaced since selection.
      const file = selection.file;
      await launch(file);
      selection = null;
    },
    async uninstall() {
      if (!installed()) throw new Error('The office is not installed here.');
      await launch(path.join(root, 'Uninstall.exe'));
    }
  };
}

module.exports = { createManager, installerInfo };
