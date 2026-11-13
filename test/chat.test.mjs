import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatError, findChats, prepareSaveDir, readChat } from '../lib/chat.mjs';
import { chatCommand } from '../zmi.mjs';

const root = join(import.meta.dirname, '..');
const HOUR = 3600e3;
const T0 = Date.UTC(2026, 9, 1, 2, 0); // 01/10/2026 09:00 Vietnam time
const ME = '0';
const CLIENT = '1111111111111111111';
const STRANGER = '2222222222222222222';

/** JPEG-looking bytes that carry a label the fake OCR reads back. */
const jpeg = label => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`|${label}|`)]);
const OCR = { quote: 'BÁO GIÁ HỆ THỐNG ĐIỆN MẶT TRỜI MÁI NHÀ 1 MWp tổng 15 tỷ đồng', blank: '' };

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zmi-chat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let seq = 0;
const msg = (convId, fromUid, minutes, fields) => ({
  msgId: String(9000000 + ++seq), cliMsgId: String(100 + seq), fromUid, dName: fromUid === ME ? 'Cong Nguyen' : 'Anh Nam', sendDttm: String(T0 + minutes * 60e3), ...fields,
});

/** A fake read-only bridge over `chats[convId] = raw messages` (any order). */
function fakeBridge(chats, { ocrCalls = [] } = {}) {
  return {
    async listConversations() { return Object.keys(chats).map(convId => ({ convId, isGroup: convId.startsWith('g') })); },
    async listFriends() { return [{ userId: CLIENT, displayName: 'Nam GreenPower', zaloName: 'Nguyễn Văn Nam' }]; },
    async listGroups() { return [{ convId: 'g42', name: 'Dự án KCN Đồng Nai – Allotrope' }]; },
    async getMessages(convId, { fromTs, limit = 2000 } = {}) {
      return (chats[convId] ?? [])
        .filter(m => fromTs === undefined || Number(m.sendDttm) >= fromTs)
        .sort((a, b) => Number(b.sendDttm) - Number(a.sendDttm))
        .slice(0, limit);
    },
    async getMediaRows() { return []; },
    async decodeJxl() { throw new Error('no JXL in these tests'); },
    async recognizeText(path) {
      assert.ok(!/ZaloData/i.test(path), 'OCR only sees our temp copies');
      const label = /\|(.*)\|/.exec(readFileSync(path, 'latin1'))?.[1];
      ocrCalls.push(label);
      const text = OCR[label] ?? '';
      return { lines: text ? [{ text, recognition: 0.99 }] : [] };
    },
    close() {},
  };
}

const noNetwork = { fetchFn: async () => { throw new Error('network must not be used'); } };

function clientChat(dir) {
  const pdf = join(dir, 'zalo-cache', 'Bao gia.pdf');
  const shot = join(dir, 'zalo-cache', 'shot.jpg');
  const photo = join(dir, 'zalo-cache', 'photo.jpg');
  const blank = join(dir, 'zalo-cache', 'blank.jpg');
  mkdirSync(join(dir, 'zalo-cache'), { recursive: true });
  for (const [p, bytes] of [[pdf, Buffer.from('%PDF-1.7 bao gia')], [shot, jpeg('quote')], [photo, jpeg('photo')], [blank, jpeg('blank')]]) writeFileSync(p, bytes);
  return [
    msg(CLIENT, CLIENT, 0, { msgType: 1, message: 'Chào anh, bên em gửi báo giá hệ thống mái nhà' }),
    msg(CLIENT, CLIENT, 1, { msgType: 19, message: { title: 'Bao gia.pdf', href: 'https://example.invalid/f', params: JSON.stringify({ fileSize: 16, fileExt: 'pdf' }) }, localPath: pdf }),
    msg(CLIENT, CLIENT, 2, { msgType: 2, message: { title: 'bảng tổng hợp', hdUrl: 'https://example.invalid/i1', params: JSON.stringify({ width: 1080, height: 2340 }) }, localPath: shot }),
    msg(CLIENT, CLIENT, 3, { msgType: 2, message: { title: '', hdUrl: 'https://example.invalid/i2', params: JSON.stringify({ width: 4000, height: 3000 }) }, localPath: photo }),
    msg(CLIENT, CLIENT, 4, { msgType: 2, message: { hdUrl: 'https://example.invalid/i3', params: JSON.stringify({ width: 1080, height: 2400 }) }, localPath: blank }),
    msg(CLIENT, ME, 60 * 24, { msgType: 1, message: 'ok anh', quote: { globalMsgId: '1', msg: 'Chào anh, bên em gửi báo giá hệ thống mái nhà' } }),
    msg(CLIENT, CLIENT, 60 * 24 + 1, { msgType: 4, message: { id: 1 } }),
    msg(CLIENT, CLIENT, 60 * 24 + 2, { msgType: 20, message: 'tin đã thu hồi' }),
  ];
}

