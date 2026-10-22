import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { connect, CdpError } from '../lib/cdp.mjs';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function listTargets(targets) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/json/list' ? JSON.stringify(targets) : '{}');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

test('connect throws PORT_CLOSED when nothing listens on the debug port', async () => {
  const port = await freePort();
  await assert.rejects(connect('Zalo', { port }), err => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.code, 'PORT_CLOSED');
    assert.ok(err.message.includes(String(port)), 'message names the port');
    return true;
  });
});

test('connect throws NO_TARGET when the port is open but there is no page with that title', async () => {
  const srv = await listTargets([
    { type: 'page', title: 'znotification.html', webSocketDebuggerUrl: 'ws://127.0.0.1:1/x' },
    { type: 'shared_worker', title: 'Zalo', webSocketDebuggerUrl: 'ws://127.0.0.1:1/y' },
  ]);
  try {
    await assert.rejects(connect('Zalo', { port: srv.port }), err => {
      assert.ok(err instanceof CdpError);
      assert.equal(err.code, 'NO_TARGET');
      return true;
    });
  } finally {
    srv.close();
  }
});
