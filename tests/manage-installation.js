const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createManager, installerInfo } = require('../app/manage-installation');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-manage-test-'));
const installer = path.join(root, 'VirtualOfficeSetup.exe');
const uninstaller = path.join(root, 'Uninstall.exe');
const binary = Buffer.alloc(1024 * 1024 + 1);
binary.write('MZ');
binary.writeUInt32LE(128, 0x3c);
binary.write('PE\0\0', 128);
fs.writeFileSync(installer, binary);
fs.writeFileSync(uninstaller, binary);

(async () => {
  const launched = [];
  const manager = createManager({ root, picker: async () => installer, launch: async file => launched.push(file) });
  assert(manager.installed());
  assert.equal(installerInfo(installer).name, 'VirtualOfficeSetup.exe');
  const chosen = await manager.select();
  assert.equal(chosen.name, 'VirtualOfficeSetup.exe');
  await assert.rejects(manager.run('wrong-token'), /Choose the update installer again/);
  assert.equal(launched.length, 0);
  await manager.run(chosen.token);
  assert.deepEqual(launched, [installer]);
  await assert.rejects(manager.run(chosen.token), /Choose the update installer again/);
  await manager.uninstall();
  assert.deepEqual(launched, [installer, uninstaller]);
  fs.writeFileSync(installer, 'not an installer');
  await assert.rejects(manager.select(), /unexpected size/);
  const cancelled = createManager({ root, picker: async () => null, launch: async () => assert.fail('must not launch') });
  assert.deepEqual(await cancelled.select(), { cancelled: true });
  console.log('Setup app management: OK');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
