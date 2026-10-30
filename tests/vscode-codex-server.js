// End-to-end fallback check against a temporary office and synthetic VS Code storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-vscode-server-'));
const home = path.join(temp, 'home'), data = path.join(temp, 'data');
const stateFile = path.join(temp, 'state.vscdb'), logsRoot = path.join(temp, 'logs');
const codexLogsFile = path.join(temp, 'logs_2.sqlite');
const rolloutsRoot = path.join(temp, 'sessions');
const id = '12345678-1234-1234-1234-123456789abc';
const today = new Date();
const rolloutFile = path.join(rolloutsRoot, String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0'), `rollout-${id}.jsonl`);
const origin = 'http://127.0.0.1:4399';
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
fs.mkdirSync(logsRoot);
fs.mkdirSync(path.dirname(rolloutFile), { recursive: true });
fs.writeFileSync(rolloutFile, JSON.stringify({ type: 'session_meta', payload: { id, originator: 'codex_vscode' } }) + '\n');
const db = new DatabaseSync(stateFile);
const codexDb = new DatabaseSync(codexLogsFile);
codexDb.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, target TEXT, feedback_log_body TEXT)');
db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
function save(list) {
  db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('openai.chatgpt',
    JSON.stringify({ 'persisted-atom-state': { 'prompt-history': { [id]: list } } }));
}
save(['Old prompt']);
let server, error = '';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function catchup() {
  const controller = new AbortController();
  const response = await fetch(origin + '/events', { signal: controller.signal });
  const { value } = await response.body.getReader().read();
  controller.abort();
  return JSON.parse(new TextDecoder().decode(value).split('\n').find(line => line.includes('"type":"catchup"')).slice(6));
}
async function launch() {
  server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true,
    env: { ...process.env, PORT: '4399', OFFICE_HOME: home, OFFICE_DATA: data,
      OFFICE_VSCODE_STATE: stateFile, OFFICE_VSCODE_LOGS: logsRoot,
      OFFICE_VSCODE_CODEX_LOGS: codexLogsFile, OFFICE_VSCODE_ROLLOUTS: rolloutsRoot }, stdio: ['ignore', 'ignore', 'pipe'] });
  server.stderr.on('data', chunk => { error += chunk.toString(); });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error('Server exited: ' + error);
    try { if ((await fetch(origin + '/health')).ok) { ready = true; break; } } catch { await wait(100); }
  }
  assert(ready, 'isolated server started');
}
(async () => {
  await launch();
  assert.equal((await catchup()).history.length, 0, 'history starts empty');
  save(['Old prompt', 'Can you handle this?']);
  await wait(2300);
  let state = await catchup();
  assert.equal(state.prompt?.source, 'Codex');
  assert.equal(state.prompt?.label, 'New task');
  assert(state.jobs.some(job => job.role === 'manager'), 'the manager thinks about a prompt no member fits');
  save(['Old prompt', 'Can you handle this?', 'QA: test activity']);
  await wait(2300);
  state = await catchup();
  assert(state.jobs.some(job => job.role === 'qa'), 'QA is working');
  assert(!state.jobs.some(job => job.role === 'manager'), 'previous prompt is finished');
  codexDb.prepare('INSERT INTO logs (ts, target, feedback_log_body) VALUES (?, ?, ?)').run(
    Math.floor(Date.now() / 1000),
    'codex_core::stream_events_utils',
    `session_loop{thread_id=${id}}: ToolCall: exec await tools.exec_command({cmd:"Get-Content HANDOFF.md"})`);
  await wait(2300);
  state = await catchup();
  assert(state.history.some(item => item.msg.type === 'start' && item.msg.label.includes('Get-Content')),
    'command appears in the existing chat history');
  codexDb.prepare('INSERT INTO logs (ts, target, feedback_log_body) VALUES (?, ?, ?)').run(
    Math.floor(Date.now() / 1000), 'codex_core::session::turn',
    `session_loop{thread_id=${id}}:turn{thread.id=${id}}: needs_follow_up=false`);
  await wait(2300);
  state = await catchup();
  assert.equal(state.jobs.length, 0, 'Codex completion clears prompt and final step');
  assert.equal(state.prompt, null, 'Codex completion clears current request');
  assert(state.history.some(item => item.msg.type === 'stop' && item.msg.source === 'Codex'),
    'Codex completion is recorded as a finished task');
  const claude = await fetch(origin + '/hook', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-test', prompt: 'Backend: check the API' }) });
  assert([200, 204].includes(claude.status), 'Claude hook still works');
  state = await catchup();
  assert(state.history.some(item => item.msg.type === 'prompt' && item.msg.label === 'New task'),
    'Claude and Codex prompt history stores a generic label');
  await fetch(origin + '/shutdown', { method: 'POST', headers: { 'X-Office': 'stop' } });
  for (let i = 0; i < 20 && server.exitCode === null; i++) await wait(100);
  assert.notEqual(server.exitCode, null, 'first server stopped');
  await launch();
  state = await catchup();
  assert(state.history.some(item => item.msg.type === 'start' && item.msg.role === 'qa'), 'team activity survives restart');
  assert(state.history.some(item => item.msg.type === 'prompt' && item.msg.source === 'Claude Code'), 'Claude activity survives restart');
  save(['Old prompt', 'Can you handle this?', 'QA: test activity', 'Backend: continue in this chat']);
  await wait(2300);
  state = await catchup();
  assert(state.jobs.some(job => job.role === 'backend'), 'same Codex thread starts new work after Office restarts');
  fs.appendFileSync(rolloutFile, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
  await wait(2300);
  state = await catchup();
  assert.equal(state.jobs.length, 0, 'same Codex thread finishes through the rollout event');
  console.log('VS Code Codex server integration: OK');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (server && server.exitCode === null) {
    try { await fetch(origin + '/shutdown', { method: 'POST', headers: { 'X-Office': 'stop' } }); } catch { server.kill(); }
  }
  db.close();
  codexDb.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
