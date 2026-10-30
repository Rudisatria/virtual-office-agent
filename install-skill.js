// Installs (or removes, with --uninstall) the sre-devops skill in your user-level Claude Code skills folder
// (~/.claude/skills/sre-devops), so Claude Code uses it for deployments, incidents, monitoring and other SRE/DevOps work.
const fs = require('fs');
const os = require('os');
const path = require('path');

const uninstall = process.argv.includes('--uninstall');
const src = path.join(__dirname, 'skills', 'sre-devops', 'SKILL.md');
const dir = path.join(os.homedir(), '.claude', 'skills', 'sre-devops');
const dest = path.join(dir, 'SKILL.md');

if (uninstall) {
  if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true }); console.log('Removed ' + dir); }
  else console.log('Nothing to remove at ' + dir);
  process.exit(0);
}
if (fs.existsSync(dest)) {
  const backup = dest + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(dest, backup);
  console.log('Backup saved: ' + backup);
}
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(src, dest);
console.log('Installed the sre-devops skill at ' + dest);
console.log('Start a new Claude Code session so it picks up the skill.');