function makeDir(dir, sub) {
  const p = join(dir, sub);
  rmSync(p, { recursive: true, force: true });
  return p;
}

test('chat find matches contact alias, Zalo name and group names without accents, newest first', async t => {
  const bridge = fakeBridge({ [CLIENT]: [msg(CLIENT, CLIENT, 0, { msgType: 1, message: 'a' })], g42: [msg('g42', CLIENT, 10, { msgType: 1, message: 'b' })] });
  const byAlias = await findChats(bridge, 'greenpower');
  assert.deepEqual(byAlias.chats.map(c => c.convId), [CLIENT]);
  assert.equal((await findChats(bridge, 'nguyen van nam')).chats[0].convId, CLIENT, 'Zalo name, accents ignored');
  const group = await findChats(bridge, 'dong nai');
  assert.equal(group.chats[0].convId, 'g42');
  assert.equal(group.chats[0].isGroup, true);
  await assert.rejects(findChats(bridge, '   '), ChatError);
});

test('chat find falls back to people not in the contact list, by the name they send under', async () => {
  const bridge = fakeBridge({
    [CLIENT]: [msg(CLIENT, CLIENT, 0, { msgType: 1, message: 'a' })],
    [STRANGER]: [{ ...msg(STRANGER, STRANGER, 5, { msgType: 1, message: 'x' }), dName: 'Trần Thị Hoa (Solar Corp)' }],
  });
  const result = await findChats(bridge, 'solar corp');
  assert.equal(result.searchedStrangers, true);
  assert.deepEqual(result.chats.map(c => [c.convId, c.name]), [[STRANGER, 'Trần Thị Hoa (Solar Corp)']]);
});

