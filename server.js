// Virtual office: local server that turns Claude Code, Codex, claude.ai and ChatGPT activity into office animations.
// No dependencies. Run with: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile, execFileSync } = require('child_process');
const config = require('./config');
const vscodeCodex = require('./app/vscode-codex');
const installation = require('./app/manage-installation').createManager({ root: __dirname });
let cfg = config.load();   // office name, your name, the team's names, colors and skills, working hours

const PORT = Number(process.env.PORT) || 4321;
const PAGE = path.join(__dirname, 'public', 'index.html');
const clients = new Set();
let teamsRunning = false;

function send(msg) {
  if (msg.type !== 'presence') remember(msg);
  const data = 'data: ' + JSON.stringify(msg) + '\n\n';
  for (const res of clients) res.write(data);
}

// ---------- Memory for newly opened office pages ----------
// A page opened later (the screensaver, a refresh, a second screen) gets recent history and current work.
// The bounded history is saved in the user's data folder so it also survives an office restart.
const HISTORY_MAX = 300, HISTORY_MS = 12 * 3600 * 1000;
const HISTORY_FILE = path.join(config.DATA, 'activity-history.json');
const history = [];                 // {t, msg}
try {
  // History lives in each user's data folder, never in the installed app or shipped files.
  if (fs.statSync(HISTORY_FILE).size < 2e6) {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(saved)) for (const item of saved.slice(-HISTORY_MAX)) {
      if (item && Number.isFinite(item.t) && item.t > Date.now() - HISTORY_MS && item.t <= Date.now() &&
          item.msg && typeof item.msg.type === 'string') {
        // Older versions stored the user's wording in activity history; keep only task status.
        if (item.msg.type === 'prompt') item.msg.label = 'New task';
        if (item.msg.type === 'start' && String(item.msg.key).startsWith('prompt:')) item.msg.label = 'Thinking';
        history.push(item);
      }
    }
  }
} catch { /* no saved history yet, or a damaged file */ }
let historyTimer;
function saveHistory() {
  if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
  try {
    fs.mkdirSync(config.DATA, { recursive: true });
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(history));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (e) { console.error('Could not save office activity history:', e.message); }
}
const now = { jobs: new Map(), prompt: null, ask: null, at: 0 };   // jobs: key -> {role, label}
function remember(msg) {
  history.push({ t: Date.now(), msg });
  while (history.length > HISTORY_MAX || (history.length && Date.now() - history[0].t > HISTORY_MS)) history.shift();
  if (!historyTimer) { historyTimer = setTimeout(saveHistory, 500); historyTimer.unref(); }
  now.at = Date.now();
  if (msg.type === 'prompt') now.prompt = { label: msg.label, source: msg.source };
  if (msg.type === 'start') now.jobs.set(msg.key, { role: msg.role, label: msg.label, bubble: msg.bubble });
  if (msg.type === 'end') now.jobs.delete(msg.key);
  // same rule as the page: a question waits until the next event that isn't a session event
  if (msg.type === 'ask') now.ask = msg.label; else if (msg.type !== 'session') now.ask = null;
  if (msg.type === 'stop') { now.jobs.clear(); now.prompt = null; }
}
function catchUp() {
  // after 15 quiet minutes, assume a "finished" event was missed rather than showing work that is long over
  const live = Date.now() - now.at < 15 * 60 * 1000;
  return { type: 'catchup', history, jobs: live ? [...now.jobs].map(([key, j]) => ({ key, ...j })) : [], prompt: live ? now.prompt : null, ask: live ? now.ask : null };
}

