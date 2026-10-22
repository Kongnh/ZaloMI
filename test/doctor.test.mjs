import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

test('doctor on a closed port prints Vietnamese guidance, exits non-zero and leaves data/ alone', async () => {
  const port = await freePort();
  const dataDir = join(root, 'data');
  const before = existsSync(dataDir) ? readdirSync(dataDir) : null;

  const run = spawnSync(process.execPath, ['--no-warnings', join(root, 'zmi.mjs'), 'doctor', '--port', String(port)], { encoding: 'utf8' });

  assert.notEqual(run.status, 0, 'non-zero exit code');
  assert.match(run.stdout, /✗/);
  assert.match(run.stdout, /Zalo \(MI\)/, 'tells the user how to open Zalo in collection mode');
  assert.ok(!existsSync(join(dataDir, 'zalo-mi.db')), 'doctor never creates the database');
  const after = existsSync(dataDir) ? readdirSync(dataDir) : null;
  assert.deepEqual(after, before, 'doctor leaves data/ untouched on a closed port');
});

test('zmi without a known command prints usage and exits with code 2', () => {
  const run = spawnSync(process.execPath, ['--no-warnings', join(root, 'zmi.mjs'), 'khong-co-lenh'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stdout + run.stderr, /doctor/);
});
