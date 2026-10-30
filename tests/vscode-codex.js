const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { start, toolSteps } = require('../app/vscode-codex');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-vscode-test-'));
const stateFile = path.join(root, 'state.vscdb');
const logsRoot = path.join(root, 'logs');
const logFile = path.join(logsRoot, 'test', 'window1', 'exthost', 'openai.chatgpt', 'Codex.log');
const codexLogsFile = path.join(root, 'logs_2.sqlite');
const id = '12345678-1234-1234-1234-123456789abc';
const now = new Date(Date.now() - 5 * 86400000); // an old chat continued today
const rolloutsRoot = path.join(root, 'sessions');
const rolloutFile = path.join(rolloutsRoot, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'), `rollout-${id}.jsonl`);
fs.mkdirSync(path.dirname(logFile), { recursive: true });
fs.mkdirSync(path.dirname(rolloutFile), { recursive: true });
fs.writeFileSync(logFile, '');
fs.writeFileSync(rolloutFile, JSON.stringify({ type: 'session_meta', payload: { id, originator: 'codex_vscode' } }) + '\n');
const db = new DatabaseSync(stateFile);
const codexDb = new DatabaseSync(codexLogsFile);
codexDb.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, target TEXT, feedback_log_body TEXT)');
db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
function save(list) {
  db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('openai.chatgpt',
    JSON.stringify({ 'persisted-atom-state': { 'prompt-history': { [id]: list } } }));
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const events = [];
  save(['Old prompt']);
  const watcher = start(ev => events.push(ev), { stateFile, logsRoot, codexLogsFile, rolloutsRoot, intervalMs: 20, idleMs: 100 });
  assert(watcher);
  await wait(40);
  assert.equal(events.length, 0, 'old prompts must not replay');
  save(['Old prompt', 'QA: test activity']);
  await wait(50);
  assert.equal(events[0]?.hook_event_name, 'UserPromptSubmit');
  assert.equal(events[0]?.prompt, 'QA: test activity');
  codexDb.prepare('INSERT INTO logs (ts, target, feedback_log_body) VALUES (?, ?, ?)').run(
    Math.floor(Date.now() / 1000),
    'codex_core::stream_events_utils',
    `session_loop{thread_id=${id}}: ToolCall: exec const r=await tools.exec_command({cmd:"Get-Content HANDOFF.md"});`);
  await wait(50);
  assert.equal(events[1]?.hook_event_name, 'Step', 'tool activity reaches the existing chat');
  assert.equal(events[1]?.tool_input.command, 'Get-Content HANDOFF.md');
  fs.appendFileSync(rolloutFile, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
  await wait(50);
  assert.equal(events[2]?.hook_event_name, 'Stop', 'rollout completion stops the same chat promptly');
  codexDb.prepare('INSERT INTO logs (ts, target, feedback_log_body) VALUES (?, ?, ?)').run(
    Math.floor(Date.now() / 1000), 'codex_core::session::turn',
    `session_loop{thread_id=${id}}:turn{thread.id=${id}}: model_needs_follow_up=false has_pending_input=false needs_follow_up=false`);
  await wait(50);
  assert.equal(events.length, 3, 'a later SQLite completion must not duplicate Stop');
  fs.appendFileSync(logFile, `2026-10-29 13:00:00 [info] Reasoning summary item completed threadId=${id} turnId=abc\n`);
  await wait(50);
  assert.equal(events.length, 2 + 1, 'a late reasoning log cannot restart completed work');
  await wait(140);
  assert.equal(events.length, 3, 'completion must not fire again after the idle timeout');
  watcher.ignore(id);
  save(['Old prompt', 'QA: test activity', 'Another prompt']);
  await wait(50);
  assert.equal(events.length, 3, 'local hook sessions must suppress fallback');
  assert.deepEqual(toolSteps('ToolCall: exec await tools.exec_command({cmd:"npm test"})').map(x => x.tool_input.command), ['npm test']);
  assert.deepEqual(toolSteps('ToolCall: exec await tools.exec_command({cmd:process.env.SECRET})'), []);
  watcher.close();
  const completedOnRestart = [];
  const watcher2 = start(ev => completedOnRestart.push(ev), { stateFile, logsRoot, codexLogsFile, rolloutsRoot, intervalMs: 20, idleMs: 100 });
  assert.equal(completedOnRestart.length, 0, 'finished chat must not replay when Office restarts');
  watcher2.close();
  fs.appendFileSync(rolloutFile, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
  const resumed = [];
  const watcher3 = start(ev => resumed.push(ev), { stateFile, logsRoot, codexLogsFile, rolloutsRoot, intervalMs: 20, idleMs: 100 });
  assert.equal(resumed[0]?.hook_event_name, 'UserPromptSubmit', 'already running chat resumes after Office restarts');
  fs.appendFileSync(rolloutFile, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
  await wait(50);
  assert.equal(resumed[1]?.hook_event_name, 'Stop', 'resumed chat completes without opening a new chat');
  watcher3.close();
  db.close();
  codexDb.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('VS Code Codex fallback: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