// ---------- Mapping Claude Code activity to team roles ----------
const RULES = [
  ['security', /secur|audit|vuln|owasp|semgrep|snyk|secret|\.env\b|pentest|\bcve|uu ?pdp|privacy|permission|encrypt|iso ?(27001|27701|42001)/],
  ['devops',   /sre-devops|cloud-architect|\bsre\b|devops|runbook|postmortem|terraform|pulumi|kubectl|kustomize|argocd|\bhelm\b|ansible|dockerfile|compose\.ya?ml|\.github\/workflows|gitlab-ci|grafana|prometheus|datadog|cloudflare|\.tf\b|\.tfvars\b|(^|[\\/ ])(infra|terraform|k8s|helm|charts|deploy|ops)[\\/]/],
  ['pm',       /\.(pptx|docx|xlsx|pdf)\b|:(pptx|docx|xlsx|pdf|docs)\b|claude_docs|google_drive/],
  ['qa',       /\btests?\b|\.test\.|\.spec\.|_test\.|tests?\/|jest|vitest|pytest|playwright|cypress|mocha|\bqa\b|e2e|coverage/],
  ['designer', /design|figma|\.svg\b|\.png\b|\.jpe?g\b|wireframe|mockup|\bux\b|style ?guide|tailwind\.config|theme\.|tokens?\./],
  ['frontend', /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)\b|frontend|components?\/|pages\/|\breact\b|next\.config|vite/],
  ['pm',       /\.md\b|readme|docs?\/|\bprd\b|roadmap|requirement|todowrite|taskcreate|taskupdate|\bplan\b|changelog|user stor/],
  ['devops',   /docker|dockerfile|compose\.ya?ml|kubernetes|\bk8s\b|kubectl|\bhelm\b|terraform|ansible|\.github\/workflows|gitlab-ci|jenkins|\bci\b|pipeline|deploy|nginx|systemd|\bgit (push|pull|tag|merge|rebase|remote)|\bgh (pr|release|workflow|repo|run)|vercel|netlify|\baws\b|gcloud|azure|grafana|prometheus|\.ya?ml\b|\bssh\b/],
  ['backend',  /\.(py|go|rb|php|java|kt|cs|rs|sql|prisma|ts|js|mjs|cjs)\b|backend|server|\bapi\b|routes?\/|controller|migration|database|\bdb\b/]
];
// Who picks up your prompt as soon as you send it (English and Indonesian keywords). First match wins.
// No match: the Manager owns it and does the thinking, and team members join as Claude Code edits files or runs commands.
const PROMPT_RULES = [
  ['security', /secur|keamanan|audit|vuln|kerentanan|pentest|owasp|uu ?pdp|privacy|privasi|iso ?(27001|27701|42001)|encrypt|enkripsi|access control|hak akses|phishing|malware/],
  ['devops',   /\bsre\b|site reliability|devops|deploy|rollout|rollback|release|\bslo\b|\bsli\b|error budget|on-?call|incident|insiden|outage|downtime|server down|gangguan|postmortem|post-mortem|runbook|kubernetes|\bk8s\b|terraform|ansible|\bhelm\b|ci\/cd|pipeline|infra|infrastruktur|observability|monitoring|alerting|\balert|uptime|latency|load balanc|autoscal|scaling|capacity|disaster recovery|failover|backup|\bcloud\b|\baws\b|azure|\bgcp\b|docker|container|nginx|\bdns\b|\bssl\b|certificate|sertifikat|hosting|server setup|provisioning/],
  ['pm',       /\bdocs?\b|document|dokumen|\.?docx?\b|\bword\b|\bppt|slides?\b|\bdeck\b|presenta|presentasi|\breport|laporan|excel|xlsx|spreadsheet|\bpdf\b|\bmemo\b|email|surat|kebijakan|policy|\bsop\b|standar|prosedur|procedure|notulen|minutes|proposal|roadmap|requirement|\bprd\b|user stor|\bplan\b|rencana|summar|ringkas|rangkum|research|riset|readme|onboarding|townhall|\bbod\b|\bboc\b/],
  ['qa',       /\btests?\b|testing|\bqa\b|\buji\b|pengujian|\bbug|regress|e2e|coverage|verify|verifikasi|tidak tercatat|tidak muncul|ga ada aktivitas|not recorded|not showing/],
  ['designer', /design|desain|figma|mockup|wireframe|\bux\b|\bui\b|logo|\bicon|ikon|colou?r|warna|theme|tema|font|tampilan|gambar|image|illustrat/],
  ['frontend', /frontend|front-end|\bhtml|\bcss|react|\bvue\b|web ?page|halaman|button|tombol|\btag\b|bubble|screen|layar|canvas|animat|animasi|layout|browser|extension/],
  ['devops',   /devops|deploy|docker|kubernetes|\bk8s\b|\bci\b|ci\/cd|pipeline|github actions|release|\bpush\b|\bgit\b|github|vercel|netlify|\bcloud\b|\baws\b|azure|\bgcp\b|infra|infrastruktur|monitoring|uptime|hosting|domain|\bdns\b|\bssl\b|install|setup|startup|screensaver/],
  ['backend',  /backend|back-end|\bapi\b|server|database|\bdb\b|\bsql\b|endpoint|script|hook|config|\bnpm\b|node|python|integrat|integrasi/]
];
// "QA: check the login", "@Sari check the login": the prompt names a team member (role, title or their name)
function namedRole(prompt) {
  const m = /^\s*@?([^:,\n]{1,40}?)\s*[:,]/.exec(String(prompt || '')) || /^\s*@(\S{1,40})/.exec(String(prompt || ''));
  if (!m) return null;
  const want = m[1].trim().toLowerCase();
  const r = config.ROLES.find(r => [r.id, r.title, cfg.team[r.id].name].some(n => n.toLowerCase() === want));
  return r ? r.id : null;
}
function promptRole(prompt) {
  const named = namedRole(prompt);
  if (named) return named;
  const text = String(prompt || '').toLowerCase();
  for (const [role, re] of PROMPT_RULES) if (re.test(text)) return role;
  return null;
}

