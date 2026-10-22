// Downloads from public hosts only. Shared by `zmi files` (attachment links) and `zmi images` (photo links): both URLs
// come from chat messages, so a sender could point one at this PC, e.g. Zalo's debug port on 127.0.0.1:9222.
//
//   isPrivateAddress(ip)        loopback, private, link-local, CGNAT, benchmarking, IETF, multicast (+ their IPv6 forms)
//   checkRemoteUrl(url)         a quick check (scheme, localhost names, literal IPs, what the name resolves to)
//   guardedFetch(url, options)  GET that enforces the address rule AT CONNECT TIME and follows redirects by hand
//
// The connect-time check is what closes DNS rebinding: a name can resolve to a public address when it is checked and to
// 127.0.0.1 a moment later when the connection is made. guardedFetch hands node:http/https a `lookup` that rejects
// private answers, so the address actually dialled is the one that was vetted. Literal IPs (no lookup happens) are
// checked before connecting. Every redirect hop goes through the same two checks; at most 3 redirects are followed.

import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

const MAX_REDIRECTS = 3;

export class NetGuardError extends Error {
  /** @param {'REFUSED'|'BAD_REDIRECT'|'TOO_MANY_REDIRECTS'} code */
  constructor(code, message) {
    super(message);
    this.name = 'NetGuardError';
    this.code = code;
  }
}

function ipv4Private(address) {
  const [a, b, c] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254) // link-local, cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || (a === 198 && (b === 18 || b === 19)) // benchmarking 198.18.0.0/15
    || (a === 192 && b === 0 && c === 0); // IETF protocol assignments 192.0.0.0/24
}

/** The IPv4 address embedded in an IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) IPv6 address, else null. */
function embeddedIpv4(s) {
  const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) return dotted[1];
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s); // the URL parser writes ::127.0.0.1 as ::7f00:1
  if (!hex) return null;
  const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for any address a download must never reach (and for anything that is not an IP at all). */
export function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) return ipv4Private(address);
  if (version !== 6) return true;
  const s = address.toLowerCase();
  if (s === '::' || s === '::1') return true;
  const v4 = embeddedIpv4(s);
  if (v4) return ipv4Private(v4);
  return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
}

/** Reason a URL is refused before any lookup (scheme, localhost names, literal private IP), or null. Returns the parsed URL too. */
function precheck(url, refuse) {
  let u;
  try { u = new URL(url); } catch { return { reason: 'link không hợp lệ' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { reason: `chỉ tải link http(s), không tải ${u.protocol}` };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return { reason: 'không tải từ máy nội bộ (localhost)' };
  if (isIP(host) && refuse(host)) return { reason: `không tải từ địa chỉ nội bộ ${host}` };
  return { url: u, host };
}

/**
 * Why `url` must not be fetched (Vietnamese reason), or null when it is a public http(s) address.
 * A host name is resolved and refused when any of its addresses is private. This is a quick early check only:
 * guardedFetch enforces the same rule again at connect time.
 */
export async function checkRemoteUrl(url, { lookup = dnsLookup, refuse = isPrivateAddress } = {}) {
  const { reason, host } = precheck(url, refuse);
  if (reason) return reason;
  if (isIP(host)) return null;
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch (error) {
    return `không phân giải được máy chủ (${error?.code ?? error?.message ?? error})`;
  }
  const inner = addresses.find(a => refuse(a.address));
  return inner ? `không tải từ địa chỉ nội bộ ${inner.address} (${host})` : null;
}

/** A net/http `lookup` that only ever hands back vetted addresses, so the connection goes to what was checked. */
function vettedLookup(lookup, refuse) {
  return (hostname, options, callback) => {
    lookup(hostname, { family: options?.family, all: true }).then(addresses => {
      const inner = addresses.find(a => refuse(a.address));
      if (inner) return callback(new NetGuardError('REFUSED', `không tải từ địa chỉ nội bộ ${inner.address} (${hostname})`));
      if (addresses.length === 0) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
      if (options?.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    }, callback);
  };
}

/** One GET, no redirect following. Resolves with the raw IncomingMessage. */
function getOnce(url, { lookup, refuse, signal, headers }) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(url, { method: 'GET', headers, signal, agent: false, lookup: vettedLookup(lookup, refuse) }, resolve);
    request.on('error', reject);
    request.end();
  });
}

function toResponse(message) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined || name === 'set-cookie') continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const empty = [204, 205, 304].includes(message.statusCode);
  if (empty) message.resume();
  return new Response(empty ? null : Readable.toWeb(message), { status: message.statusCode, statusText: message.statusMessage, headers });
}

/**
 * GET `url` from a public host. Same result shape as fetch: a Response (any HTTP status, body streamed) after following
 * at most 3 redirects, or a rejection. Network errors reject like fetch's causes do (error.code ENOTFOUND, ECONNREFUSED…);
 * the abort `signal` rejects with an AbortError.
 * @param {string} url
 * @param {{ signal?: AbortSignal, headers?: object, lookup?: Function, refuse?: (address: string) => boolean }} [options]
 *   `lookup` (dns.promises.lookup shape) and `refuse` (default isPrivateAddress) exist for tests.
 * @throws {NetGuardError} REFUSED (scheme, localhost, private address, also when only found at connect time),
 *   BAD_REDIRECT (malformed Location), TOO_MANY_REDIRECTS
 */
export async function guardedFetch(url, { signal, headers, lookup = dnsLookup, refuse = isPrivateAddress } = {}) {
  let current = url;
  for (let hop = 0; ; hop++) {
    const { reason, url: parsed } = precheck(current, refuse);
    if (reason) throw new NetGuardError('REFUSED', reason);
    const message = await getOnce(parsed, { lookup, refuse, signal, headers });
    const location = message.headers.location;
    if (message.statusCode >= 300 && message.statusCode < 400 && location) {
      message.resume();
      if (hop >= MAX_REDIRECTS) throw new NetGuardError('TOO_MANY_REDIRECTS', `link chuyển hướng quá ${MAX_REDIRECTS} lần`);
      try {
        current = new URL(location, parsed).toString();
      } catch {
        throw new NetGuardError('BAD_REDIRECT', 'link chuyển hướng tới một địa chỉ không hợp lệ');
      }
      continue;
    }
    return toResponse(message);
  }
}
