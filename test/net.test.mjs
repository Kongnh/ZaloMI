import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isPrivateAddress, checkRemoteUrl, guardedFetch, NetGuardError } from '../lib/net.mjs';

// No test touches the internet: names are resolved by a fake lookup, and the only server is a local one on 127.0.0.1.
// Reaching it at all needs a test policy that lets 127.0.0.1 through; the default policy refuses it, which is the point.

const PUBLIC = '93.184.216.34';
const publicDns = async () => [{ address: PUBLIC, family: 4 }];
/** Only for reaching the local test server: loopback 127.0.0.1 allowed, every other private address still refused. */
const allowLocalServer = address => address !== '127.0.0.1' && isPrivateAddress(address);

/** A local server: `routes[path] = (req, res) => ...`; anything else 404. `hits` lists `host path` of every request. */
async function server(routes) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(`${req.headers.host} ${req.url}`);
    const route = routes[req.url];
    if (!route) { res.writeHead(404); res.end(); return; }
    route(req, res);
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  return { port, hits, close: () => new Promise(resolve => { srv.closeAllConnections(); srv.close(resolve); }) };
}

/** Fake DNS: name -> address list; unknown names fail like ENOTFOUND. */
const dns = table => async host => {
  const address = typeof table[host] === 'function' ? table[host]() : table[host];
  if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return [{ address, family: address.includes(':') ? 6 : 4 }];
};

test('isPrivateAddress covers loopback, private, link-local, CGNAT, benchmarking, IETF, multicast and the IPv6 forms of them', () => {
  for (const a of ['127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '198.18.0.1', '198.19.255.255', '192.0.0.8', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::7f00:1', '::127.0.0.1', '::a00:1', 'not an ip']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of [PUBLIC, '8.8.8.8', '172.32.0.1', '198.20.0.1', '192.0.1.1', '100.128.0.1', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(a), false, a);
  }
});

test('checkRemoteUrl allows public http(s) only: other schemes, loopback and private hosts are refused', async () => {
  assert.equal(await checkRemoteUrl('https://photo-stal-38.zdn.vn/gr/jpg/a.jpg', { lookup: publicDns }), null);
  assert.equal(await checkRemoteUrl('http://b-f64-zpg-r.zdn.vn/a.jpg', { lookup: publicDns }), null);
  for (const url of ['file:///C:/Users/x/a.jpg', 'ftp://example.com/a.jpg', 'data:image/jpeg;base64,AAAA', 'javascript:alert(1)', 'not a url',
    'http://127.0.0.1/a.jpg', 'http://localhost:9222/json/list', 'http://zalo.localhost/a.jpg', 'http://10.1.2.3/a.jpg', 'http://172.16.0.9/a.jpg',
    'http://192.168.1.20/a.jpg', 'http://169.254.169.254/latest', 'http://0.0.0.0/a.jpg', 'http://[::1]/a.jpg', 'http://[fd12::1]/a.jpg',
    'http://[fe80::1]/a.jpg', 'http://[::ffff:127.0.0.1]/a.jpg', 'http://[::127.0.0.1]/a.jpg', 'http://100.64.0.1/a.jpg', 'http://198.18.0.1/a.jpg']) {
    assert.equal(typeof await checkRemoteUrl(url, { lookup: publicDns }), 'string', url);
  }
  const toLoopback = async () => [{ address: '127.0.0.1', family: 4 }];
  assert.match(await checkRemoteUrl('https://evil.example/a.jpg', { lookup: toLoopback }), /nội bộ/, 'a public name that resolves to a private address');
});

