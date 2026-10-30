// A Chrome profile folder for the headless tests that is kept between runs on purpose.
// Chrome on Windows checks once per new profile whether the Windows password is blank, by trying to sign in with an
// empty password. Every check counts as a failed sign-in, and 10 within 10 minutes lock the account: the lock screen
// then says the PIN "isn't available". A fresh profile per Chrome launch adds up fast; one kept profile per test costs it once.
// Only the profile's site storage is cleared, so every run still starts without localStorage left from the last one.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = function chromeProfile(name) {
  const dir = path.join(os.tmpdir(), 'virtual-office-test-chrome', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(path.join(dir, 'Default', 'Local Storage'), { recursive: true, force: true });
  return dir;
};
