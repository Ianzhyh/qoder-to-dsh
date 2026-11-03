import test from 'node:test';
import assert from 'node:assert/strict';

test('QODER_SCAN_DESKTOP=0 disables every local credential scan', async () => {
  process.env.QODER_SCAN_DESKTOP = '0';
  try {
    const { desktopScanEnabled, scanDesktopAuth, prewarmDesktopKeysAsync } = await import('../lib/desktop-auth.mjs');
    assert.equal(desktopScanEnabled(), false);
    assert.deepEqual(scanDesktopAuth({ force: true }), []);
    await prewarmDesktopKeysAsync();
  } finally {
    delete process.env.QODER_SCAN_DESKTOP;
  }
});