test('guardedFetch refuses a private address at connect time: a name that rebinds to 127.0.0.1 after the check never reaches it', async () => {
  const srv = await server({ '/a': (req, res) => res.end('secret') });
  try {
    let calls = 0;
    const rebinding = async () => (++calls === 1 ? [{ address: PUBLIC, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    const url = `http://rebind.test:${srv.port}/a`;
    assert.equal(await checkRemoteUrl(url, { lookup: rebinding }), null, 'the first answer looks public');
    await assert.rejects(guardedFetch(url, { lookup: rebinding }), err => err instanceof NetGuardError && err.code === 'REFUSED' && /127\.0\.0\.1/.test(err.message));
    assert.deepEqual(srv.hits, [], 'no request reached the loopback server');
  } finally { await srv.close(); }
});

test('guardedFetch refuses literal private addresses, localhost names and other schemes without connecting', async () => {
  const srv = await server({ '/a': (req, res) => res.end('secret') });
  try {
    for (const url of [`http://127.0.0.1:${srv.port}/a`, `http://localhost:${srv.port}/a`, `http://[::1]:${srv.port}/a`, 'file:///C:/x.jpg', 'ftp://x.test/a']) {
      await assert.rejects(guardedFetch(url, { lookup: publicDns }), err => err instanceof NetGuardError && err.code === 'REFUSED', url);
    }
    assert.deepEqual(srv.hits, []);
  } finally { await srv.close(); }
});

test('guardedFetch follows redirects by hand, re-checking every hop, and sends the original host name', async () => {
  const srv = await server({
    '/b': (req, res) => { res.writeHead(301, { location: '/c' }); res.end(); },
    '/c': (req, res) => { res.writeHead(302, { location: `http://cdn2.test:${srv.port}/d` }); res.end(); },
    '/d': (req, res) => { res.writeHead(200, { 'content-type': 'image/jpeg', 'x-test': 'ok' }); res.end(Buffer.from([0xff, 0xd8, 0xff, 1, 2])); },
    '/to-inner': (req, res) => { res.writeHead(302, { location: `http://inner.test:${srv.port}/d` }); res.end(); },
    '/to-literal': (req, res) => { res.writeHead(302, { location: 'http://192.168.0.5/a.jpg' }); res.end(); },
  });
  try {
    const lookup = dns({ 'cdn.test': '127.0.0.1', 'cdn2.test': '127.0.0.1', 'inner.test': '10.0.0.7' });
    const options = { lookup, refuse: allowLocalServer };
    const response = await guardedFetch(`http://cdn.test:${srv.port}/b`, options);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual([...Buffer.from(await response.arrayBuffer())], [0xff, 0xd8, 0xff, 1, 2]);
    assert.deepEqual(srv.hits, [`cdn.test:${srv.port} /b`, `cdn.test:${srv.port} /c`, `cdn2.test:${srv.port} /d`]);

    srv.hits.length = 0;
    await assert.rejects(guardedFetch(`http://cdn.test:${srv.port}/to-inner`, options), err => err.code === 'REFUSED' && /10\.0\.0\.7/.test(err.message));
    await assert.rejects(guardedFetch(`http://cdn.test:${srv.port}/to-literal`, options), err => err.code === 'REFUSED' && /192\.168\.0\.5/.test(err.message));
    assert.deepEqual(srv.hits, [`cdn.test:${srv.port} /to-inner`, `cdn.test:${srv.port} /to-literal`], 'the refused hops are never requested');
  } finally { await srv.close(); }
});

test('guardedFetch: a malformed Location or too many redirects ends as a NetGuardError, never an escaping TypeError', async () => {
  const srv = await server({
    '/bad': (req, res) => { res.writeHead(302, { location: 'http://[::1' }); res.end(); },
    '/loop': (req, res) => { res.writeHead(302, { location: '/loop' }); res.end(); },
  });
  try {
    const options = { lookup: dns({ 'cdn.test': '127.0.0.1' }), refuse: allowLocalServer };
    await assert.rejects(guardedFetch(`http://cdn.test:${srv.port}/bad`, options), err => err instanceof NetGuardError && err.code === 'BAD_REDIRECT');
    await assert.rejects(guardedFetch(`http://cdn.test:${srv.port}/loop`, options), err => err instanceof NetGuardError && err.code === 'TOO_MANY_REDIRECTS');
    assert.equal(srv.hits.filter(h => h.endsWith('/loop')).length, 4, 'the first request plus 3 redirects');
  } finally { await srv.close(); }
});

test('guardedFetch passes HTTP errors through as responses, reports unknown hosts like fetch, and honours the abort signal', async () => {
  const srv = await server({ '/hang': () => { /* never answers */ } });
  try {
    const options = { lookup: dns({ 'cdn.test': '127.0.0.1' }), refuse: allowLocalServer };
    const missing = await guardedFetch(`http://cdn.test:${srv.port}/missing`, options);
    assert.equal(missing.status, 404);
    assert.equal(missing.ok, false);
    await assert.rejects(guardedFetch('http://gone.test/a', options), err => !(err instanceof NetGuardError) && err.code === 'ENOTFOUND');
    await assert.rejects(guardedFetch(`http://cdn.test:${srv.port}/hang`, { ...options, signal: AbortSignal.timeout(100) }), err => err.name === 'AbortError' || err.name === 'TimeoutError');
  } finally { await srv.close(); }
});
