// Adds (or removes, with --uninstall) the Virtual office hooks in your user-level Claude Code settings.
// Your existing settings are kept, and a backup copy is saved first.
const fs = require('fs');
const os = require('os');
const path = require('path');

const uninstall = process.argv.includes('--uninstall');
const settingsPath = path.join(process.env.OFFICE_HOME || os.homedir(), '.claude', 'settings.json');
const hookPath = path.join(__dirname, 'hook.js');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd', 'Notification'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const norm = s => String(s).replace(/\\/g, '/');
// Our hooks: this folder's hook.js and, unless --only-this (the uninstaller), older copies in a claude-office or
// ai-office folder. The uninstaller leaves other copies alone, like a repo checkout next to an installed copy.
const onlyThis = process.argv.includes('--only-this');
const isOurs = h => h && h.type === 'command' && Array.isArray(h.args) && h.args.some(a => norm(a) === norm(hookPath) || (!onlyThis && /\/(claude|ai)-office[^/]*\/hook\.js$/.test(norm(a))));

let settings = {};
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, 'utf8');
  try { settings = raw.trim() ? JSON.parse(raw) : {}; }
  catch (e) {
    console.error('Could not read ' + settingsPath + ' because it is not valid JSON. Nothing was changed.');
    console.error(e.message);
    process.exit(1);
  }
  const backup = settingsPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(settingsPath, backup);
  console.log('Backup saved: ' + backup);
} else {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
}

const hooks = settings.hooks || {};
for (const ev of Object.keys(hooks)) {
  if (!Array.isArray(hooks[ev])) continue;
  hooks[ev] = hooks[ev].map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
  if (!hooks[ev].length) delete hooks[ev];
}
if (!uninstall) {
  for (const ev of EVENTS) {
    // Node by its full path: a laptop with the installer's own copy of Node may not have "node" on its PATH.
    // The prompt hook runs in step (not async) so it can hand Claude the skill hint; it answers within about a second
    const group = { hooks: [ev === 'UserPromptSubmit'
      ? { type: 'command', command: process.execPath, args: [hookPath], timeout: 3 }
      : { type: 'command', command: process.execPath, args: [hookPath], async: true, timeout: 5 }] };
    if (TOOL_EVENTS.has(ev)) group.matcher = '*';
    (hooks[ev] = hooks[ev] || []).push(group);
  }
}
if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(uninstall ? 'Virtual office hooks removed from ' + settingsPath : 'Virtual office hooks added to ' + settingsPath);
if (!uninstall) console.log('Restart Claude Code (or open a new Claude Code session in VS Code) so it picks up the hooks.');