const FALLBACK ={ Read: 'pm', Grep: 'pm', Glob: 'pm', WebSearch: 'pm', WebFetch: 'pm', Bash: 'backend', PowerShell: 'backend' };

const base = p => String(p || '').split(/[\\/]/).pop();
const short = (s, n = 42) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Codex edits files with apply_patch; the patch text names the files ("*** Update File: src/app.tsx")
const patchFiles = input => [...JSON.stringify(input || {}).matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\\"\n]+)/g)].map(m => m[1].trim());

function roleFor(name, input = {}) {
  const skill = name === 'Skill' && (input.skill || input.name || input.command);
  const owner = skill && config.ROLES.find(r => cfg.team[r.id].skill === String(skill).replace(/^\//, ''));
  if (owner) return owner.id;
  const text = [name, input.file_path, input.path, input.notebook_path, typeof input.command === 'string' && name !== 'apply_patch' ? input.command : '',
    input.skill, input.subagent_type, input.description, input.pattern, input.url, input.query, ...(name === 'apply_patch' ? patchFiles(input) : [])]
    .filter(Boolean).join(' ').toLowerCase();
  for (const [role, re] of RULES) if (re.test(text)) return role;
  return FALLBACK[name] || 'backend';
}
function labelFor(name, input = {}) {
  const file = base(input.file_path || input.notebook_path || input.path);
  switch (name) {
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'Editing ' + (file || 'a file');
    case 'Write': return 'Writing ' + (file || 'a file');
    case 'apply_patch': { const f = patchFiles(input); return 'Editing ' + (f.length ? base(f[0]) + (f.length > 1 ? ' +' + (f.length - 1) : '') : 'files'); }
    case 'Read': return 'Reading ' + (file || 'a file');
    case 'Bash': case 'PowerShell': return 'Running ' + short(input.command, 30);
    case 'Grep': return 'Searching “' + short(input.pattern, 24) + '”';
    case 'Glob': return 'Finding ' + short(input.pattern, 28);
    case 'WebSearch': return 'Researching ' + short(input.query, 28);
    case 'WebFetch': return 'Reading a web page';
    case 'Skill': return 'Using skill ' + short(input.skill || input.name, 26);
    case 'Task': case 'Agent': return 'Subagent: ' + short(input.description || input.subagent_type, 28);
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return 'Updating the task list';
    default: return name.startsWith('mcp__') ? 'Using ' + name.split('__').slice(1).join(' ') : short(name, 30);
  }
}
const keyFor = ev => ev.tool_use_id || [ev.session_id, ev.tool_name, JSON.stringify(ev.tool_input || {}).slice(0, 300)].join('|');

// Tools where Claude stops and asks you something instead of doing work
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
function askLabel(name, input = {}) {
  if (name === 'ExitPlanMode') return 'Plan ready, waiting for your approval';
  const q = Array.isArray(input.questions) && input.questions[0] && input.questions[0].question;
  return 'Question for you: ' + short(q || 'Claude needs your answer', 60);
}

// session_id -> who owns the current prompt: a team member, or MANAGER when no member fits it.
// The owner keeps a 'prompt:' job until Claude finishes, and the page shows them thinking whenever no tool is running.
const MANAGER = 'manager';
const owners = new Map();
// claude.ai and ChatGPT show their work as a list of steps ("Sharepoint search", "Ran a command", a thinking summary).
// The extension sends each new step. It goes to the team member it's about, else whoever owns the prompt.
const steps = new Map(); // session_id -> key of the step being shown
const STEP_RULES = [
  ['pm',      /search|cari|read|baca|resource|fetch|browse|web|sharepoint|drive|notion|mail/],
  ['backend', /\bran\b|command|perintah|running|script|code|kode/]
];
function stepRole(text, owner) {
  const role = promptRole(text);
  if (role || owner) return role || owner;
  const t = String(text || '').toLowerCase();
  for (const [r, re] of STEP_RULES) if (re.test(t)) return r;
  return 'pm';
}
const SOURCES = { codex: 'Codex', chatgpt: 'ChatGPT', claude: 'claude.ai' };
// Added to your prompt (Claude Code and Codex only, through the hook): which member it fits and their skill, plus the
// other members' skills for a request that touches more than one area. Only skills that are actually installed are named.
function skillHint(ev) {
  if (!cfg.skillHint || ev.hook_event_name !== 'UserPromptSubmit') return null;
  const tool = ev.source === 'codex' ? 'codex' : ev.source ? null : 'claude';
  if (!tool) return null;
  const role = owners.get(ev.session_id);
  const ready = config.ROLES.filter(r => config.installedIn(tool, cfg.team[r.id].skill));
  const lead = role && ready.find(r => r.id === role);
  if (!lead) return null;
  const m = cfg.team[lead.id];
  const others = ready.filter(r => r !== lead).map(r => `${cfg.team[r.id].skill} (${r.title})`).join(', ');
  return `[${cfg.officeName}] This request fits ${m.name} (${lead.title}). Use the ${m.skill} skill for it.` +
    (others ? ` If it also touches another area, use that member's skill as well: ${others}.` : '');
}
// The same hint for ChatGPT and claude.ai (opt-in in Setup): the Chrome extension asks while you type and adds it to the end of
// your message as you send it. Those sites don't tell the office which skills you uploaded there, so it says "if you have it".
function webHint(prompt) {
  if (!cfg.webHint) return null;
  const role = promptRole(prompt);
  if (!role) return null;
  const m = cfg.team[role], r = config.ROLES.find(x => x.id === role);
  return `(${cfg.officeName}: this fits ${m.name}, ${r.title}. Use the ${m.skill} skill if you have it.)`;
}
function toMessages(ev) {
  const msgs = eventMessages(ev), source = SOURCES[ev.source] || 'Claude Code';
  msgs.forEach(m => { if (m.type === 'prompt' || m.type === 'stop') m.source = source; });
  return msgs;
}
function eventMessages(ev) {
  const t = ev.hook_event_name;
  switch (t) {
    case 'UserPromptSubmit': {
      // The previous prompt never finished (interrupted with Esc, or its "finished" event got lost): close it first,
      // so its owner doesn't keep thinking next to the new one
      const msgs = owners.has(ev.session_id) ? [{ type: 'end', key: 'prompt:' + ev.session_id }] : [];
      const role = promptRole(ev.prompt) || MANAGER;
      owners.set(ev.session_id, role);
      msgs.push({ type: 'prompt', label: 'New task' }, { type: 'start', role, label: 'Thinking', key: 'prompt:' + ev.session_id });
      return msgs;
    }
    case 'PreToolUse': {
      if (ASK_TOOLS.has(ev.tool_name)) return [{ type: 'ask', label: askLabel(ev.tool_name, ev.tool_input) }];
      return [{ type: 'start', role: roleFor(ev.tool_name, ev.tool_input), label: labelFor(ev.tool_name, ev.tool_input), key: keyFor(ev) }];
    }
    case 'PostToolUse': case 'PostToolUseFailure':
      return ASK_TOOLS.has(ev.tool_name) ? [{ type: 'answered' }] : [{ type: 'end', key: keyFor(ev) }];
    case 'PermissionRequest': return [{ type: 'ask', label: 'Needs your permission' }];
    case 'Notification':
      // Claude is waiting on you to allow a tool. Other notifications (like "waiting for input" after it finished) are covered by Stop.
      return ev.notification_type === 'permission_prompt' || /permission/i.test(ev.message || '')
        ? [{ type: 'ask', label: 'Needs your permission' + (ev.message ? ': ' + short(ev.message, 50) : '') }] : [];
    case 'SubagentStart': return [{ type: 'start', role: roleFor('Agent', { subagent_type: ev.agent_type }), label: 'Subagent: ' + short(ev.agent_type, 28), key: 'agent:' + ev.agent_id }];
    case 'SubagentStop': return [{ type: 'end', key: 'agent:' + ev.agent_id }];
    case 'Step': {
      // The previous step is done; this one starts. Full text for the logs, a short one for the speech bubble.
      if (!/\p{L}/u.test(ev.step || '')) return []; // just an icon, no words
      const prev = steps.get(ev.session_id), key = 'step:' + ev.session_id + ':' + Date.now();
      const owner = owners.get(ev.session_id);
      const role = ev.tool_name ? roleFor(ev.tool_name, ev.tool_input) : stepRole(ev.step, owner === MANAGER ? null : owner);
      steps.set(ev.session_id, key);
      const msgs = prev ? [{ type: 'end', key: prev }] : [];
      msgs.push({ type: 'start', role, label: short(ev.step, 70), bubble: short(ev.step, 24), key });
      return msgs;
    }
    case 'Stop': case 'Interrupt': owners.delete(ev.session_id); steps.delete(ev.session_id); return [{ type: 'stop' }];
    case 'SessionEnd': {
      // A session closed in the middle of a request never sends "finished": end its thinking and its last step here
      const msgs = owners.has(ev.session_id) ? [{ type: 'end', key: 'prompt:' + ev.session_id }] : [];
      if (steps.has(ev.session_id)) msgs.push({ type: 'end', key: steps.get(ev.session_id) });
      owners.delete(ev.session_id); steps.delete(ev.session_id);
      return msgs.concat({ type: 'session', label: (ev.source === 'codex' ? 'Codex' : 'Claude Code') + ' session ended' });
    }
    case 'SessionStart': return [{ type: 'session', label: (ev.source === 'codex' ? 'Codex' : 'Claude Code') + ' session started' }];
    default: return [];
  }
}

// ---------- Microsoft Teams detection ----------
function checkTeams() {
  const done = running => {
    if (running !== teamsRunning) { teamsRunning = running; send({ type: 'presence', teams: running }); console.log('Teams ' + (running ? 'is running' : 'is closed')); }
  };
  if (process.platform === 'win32') {
    exec('tasklist /FO CSV /NH', { windowsHide: true }, (err, out) => done(!err && /"(ms-teams|teams)\.exe"/i.test(out)));
  } else if (process.platform === 'darwin') {
    // -x matches the process name only, so this check never matches itself
    exec('pgrep -x MSTeams || pgrep -x "Microsoft Teams" || pgrep -x "Microsoft Teams classic"', (err, out) => done(!err && out.trim().length > 0));
  } else {
    exec('pgrep -ix "teams|teams-for-linux"', (err, out) => done(!err && out.trim().length > 0));
  }
}
setInterval(checkTeams, 10000); checkTeams();

// ---------- Test sequence ----------
function testRun() {
  const sid = 'test-' + Date.now();
  const steps = [
    [0,    { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'Test: add a login page with an API and tests' }],
    [1500, { hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 't1', tool_name: 'Write', tool_input: { file_path: 'docs/login-prd.md' } }],
    [4500, { hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 't1', tool_name: 'Write' }],
    [5000, { hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 't2', tool_name: 'Edit', tool_input: { file_path: 'src/components/LoginForm.tsx' } }],
    [5200, { hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 't3', tool_name: 'Write', tool_input: { file_path: 'server/routes/auth.py' } }],
    [9000, { hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 't2', tool_name: 'Edit' }],
    [9500, { hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 't3', tool_name: 'Write' }],
    [10000, { hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 't4', tool_name: 'Bash', tool_input: { command: 'npm test -- login.test.ts' } }],
    [10200, { hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 't5', tool_name: 'Bash', tool_input: { command: 'npm audit --omit=dev' } }],
    [14000, { hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 't4', tool_name: 'Bash' }],
    [14500, { hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 't5', tool_name: 'Bash' }],
    [15500, { hook_event_name: 'Stop', session_id: sid }]
  ];
  steps.forEach(([ms, ev]) => setTimeout(() => toMessages(ev).forEach(send), ms));
}

// ---------- Settings and Setup ----------
const json = (res, data) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const publicConfig = () => ({ officeName: cfg.officeName, manager: cfg.manager, hours: cfg.hours, breaks: cfg.breaks, skillHint: cfg.skillHint, webHint: cfg.webHint, team: cfg.team, firstRun: !!cfg.firstRun });
const HOME = process.env.OFFICE_HOME || os.homedir();
// Are the office's hooks in Claude Code's settings, and is the prompt hook able to add the skill hint (not async)?
let extensionSeen = null;   // the Chrome extension's last check-in: {version, site, at}
let extensionReconnect = null; // a short-lived request picked up by the extension's Chrome alarm
let extensionReconnectId = 0;
// Codex: are this office's hooks in ~/.codex/hooks.json?
function codexHookStatus() {
  try {
    const hooks = JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'hooks.json'), 'utf8')).hooks || {};
    const me = path.join(__dirname, 'hook.js').replace(/\\/g, '/');
    return (hooks.UserPromptSubmit || []).some(g => (g.hooks || []).some(h => {
      const command = String(h.command || '');
      const encoded = /-EncodedCommand\s+([A-Za-z0-9+/=]+)/i.exec(command);
      const readable = encoded ? Buffer.from(encoded[1], 'base64').toString('utf16le') : command;
      return readable.replace(/\\/g, '/').includes(me);
    }));
  } catch { return false; }
}
function hookStatus() {
  try {
    const hooks = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8')).hooks || {};
    const me = path.join(__dirname, 'hook.js').replace(/\\/g, '/');
    const mine = t => String(t).replace(/\\/g, '/').includes(me);
    const ours = g => (g.hooks || []).some(h => (h.args || []).some(mine) || mine(h.command || ''));
    const prompt = (hooks.UserPromptSubmit || []).find(ours);
    return { installed: !!prompt, hint: !!prompt && !prompt.hooks.some(h => h.async) };
  } catch { return { installed: false, hint: false }; }
}
// Is this the copy the installer put on this laptop (rather than a folder someone runs by hand)?
function installedHere() {
  try { return path.resolve(JSON.parse(fs.readFileSync(path.join(config.DATA, 'install.json'), 'utf8')).app) === path.resolve(__dirname); } catch { return false; }
}
function setupData() {
  return {
    version: require('./package.json').version,
    config: publicConfig(),
    roles: config.ROLES.map(r => {
      const skill = cfg.team[r.id].skill;
      return { id: r.id, title: r.title, text: config.skillText(skill) || '', template: config.templateText(skill) || config.templateText(r.skill) || '',
        installed: { claude: config.installedIn('claude', skill), codex: config.installedIn('codex', skill) } };
    }),
    tools: { claude: config.TOOLS.claude.present(), codex: config.TOOLS.codex.present() },
    hooks: hookStatus(),
    codexHooks: codexHookStatus(),
    extension: extensionSeen && Date.now() - extensionSeen.at < 120000
      ? { ...extensionSeen, ago: Math.round((Date.now() - extensionSeen.at) / 60000) } : null,
    extensionDir: path.join(__dirname, 'extension'),
    installed: installedHere()
  };
}
function saveSetup(body) {
  cfg = { ...config.save(body.config || {}), firstRun: false };
  const report = [];
  // your edits to each member's skill (left out when it's the unchanged template, so template updates still reach you)
  for (const r of config.ROLES) {
    const name = cfg.team[r.id].skill, text = body.skills && body.skills[r.id];
    if (typeof text === 'string' && text.trim() && text.replace(/\r\n/g, '\n') !== config.templateText(name)) config.saveSkillText(name, text);
  }
  const tools = ['claude', 'codex'].filter(t => body.install && body.install[t]);
  report.push(...config.installSkills(cfg, tools));
  // Claude Code and Codex hooks, with the same installers as "npm run hooks:install" / "codex:install"
  const run = (script, label) => {
    try { report.push({ hooks: label, output: execFileSync(process.execPath, [path.join(__dirname, script)], { encoding: 'utf8', env: { ...process.env } }).trim() }); }
    catch (e) { report.push({ hooks: label, error: String(e.stderr || e.message).trim() }); }
  };
  if (body.install && body.install.hooks) run('install.js', 'Claude Code');
  if (body.install && body.install.codexHooks) run('install-codex.js', 'Codex');
  // an installed office: shortcuts, screensaver and the app list follow a new office name
  if (installedHere()) {
    try { report.push({ rename: execFileSync(process.execPath, [path.join(__dirname, 'app', 'apply-name.js')], { encoding: 'utf8' }).trim() }); }
    catch (e) { report.push({ hooks: 'Shortcuts', error: String(e.stderr || e.message).trim().split('\n').pop() }); }
  }
  send({ type: 'config', config: publicConfig() });
  console.log(new Date().toLocaleTimeString(), 'Settings saved from the Setup page');
  return { ok: true, report, data: setupData() };
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Only requests addressed to this laptop itself. Stops "DNS rebinding", where a website points its own domain at
  // 127.0.0.1 to read or change the office through the visitor's browser.
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || '')) { res.writeHead(403); return res.end('Forbidden'); }
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    fs.readFile(PAGE, (err, buf) => {
      if (err) { res.writeHead(500); return res.end('Missing public/index.html'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }
  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify({ type: 'presence', teams: teamsRunning }) + '\n\n');
    res.write('data: ' + JSON.stringify(catchUp()) + '\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  // The extension asks for the ChatGPT / claude.ai skill hint while you type. Read-only: the text is not kept, logged or shown.
  if (req.method === 'POST' && url === '/hint') {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end(); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e5) req.destroy(); });
    req.on('end', () => {
      let hint = null;
      try { hint = webHint(String(JSON.parse(body).prompt || '')); } catch { /* ignore malformed input */ }
      if (hint) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ hint })); }
      res.writeHead(204); res.end();
    });
    return;
  }
  if (req.method === 'POST' && url === '/hook') {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end(); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const ev = JSON.parse(body);
        if (ev.source === 'codex' && !ev.vscodeFallback) vscodeWatcher?.ignore(ev.session_id);
        const msgs = toMessages(ev);
        msgs.forEach(send);
        if (msgs.length) console.log(new Date().toLocaleTimeString(), '[' + (SOURCES[ev.source] || 'Claude Code') + ']', ev.hook_event_name, msgs.map(m => m.role ? m.role + ': ' + m.label : m.type).join(', '));
        if (ev.hook_event_name === 'ExtensionHello') {
          const reconnectId = Number(ev.reconnectId) || 0;
          extensionSeen = { version: String(ev.version || '').slice(0, 20), site: String(ev.site || '').slice(0, 60), at: Date.now(), reconnectId };
          if (extensionReconnect && reconnectId === extensionReconnect.id) extensionReconnect = null;
        }
        const context = skillHint(ev);
        if (context) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ context })); }
      } catch { /* ignore malformed input */ }
      res.writeHead(204); res.end();
    });
    return;
  }
  if (req.method === 'GET' && url === '/config') return json(res, publicConfig());
  if (req.method === 'GET' && url === '/setup') {
    return fs.readFile(path.join(__dirname, 'public', 'setup.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('Missing public/setup.html'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(buf);
    });
  }
  if (req.method === 'GET' && url === '/setup/data') return json(res, setupData());
  if (req.method === 'GET' && url === '/extension/control') {
    return json(res, { reconnectId: extensionReconnect && Date.now() - extensionReconnect.at < 90000 ? extensionReconnect.id : 0 });
  }
  if (req.method === 'POST' && url === '/setup/extension/reconnect' && req.headers['x-office'] === 'setup') {
    extensionReconnect = { id: ++extensionReconnectId, at: Date.now() };
    return json(res, { reconnectId: extensionReconnect.id });
  }
  if (req.method === 'POST' && url.startsWith('/setup/app/') && req.headers['x-office'] === 'setup') {
    const fail = (code, message) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: message })); };
    if (!installedHere() || !installation.installed()) return fail(409, 'App update and uninstall are available from the installed office.');
    if (url === '/setup/app/select-update') {
      installation.select().then(value => json(res, value)).catch(e => fail(400, e.message));
      return;
    }
    if (url === '/setup/app/run-update') {
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) return fail(415, 'JSON is required.');
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1024) req.destroy(); });
      req.on('end', () => {
        let token;
        try { token = JSON.parse(body).token; } catch { return fail(400, 'Invalid update request.'); }
        installation.run(token).then(() => json(res, { opened: true })).catch(e => fail(400, e.message));
      });
      return;
    }
    if (url === '/setup/app/uninstall') {
      installation.uninstall().then(() => json(res, { opened: true })).catch(e => fail(500, e.message));
      return;
    }
    return fail(404, 'Unknown action.');
  }
  if (req.method === 'POST' && url === '/setup/open-extension' && req.headers['x-office'] === 'setup') {
    execFile('explorer.exe', [path.join(__dirname, 'extension')], { windowsHide: true }, () => {});
    res.writeHead(204); return res.end();
  }
  const zipName = req.method === 'GET' && /^\/skills\/([a-z0-9][a-z0-9-]{0,63})\.zip$/.exec(url);
  if (zipName) {
    const z = config.skillZip(zipName[1]);
    if (!z) { res.writeHead(404); return res.end('No such skill'); }
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + zipName[1] + '.zip"' });
    return res.end(z);
  }
  // Saving settings changes files on this laptop, so like /shutdown it needs a header only the office's own pages send
  if (req.method === 'POST' && url === '/setup' && req.headers['x-office'] === 'setup') {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end(); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try { json(res, saveSetup(JSON.parse(body))); }
      catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (req.method === 'POST' && url === '/test' && req.headers['x-office'] === 'test') { testRun(); res.writeHead(204); return res.end(); }
  // The office page's "Server on · click to stop" button. The custom header means only the office page itself can
  // send this: browsers block other websites from adding it to a request to this server.
  if (req.method === 'POST' && url === '/shutdown' && req.headers['x-office'] === 'stop') {
    console.log(new Date().toLocaleTimeString(), 'Stopped from the office page');
    saveHistory();
    res.writeHead(204); res.end();
    for (const c of clients) c.end();
    setTimeout(() => process.exit(0), 300);
    return;
  }
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, teams: teamsRunning, viewers: clients.size })); }
  res.writeHead(404); res.end('Not found');
});

