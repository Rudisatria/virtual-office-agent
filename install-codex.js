// Adds (or removes, with --uninstall) the Virtual office hooks in your user-level Codex hooks file (~/.codex/hooks.json).
// Your existing hooks are kept, and a backup copy is saved first.
const fs = require('fs');
const os = require('os');
const path = require('path');

const uninstall = process.argv.includes('--uninstall');
const hooksPath = path.join(process.env.OFFICE_HOME || os.homedir(), '.codex', 'hooks.json');
// Node by its full path: a laptop with the installer's own copy of Node may not have "node" on its PATH
const hookPath = path.join(__dirname, 'hook.js');
const legacyCommand = '"' + process.execPath + '" "' + hookPath + '" codex';
// cmd.exe misparses two quoted paths when either contains spaces. Encode the PowerShell invocation to avoid that.
const psQuote = value => "'" + value.replace(/'/g, "''") + "'";
const command = process.platform === 'win32'
  ? 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from('& ' + psQuote(process.execPath) + ' ' + psQuote(hookPath) + ' codex', 'utf16le').toString('base64')
  : legacyCommand;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt', 'SessionEnd'];
// --only-this (the uninstaller) leaves other copies of the office alone
const onlyThis = process.argv.includes('--only-this');
const isOurs = h => h && h.type === 'command' && (h.command === command || h.command === legacyCommand || (!onlyThis && /(claude|ai)-office[^"]*hook\.js"? codex$/.test(String(h.command).replace(/\\/g, '/'))));

if (!fs.existsSync(path.dirname(hooksPath))) {
  console.error('Codex settings folder not found (' + path.dirname(hooksPath) + '). Open Codex once, then try again.');
  process.exit(1);
}
let config = {};
if (fs.existsSync(hooksPath)) {
  const raw = fs.readFileSync(hooksPath, 'utf8');
  try { config = raw.trim() ? JSON.parse(raw) : {}; }
  catch (e) {
    console.error('Could not read ' + hooksPath + ' because it is not valid JSON. Nothing was changed.');
    console.error(e.message);
    process.exit(1);
  }
  const backup = hooksPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(hooksPath, backup);
  console.log('Backup saved: ' + backup);
}

const hooks = config.hooks || {};
for (const ev of Object.keys(hooks)) {
  if (!Array.isArray(hooks[ev])) continue;
  hooks[ev] = hooks[ev].map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
  if (!hooks[ev].length) delete hooks[ev];
}
if (!uninstall) for (const ev of EVENTS) (hooks[ev] = hooks[ev] || []).push({ hooks: [{ type: 'command', command }] });

if (Object.keys(hooks).length) config.hooks = hooks; else delete config.hooks;
if (!Object.keys(config).length && uninstall) { fs.unlinkSync(hooksPath); console.log('Removed ' + hooksPath); }
else {
  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');
  console.log(uninstall ? 'Virtual office hooks removed from ' + hooksPath : 'Virtual office hooks added to ' + hooksPath);
}
if (!uninstall) console.log('Review and trust the Virtual Office hooks with /hooks in Codex CLI. Existing VS Code chats remain visible through the Office activity reader.');
