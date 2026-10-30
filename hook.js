// Called by Claude Code and Codex hooks. Forwards the event to the local virtual office server.
// For a prompt (UserPromptSubmit), prints the office's skill hint when there is one, so Claude Code / Codex use the
// right team member's skill. Otherwise prints nothing. Startup retries briefly if the office was closed.
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
let data = '';
const quit = () => process.exit(0);
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { data += c; });
process.stdin.on('end', () => {
  // `node hook.js codex` tags the event, so the office can tell Codex apart from Claude Code
  const source = process.argv[2];
  let ev = {};
  try { ev = JSON.parse(data); } catch { /* forward as is */ }
  if (source) data = JSON.stringify({ ...ev, source });
  const prompt = ev.hook_event_name === 'UserPromptSubmit';
  const startup = ev.hook_event_name === 'SessionStart';
  const deadline = Date.now() + (startup ? 5000 : prompt ? 2400 : 1000);
  const port = Number(process.env.CLAUDE_OFFICE_PORT) || 4321;
  let launched = false;
  setTimeout(quit, startup ? 5500 : prompt ? 2700 : 1500);
  const launch = () => {
    if (launched || (!startup && !prompt)) return false;
    launched = true;
    try {
      spawn(process.execPath, [path.join(__dirname, 'app', 'launch.js'), '--if-unviewed'],
        { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    } catch { /* hooks must never block the editor */ }
    return true;
  };
  const retry = () => {
    launch();
    if (launched && Date.now() < deadline) setTimeout(send, 300);
    else quit();
  };
  const send = () => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/hook', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, timeout: 500
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        // A running server can have no office window, so SessionStart asks the launcher to show one.
        if (startup) launch();
        if (prompt) {
          try {
            const { context } = JSON.parse(body);
            if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
          } catch { /* no hint */ }
        }
        quit();
      });
    });
    req.on('error', retry);
    req.on('timeout', () => { req.destroy(); });
    req.end(data);
  };
  send();
});