// Local hooks have priority. The VS Code fallback only reads the extension's own state and log,
// and stays off in isolated test homes unless test paths are supplied explicitly.
const vscodeWatcher = process.platform === 'win32' && process.env.OFFICE_VSCODE_WATCH !== '0' &&
  (!process.env.OFFICE_HOME || process.env.OFFICE_VSCODE_STATE)
  ? vscodeCodex.start(ev => {
      if (ev.hook_event_name === 'Stop') {
        owners.delete(ev.session_id);
        const step = steps.get(ev.session_id);
        steps.delete(ev.session_id);
        if (step) send({ type: 'end', key: step });
        send({ type: 'end', key: 'prompt:' + ev.session_id });
        if (!now.jobs.size) send({ type: 'stop', source: 'Codex' });
        console.log(new Date().toLocaleTimeString(), '[Codex VS Code] Stop');
        return;
      }
      const msgs = toMessages(ev);
      msgs.forEach(send);
      if (msgs.length) console.log(new Date().toLocaleTimeString(), '[Codex VS Code]', ev.hook_event_name,
        msgs.map(m => m.role ? m.role + ': ' + m.label : m.type).join(', '));
    }, { stateFile: process.env.OFFICE_VSCODE_STATE, logsRoot: process.env.OFFICE_VSCODE_LOGS,
    codexLogsFile: process.env.OFFICE_VSCODE_CODEX_LOGS, rolloutsRoot: process.env.OFFICE_VSCODE_ROLLOUTS }) : null;

server.listen(PORT, '127.0.0.1', () => {
  console.log(cfg.officeName + ' is running at http://localhost:' + PORT + (cfg.firstRun ? '  (first time? open http://localhost:' + PORT + '/setup)' : ''));
  console.log('Keep this window open. Press Ctrl+C to stop.');
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error('Port ' + PORT + ' is already in use. Is the office already running?');
  else console.error(err);
  process.exit(1);
});
