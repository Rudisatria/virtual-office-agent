// Best-effort activity from Codex's VS Code extension when cloud turns do not run local hooks.
// VS Code owns this internal storage, so failures here must never affect the office server.
const fs = require('fs');
const path = require('path');
const os = require('os');

// The local Codex app server writes tool calls here even when command hooks are skipped.
// Only parse quoted command arguments; never execute text read from this database.
function toolSteps(body) {
  const call = body.indexOf('ToolCall: ');
  if (call < 0) return [];
  const source = body.slice(call);
  const steps = [];
  const commands = /tools\.exec_command\s*\(\s*\{\s*cmd\s*:\s*("(?:\\.|[^"\\])*")/g;
  for (const match of source.matchAll(commands)) {
    try {
      const command = JSON.parse(match[1]);
      if (typeof command === 'string' && command.trim()) steps.push({ tool_name: 'Bash', tool_input: { command } });
    } catch { /* An incomplete log entry is not an activity. */ }
  }
  if (!steps.length && /tools\.apply_patch\s*\(/.test(source)) {
    const file = /\*\*\* (?:Update|Add|Delete) File: ([^\r\n]+)/.exec(source)?.[1];
    steps.push({ tool_name: 'apply_patch', tool_input: { command: file ? `*** Update File: ${file}` : '' } });
  }
  return steps;
}

function start(onEvent, options = {}) {
  const stateFile = options.stateFile || path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'state.vscdb');
  const logsRoot = options.logsRoot || path.join(process.env.APPDATA || '', 'Code', 'logs');
  const codexLogsFile = options.codexLogsFile || path.join(process.env.OFFICE_HOME || os.homedir(), '.codex', 'logs_2.sqlite');
  const rolloutsRoot = options.rolloutsRoot || path.join(process.env.OFFICE_HOME || os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(stateFile)) return null;
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return null; }

  const prompts = new Map(), active = new Map(), started = new Map(), completed = new Set(), ignored = new Set(), logs = new Map(), rollouts = new Map();
  let stateStamp = '', codexStamp = '', ticks = 0, lastCodexLogId = null, needFullRolloutScan = false;
  const watcherStartedAt = Date.now();
  const idleMs = options.idleMs || 60000;
  const intervalMs = options.intervalMs || 2000;
  const stamp = file => { try { const s = fs.statSync(file); return s.mtimeMs + ':' + s.size; } catch { return ''; } };
  const recent = file => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

  function emitPrompt(id) {
    const item = prompts.get(id);
    if (!item || ignored.has(id)) return;
    if (active.has(id)) finish(id);
    completed.delete(id);
    active.set(id, Date.now());
    started.set(id, Date.now());
    onEvent({ hook_event_name: 'UserPromptSubmit', source: 'codex', session_id: id, prompt: item.text, vscodeFallback: true });
  }
  function finish(id) {
    active.delete(id);
    started.delete(id);
    completed.add(id);
    if (completed.size > 200) completed.delete(completed.values().next().value);
    onEvent({ hook_event_name: 'Stop', source: 'codex', session_id: id, vscodeFallback: true });
  }
  function readState(seed = false) {
    const nextStamp = stamp(stateFile) + ':' + stamp(stateFile + '-wal');
    if (!nextStamp || nextStamp === stateStamp) return;
    stateStamp = nextStamp;
    let db;
    try {
      db = new DatabaseSync(stateFile, { readOnly: true });
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get('openai.chatgpt');
      const atom = JSON.parse(row && row.value || '{}')['persisted-atom-state'];
      const history = atom && atom['prompt-history'];
      if (!history || typeof history !== 'object') return;
      for (const [id, list] of Object.entries(history)) {
        if (!/^[0-9a-f-]{36}$/i.test(id) || !Array.isArray(list) || !list.length) continue;
        const text = list[list.length - 1];
        if (typeof text !== 'string' || !text.trim()) continue;
        const fingerprint = list.length + ':' + text;
        const old = prompts.get(id);
        prompts.set(id, { text, fingerprint });
        if (!old && !seed) needFullRolloutScan = true;
        if (!seed && old && old.fingerprint !== fingerprint) emitPrompt(id);
        if (!seed && !old && Math.max(recent(stateFile), recent(stateFile + '-wal')) > Date.now() - 10000) emitPrompt(id);
      }
    } catch { stateStamp = ''; /* VS Code may be writing or may change its storage format. */ }
    finally { try { if (db) db.close(); } catch { /* retry on the next poll */ } }
  }
  function discoverLogs() {
    try {
      const sessions = fs.readdirSync(logsRoot, { withFileTypes: true })
        .filter(e => e.isDirectory()).map(e => e.name).sort().reverse().slice(0, 3);
      for (const session of sessions) {
        const root = path.join(logsRoot, session);
        for (const win of fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.startsWith('window'))) {
          const file = path.join(root, win.name, 'exthost', 'openai.chatgpt', 'Codex.log');
          if (fs.existsSync(file) && !logs.has(file)) logs.set(file, fs.statSync(file).size);
        }
      }
    } catch { /* VS Code may be closed. */ }
  }
  function readLogs() {
    for (const [file, offset] of logs) {
      let size;
      try { size = fs.statSync(file).size; } catch { logs.delete(file); continue; }
      if (size < offset) { logs.set(file, 0); continue; }
      if (size === offset) continue;
      const from = Math.max(offset, size - 262144);
      const length = size - from;
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, from);
        for (const line of buf.toString('utf8').split(/\r?\n/)) {
          if (!line.includes('Reasoning summary item completed')) continue;
          const id = /\bthreadId=([0-9a-f-]{36})\b/i.exec(line)?.[1];
          if (!id || ignored.has(id) || completed.has(id)) continue;
          if (!active.has(id)) emitPrompt(id);
          if (active.has(id)) active.set(id, Date.now());
        }
      } catch { /* log rotation or concurrent write */ }
      finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
      logs.set(file, size);
    }
  }
  function readCodexLogs() {
    if (!fs.existsSync(codexLogsFile)) return;
    const nextStamp = stamp(codexLogsFile) + ':' + stamp(codexLogsFile + '-wal');
    if (nextStamp === codexStamp) return;
    codexStamp = nextStamp;
    let db;
    try {
      db = new DatabaseSync(codexLogsFile, { readOnly: true });
      if (lastCodexLogId === null) {
        lastCodexLogId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM logs').get().id;
        return;
      }
      const rows = db.prepare('SELECT id, ts, target, feedback_log_body FROM logs WHERE id > ? AND target IN (?, ?) ORDER BY id LIMIT 300')
        .all(lastCodexLogId, 'codex_core::stream_events_utils', 'codex_core::session::turn');
      for (const row of rows) {
        lastCodexLogId = row.id;
        const body = row.feedback_log_body || '';
        const id = /\bthread_id=([0-9a-f-]{36})\b/i.exec(body)?.[1];
        if (!id || ignored.has(id) || !prompts.has(id)) continue;
        if (row.target === 'codex_core::session::turn') {
          // This is the local Codex turn ending, usually before the idle timeout.
          if (active.has(id) && row.ts * 1000 >= (started.get(id) || 0) - 1000 &&
              (/\bneeds_follow_up=false\b/.test(body) || body.includes('Turn error:'))) finish(id);
          continue;
        }
        if (!body.includes('ToolCall: ')) continue;
        if (completed.has(id)) continue;
        if (!active.has(id)) emitPrompt(id);
        for (const step of toolSteps(body)) {
          active.set(id, Date.now());
          onEvent({ hook_event_name: 'Step', source: 'codex', session_id: id,
            step: step.tool_name === 'Bash' ? 'Running ' + step.tool_input.command.replace(/\s+/g, ' ').slice(0, 70) : 'Editing files',
            ...step, vscodeFallback: true });
        }
      }
      if (rows.length === 300) codexStamp = ''; // read the next batch even if SQLite has not written again
    } catch { codexStamp = ''; /* Codex may be writing, or its private log format may change. */ }
    finally { try { if (db) db.close(); } catch { /* retry on next poll */ } }
  }
  function discoverRollouts(seed = false) {
    // An existing rollout starts at EOF so opening Office never replays a
    // completed task from the user's history.
    const folders = new Set();
    for (const day of [0, 1]) {
      const date = new Date(Date.now() - day * 86400000);
      const folder = path.join(rolloutsRoot, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
      folders.add(folder);
    }
    // A continued VS Code chat keeps writing to its original date folder, even weeks later.
    // Scan older folders only at startup or when a previously unseen thread appears.
    if (seed || needFullRolloutScan) {
      needFullRolloutScan = false;
      try {
        for (const year of fs.readdirSync(rolloutsRoot, { withFileTypes: true }).filter(e => e.isDirectory())) {
          const yearDir = path.join(rolloutsRoot, year.name);
          for (const month of fs.readdirSync(yearDir, { withFileTypes: true }).filter(e => e.isDirectory())) {
            const monthDir = path.join(yearDir, month.name);
            for (const day of fs.readdirSync(monthDir, { withFileTypes: true }).filter(e => e.isDirectory())) folders.add(path.join(monthDir, day.name));
          }
        }
      } catch { /* There may be no Codex sessions yet. */ }
    }
    for (const folder of folders) {
      let files;
      try { files = fs.readdirSync(folder).filter(name => name.endsWith('.jsonl')); } catch { continue; }
      for (const name of files) {
        const file = path.join(folder, name);
        if (rollouts.has(file)) continue;
        const filenameId = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(name)?.[1];
        if (!filenameId || !prompts.has(filenameId)) continue;
        try {
          const fd = fs.openSync(file, 'r');
          const head = Buffer.alloc(4096);
          const bytes = fs.readSync(fd, head, 0, head.length, 0);
          fs.closeSync(fd);
          const meta = JSON.parse(head.toString('utf8', 0, bytes).split('\n')[0]);
          if (meta.type !== 'session_meta' || meta.payload?.originator !== 'codex_vscode') continue;
          const id = meta.payload.id;
          if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
          const stat = fs.statSync(file);
          const existingFile = seed || stat.birthtimeMs < watcherStartedAt - 5000;
          rollouts.set(file, { id, offset: existingFile ? stat.size : 0 });
          if (existingFile && Date.now() - stat.mtimeMs < 120000) {
            // Office may start during an existing turn. Resume only when the newest
            // lifecycle marker says the turn started and has not yet completed.
            const tailSize = Math.min(stat.size, 4 * 1024 * 1024);
            const tail = Buffer.alloc(tailSize);
            const tailFd = fs.openSync(file, 'r');
            try { fs.readSync(tailFd, tail, 0, tailSize, stat.size - tailSize); }
            finally { fs.closeSync(tailFd); }
            let lifecycle = '';
            for (const line of tail.toString('utf8').split('\n')) {
              if (!line.includes('task_started') && !line.includes('task_complete')) continue;
              try {
                const entry = JSON.parse(line);
                if (entry.type === 'event_msg' && ['task_started', 'task_complete'].includes(entry.payload?.type)) lifecycle = entry.payload.type;
              } catch { /* The first or last tail line may be incomplete. */ }
            }
            if (lifecycle === 'task_started') emitPrompt(id);
          }
        } catch { /* A newly created rollout may have an incomplete first line. */ }
      }
    }
  }
  function readRollouts() {
    for (const [file, state] of rollouts) {
      let size;
      try { size = fs.statSync(file).size; } catch { rollouts.delete(file); continue; }
      if (size < state.offset) state.offset = 0;
      if (size === state.offset) continue;
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(Math.min(size - state.offset, 262144));
        const bytes = fs.readSync(fd, buf, 0, buf.length, state.offset);
        const chunk = buf.toString('utf8', 0, bytes);
        const end = chunk.lastIndexOf('\n');
        if (end < 0) { state.offset += bytes; continue; } // skip an oversized single record
        state.offset += Buffer.byteLength(chunk.slice(0, end + 1));
        for (const line of chunk.slice(0, end).split('\n')) {
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry.type !== 'event_msg' || !prompts.has(state.id) || ignored.has(state.id)) continue;
          if (entry.payload?.type === 'task_started' && !active.has(state.id) && !completed.has(state.id)) emitPrompt(state.id);
          if (entry.payload?.type === 'task_complete' && active.has(state.id)) finish(state.id);
        }
      } catch { /* Codex may still be writing this file. */ }
      finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
    }
  }
  function poll() {
    readState();
    if (++ticks % 5 === 0) discoverLogs();
    readLogs();
    if (ticks % 5 === 0) discoverRollouts();
    readRollouts();
    readCodexLogs();
    for (const [id, last] of active) if (Date.now() - last > idleMs) {
      finish(id);
    }
  }
  readState(true);
  discoverLogs();
  discoverRollouts(true);
  readCodexLogs();
  const timer = setInterval(poll, intervalMs);
  timer.unref();
  return {
    ignore(id) { if (!id) return; ignored.add(id); active.delete(id); started.delete(id); if (ignored.size > 200) ignored.delete(ignored.values().next().value); },
    close() { clearInterval(timer); }
  };
}

module.exports = { start, toolSteps };