test('chat read prints the chat oldest first with day headers, quotes and senders; stickers and recalled messages are left out', async t => {
  const dir = scratch(t);
  const bridge = fakeBridge({ [CLIENT]: clientChat(dir) });
  const r = await readChat(bridge, CLIENT, {});
  const text = [...r.header, ...r.lines].join('\n');
  assert.match(r.header[0], /^# Nam GreenPower \(chat 1-1\)/);
  assert.match(text, /## 2026-10-01 \(Thứ Năm\)[\s\S]*## 2026-10-02 \(Thứ Sáu\)/);
  assert.match(text, /\[09:00\] Anh Nam: Chào anh, bên em gửi báo giá/);
  assert.match(text, /Cong Nguyen: \(trả lời "Chào anh, bên em gửi báo giá hệ thống mái nhà"\) ok anh/, 'short replies are kept in a 1-1 chat');
  assert.match(text, /\[File\] Bao gia\.pdf \(1 KB\) #m/);
  assert.doesNotMatch(text, /thu hồi/);
  assert.equal(r.stats.messages, 6);
  assert.ok(text.indexOf('09:00') < text.indexOf('ok anh'), 'oldest first');
});

test('chat read --save-to copies files and screenshots with text, skips photos and blank screenshots, never twice', async t => {
  const dir = scratch(t);
  const ocrCalls = [];
  const bridge = fakeBridge({ [CLIENT]: clientChat(dir) }, { ocrCalls });
  const out = makeDir(dir, 'Zalo files\\Nam GreenPower');
  const options = { saveTo: out, fileOptions: { ...noNetwork, appData: dir }, imageOptions: { appData: dir, fetchOptions: noNetwork } };

  const r = await readChat(bridge, CLIENT, options);
  const text = r.lines.join('\n');
  const saved = readdirSync(out);
  assert.ok(saved.some(n => /^2026-10-01_0902_anh-\d+\.jpg$/.test(n)), `screenshot named by date, time and id: ${saved}`);
  assert.equal(saved.filter(n => n.endsWith('.pdf')).length, 1);
  assert.equal(saved.filter(n => n.endsWith('.jpg')).length, 1, 'only the screenshot with text is saved');
  assert.match(text, /\[File\] Bao gia\.pdf \(1 KB\) → .*2026-10-01_Bao gia\.pdf/);
  assert.match(text, /\[Ảnh có chữ\] bảng tổng hợp \| BÁO GIÁ HỆ THỐNG .* → .*\.jpg/);
  assert.match(text, /\[Ảnh chụp màn hình, không có chữ\]/);
  assert.match(text, /\[Ảnh\] #m/, 'an ordinary photo stays a bare line');
  assert.ok(!ocrCalls.includes('photo'), 'ordinary photos are never OCRed');
  assert.deepEqual(r.stats.files, { stored: 1, notStored: 0 });
  assert.equal(r.stats.screenshots.stored, 1);
  assert.equal(r.stats.photos, 1);

  await readChat(bridge, CLIENT, options);
  assert.deepEqual(readdirSync(out).sort(), saved.sort(), 'a second run adds no copies');
});

test('chat read pages the chat and only handles the files of the page asked for', async t => {
  const dir = scratch(t);
  const bridge = fakeBridge({ [CLIENT]: clientChat(dir) });
  const p1 = await readChat(bridge, CLIENT, { pageChars: 120 });
  assert.ok(p1.pages > 1);
  const all = [];
  for (let page = 1; page <= p1.pages; page++) all.push(...(await readChat(bridge, CLIENT, { pageChars: 120, page })).lines.filter(l => l.startsWith('[')));
  assert.equal(all.length, p1.stats.messages, 'every message is on exactly one page');
  await assert.rejects(readChat(bridge, CLIENT, { pageChars: 120, page: p1.pages + 1 }), /chỉ có/);
});

test('chat read refuses an unknown chat id and a --from/--to range filters messages', async t => {
  const dir = scratch(t);
  const bridge = fakeBridge({ [CLIENT]: clientChat(dir) });
  await assert.rejects(readChat(bridge, '999', {}), ChatError);
  const day2 = await readChat(bridge, CLIENT, { from: T0 + 12 * HOUR });
  assert.equal(day2.stats.messages, 1);
});

test('the save folder must be absolute and outside Zalo data and zmi data/', () => {
  assert.throws(() => prepareSaveDir('relative\\dir'), ChatError);
  assert.throws(() => prepareSaveDir('C:\\Users\\x\\AppData\\Roaming\\ZaloData\\media\\out'), /Zalo/);
  assert.throws(() => prepareSaveDir(join(root, 'data', 'chat')), /data\//);
});

test('zmi chat never opens or creates the database and never touches data/', async t => {
  const dir = scratch(t);
  const dataDir = join(root, 'data');
  const before = existsSync(dataDir) ? readdirSync(dataDir).sort() : null;
  const lines = [];
  t.mock.method(console, 'log', (...a) => lines.push(a.join(' ')));
  t.mock.method(console, 'error', (...a) => lines.push(a.join(' ')));
  const open = async () => fakeBridge({ [CLIENT]: clientChat(dir) });
  assert.equal(await chatCommand({ sub: 'find', args: ['greenpower'], open }), 0);
  assert.equal(await chatCommand({ sub: 'read', args: [CLIENT], open, saveTo: join(dir, 'out'), fileOptions: { ...noNetwork, appData: dir }, imageOptions: { appData: dir, fetchOptions: noNetwork } }), 0);
  assert.equal(await chatCommand({ sub: 'read', args: [], open }), 2);
  assert.equal(await chatCommand({ sub: 'find', args: ['x'], page: 2, open }), 2);
  const after = existsSync(dataDir) ? readdirSync(dataDir).sort() : null;
  assert.deepEqual(after, before, 'data/ is untouched');
  assert.match(lines.join('\n'), new RegExp(`${CLIENT} \\| 1-1 \\| Nam GreenPower`));
  assert.match(lines.join('\n'), /Trang 1\/1 \(trang cuối\)/);
  assert.doesNotMatch(readFileSync(join(root, 'lib', 'chat.mjs'), 'utf8'), /import[^;]*['"]\.\/db\.mjs['"]/,'lib/chat.mjs never imports the database module');
});
