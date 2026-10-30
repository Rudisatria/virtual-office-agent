// Regression test for the Windows shell command written to Codex hooks.json.
// Runs with an isolated Codex home and a local mock server; it never uses the user's settings or office.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

if (process.platform !== 'win32') { console.log('Windows-only test skipped.'); process.exit(0); }

const root = path.join(__dirname, '..');
const home = path.join(root, 'dist', 'codex-hook-test', 'home');
const codex = path.join(home, '.codex');
const hooksPath = path.join(codex, 'hooks.json');
fs.mkdirSync(codex, { recursive: true });

const legacy = '"' + process.execPath + '" "' + path.join(root, 'hook.js') + '" codex';
fs.writeFileSync(hooksPath, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [
  { type: 'command', command: legacy },
  { type: 'command', command: 'echo unrelated' }
] }] } }));
execFileSync(process.execPath, [path.join(root, 'install-codex.js')], {
  env: { ...process.env, OFFICE_HOME: home }, stdio: 'pipe'
});

const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks;
assert.equal(hooks.UserPromptSubmit.flatMap(g => g.hooks).filter(h => h.command === legacy).length, 0);
assert.equal(hooks.UserPromptSubmit.flatMap(g => g.hooks).filter(h => h.command === 'echo unrelated').length, 1);
const office = hooks.UserPromptSubmit.flatMap(g => g.hooks).filter(h => h.command.startsWith('powershell.exe '));
assert.equal(office.length, 1);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const event = JSON.parse(body);
    assert.equal(req.url, '/hook');
    assert.equal(event.hook_event_name, 'UserPromptSubmit');
    assert.equal(event.source, 'codex');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ context: 'isolated hint' }));
  });
});
server.listen(4399, '127.0.0.1', () => {
  const child = spawn('cmd.exe', ['/d', '/s', '/c', office[0].command], {
    env: { ...process.env, CLAUDE_OFFICE_PORT: '4399' }, windowsHide: true
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => stdout += c);
  child.stderr.on('data', c => stderr += c);
  child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'isolated-test', prompt: 'QA: test' }));
  child.on('close', code => {
    server.close();
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).hookSpecificOutput.additionalContext, 'isolated hint');
    console.log('Codex Windows hook command: passed');
  });
});
