// Minimal Chrome DevTools Protocol client for the Zalo PC main window.
// Ported from the spike's cdp.mjs/ev.mjs: list targets over HTTP, open the page's WebSocket,
// run Runtime.evaluate with awaitPromise + returnByValue.

const HOST = '127.0.0.1'; // The debug port is only ever opened on loopback.
const LIST_TIMEOUT_MS = 3000;
const EVALUATE_TIMEOUT_MS = 60000;
const SOCKET_GRACE_MS = 5000; // Extra time on top of the in-page timeout before we give up on the socket.

export class CdpError extends Error {
  /** @param {'PORT_CLOSED'|'NO_TARGET'|'SOCKET_FAILED'|'EVALUATE_FAILED'} code */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'CdpError';
    this.code = code;
  }
}

async function listTargets(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/json/list`, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('unexpected /json/list response');
    return list;
  } catch (cause) {
    throw new CdpError('PORT_CLOSED', `Không kết nối được cổng debug ${HOST}:${port}. Zalo chưa mở ở chế độ thu thập.`, { cause });
  }
}

function openSocket(url) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = cause => reject(new CdpError('SOCKET_FAILED', 'Không mở được kết nối WebSocket tới cửa sổ Zalo.', { cause }));
  });
}

/**
 * Connects to the page target whose title is `title` (default: the Zalo main window).
 * @returns {Promise<{ evaluate(expression: string): Promise<any>, close(): void }>}
 * @throws {CdpError} PORT_CLOSED when the debug port does not answer, NO_TARGET when no page has that title.
 */
export async function connect(title = 'Zalo', { port = 9222 } = {}) {
  const targets = await listTargets(port);
  const target = targets.find(t => t.type === 'page' && t.title === title);
  if (!target) {
    throw new CdpError('NO_TARGET', `Cổng debug ${port} đang mở nhưng không thấy cửa sổ "${title}".`);
  }

  const ws = await openSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map(); // id -> { resolve, reject, timer }

  const failAll = error => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const entry = message.id !== undefined && pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message);
  };
  ws.onclose = () => failAll(new CdpError('SOCKET_FAILED', 'Kết nối tới cửa sổ Zalo đã đóng.'));

  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new CdpError('SOCKET_FAILED', `Zalo không trả lời lệnh ${method}.`));
    }, EVALUATE_TIMEOUT_MS + SOCKET_GRACE_MS);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });

  async function evaluate(expression) {
    const reply = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: EVALUATE_TIMEOUT_MS,
    });
    if (reply.error) throw new CdpError('EVALUATE_FAILED', JSON.stringify(reply.error));
    const { result, exceptionDetails } = reply.result;
    if (exceptionDetails) {
      throw new CdpError('EVALUATE_FAILED', exceptionDetails.exception?.description ?? JSON.stringify(exceptionDetails));
    }
    return result.value;
  }

  function close() {
    ws.onclose = null;
    failAll(new CdpError('SOCKET_FAILED', 'Kết nối tới cửa sổ Zalo đã được đóng.'));
    ws.close();
  }

  return { evaluate, close };
}
