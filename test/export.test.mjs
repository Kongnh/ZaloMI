import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb } from '../lib/db.mjs';
import {
  exportRange, searchMessages, formatSearchLine, isNoiseMessage, slugify, parseVnDate, resolveRange, selectGroupIds,
  formatVnDateTime, formatVnTime, formatVnDate, ExportError,
} from '../lib/export.mjs';
import { exportCommand, searchCommand } from '../zmi.mjs';

// Synthetic data only: every name, number and text below is invented.

const H = 3600e3;
const D = 24 * H;
/** A Vietnam wall-clock time (UTC+7) as epoch milliseconds. */
const vn = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm) - 7 * H;
const NOW = vn(2026, 10, 22, 14, 30);

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zmi-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** In-memory DB with the clock fixed at NOW, one tracked group g1 and a fresh sync run. */
function memDb(t, { sync = NOW - 2 * H, groups = [['g1', 'Nhóm Năng Lượng']] } = {}) {
  const db = openDb(':memory:', { now: () => NOW });
  t.after(() => db.close());
  for (const [conv_id, name] of groups) db.upsertGroup({ conv_id, name, tracked: 1 });
  if (sync !== null) db.recordSyncRun({ started_at: sync - 1000, finished_at: sync, groups: groups.length, new_messages: 0, updated_messages: 0, errors_json: '[]' });
  return db;
}

let nextId = 1000;
/** Upserts a message (ids are strings) and returns its id. */
function msg(db, over = {}) {
  const msg_id = over.msg_id ?? String(nextId++);
  db.upsertMessage({
    msg_id, conv_id: 'g1', cli_msg_id: `c${msg_id}`, ts: vn(2026, 10, 20, 9, 0), from_uid: 'u-an', sender_name: 'An',
    msg_type: '1', kind: 'text', text: 'nội dung', ...over,
  });
  return msg_id;
}

function runExport(db, root, options = {}) {
  return exportRange(db, { rootDir: root, out: join(root, 'out'), now: () => NOW, ...options });
}
const read = (dir, name) => readFileSync(join(dir, name), 'utf8');
const allText = dir => readdirSync(dir).map(f => read(dir, f)).join('\n');
const groupFile = (dir, name = 'Nhóm-Năng-Lượng.md') => read(dir, name);
const messageLines = text => text.split('\n').filter(l => /^\[\d\d:\d\d\] /.test(l));

// ---------------------------------------------------------------------------------------------------------------------
// The four tests the brief names
// ---------------------------------------------------------------------------------------------------------------------

test('export omits recalled/deleted/sticker (and video)', t => {
  const root = scratch(t);
  const db = memDb(t);
  msg(db, { text: 'Giá điện mặt trời mái nhà tháng này giảm nhẹ' });
  msg(db, { kind: 'recalled', msg_type: '20', text: 'NOIDUNG-THUHOI' }); // recalled rows keep their old text in the database
  msg(db, { kind: 'deleted', msg_type: '-27', text: 'NOIDUNG-DAXOA' });
  msg(db, { kind: 'sticker', msg_type: '4', text: null });
  msg(db, { kind: 'video', msg_type: '18', text: 'NOIDUNG-VIDEO' });

  const dir = runExport(db, root);
  const everything = allText(dir);
  assert.doesNotMatch(everything, /NOIDUNG/);
  assert.equal(messageLines(groupFile(dir)).length, 1, 'only the real text message is a line');
  assert.match(groupFile(dir), /Giá điện mặt trời mái nhà tháng này giảm nhẹ/);
  assert.match(read(dir, 'index.md'), /thu hồi|xóa/i, 'index says what was dropped');
});

test('export redacts phone in chat text', t => {
  const root = scratch(t);
  const db = memDb(t);
  msg(db, { text: 'Liên hệ anh Nam 0963 046 382 hoặc nam@example.com lấy báo giá 3.088 MW, mã 1-BC-BCT-2026-760' });
  msg(db, { sender_name: 'Lan 0987654321', text: 'Em gửi file ạ' });
  msg(db, {
    kind: 'link', msg_type: '6', text: 'https://example.com/tin', url: 'https://example.com/tin', title: 'Hotline 0912345678 hỗ trợ', description: 'Gửi về mail chi@example.com',
  });
  db.upsertLink({ msg_id: '9001', conv_id: 'g1', ts: vn(2026, 10, 20, 9, 5), url: 'https://example.com/tin', domain: 'example.com', title: 'Hotline 0912345678 hỗ trợ', description: 'Gửi về mail chi@example.com' });
  msg(db, { msg_id: '9001', kind: 'link', msg_type: '6', ts: vn(2026, 10, 20, 9, 5), text: 'xem tin', url: 'https://example.com/tin', title: 'Hotline 0912345678 hỗ trợ', description: 'Gửi về mail chi@example.com' });
  // Image content and file names are not redacted (spec 6.7: org hotlines on posters must survive).
  msg(db, { msg_id: '9002', kind: 'photo', msg_type: '2', ts: vn(2026, 10, 20, 9, 6), text: null });
  db.upsertImage({ msg_id: '9002', conv_id: 'g1', ts: vn(2026, 10, 20, 9, 6), has_text: 1, status: 'stored', stored_path: 'data/images/g1/9002.jpg', ocr_text: 'HOTLINE 0912 345 678 ĐĂNG KÝ NGAY', shape_class: 'phone_screenshot' });
  msg(db, { msg_id: '9003', kind: 'file', msg_type: '19', ts: vn(2026, 10, 20, 9, 7), text: null, title: 'Danh-sach-0912345678.pdf' });
  db.upsertFile({ msg_id: '9003', conv_id: 'g1', ts: vn(2026, 10, 20, 9, 7), file_name: 'Danh-sach-0912345678.pdf', size: 1000, status: 'remote_only', remote_url: 'https://zalo.me/0912345678/file' });

  const dir = runExport(db, root);
  const group = groupFile(dir);
  assert.match(group, /Liên hệ anh Nam \[SĐT\] hoặc \[email\] lấy báo giá 3\.088 MW, mã 1-BC-BCT-2026-760/);
  assert.doesNotMatch(group, /0963 046 382|nam@example\.com/);
  assert.match(group, /Lan \[SĐT\]: Em gửi file ạ/, 'sender names that carry a phone are redacted');
  assert.match(group, /\[Link\] Hotline \[SĐT\] hỗ trợ/);
  assert.match(group, /Gửi về mail \[email\]/);
  assert.match(group, /HOTLINE 0912 345 678 ĐĂNG KÝ NGAY/, 'OCR text is image content, not redacted');
  assert.match(group, /Danh-sach-0912345678\.pdf/, 'file names are not redacted');
  assert.doesNotMatch(group, /zalo\.me\/0912345678/, 'a messenger link with a phone in its path is redacted');
  for (const file of readdirSync(dir)) {
    assert.doesNotMatch(read(dir, file), /0963 ?046 ?382|nam@example|chi@example|0987654321|Hotline 0912345678/, file);
  }
});

test('index.md warns when latest sync > 24h old', t => {
  const root = scratch(t);
  const old = runExport(memDb(t, { sync: NOW - 30 * H }), root);
  assert.match(read(old, 'index.md'), /CẢNH BÁO.*sync/s);
  assert.match(read(old, 'index.md'), /30 giờ/);

  const fresh = runExport(memDb(t, { sync: NOW - 2 * H }), root, { out: join(root, 'fresh') });
  assert.doesNotMatch(read(fresh, 'index.md'), /CẢNH BÁO/);
  assert.match(read(fresh, 'index.md'), /2026-10-22 12:30/, 'shows the latest sync time in Vietnam time');

  const exactly = runExport(memDb(t, { sync: NOW - 24 * H }), root, { out: join(root, 'exact') });
  assert.doesNotMatch(read(exactly, 'index.md'), /CẢNH BÁO/, 'exactly 24 h is not older than 24 h');

  const never = runExport(memDb(t, { sync: null }), root, { out: join(root, 'never') });
  assert.match(read(never, 'index.md'), /CẢNH BÁO.*chưa có lần sync/s);
});

test('per-group file lines carry #m<msgId>', t => {
  const root = scratch(t);
  const db = memDb(t);
  msg(db, { msg_id: '8372420766850', ts: vn(2026, 10, 20, 9, 15), sender_name: 'An', text: 'Bộ Công Thương vừa ban hành quy định mới về DPPA' });
  msg(db, { msg_id: '8372420766851', ts: vn(2026, 10, 20, 9, 16), sender_name: 'Bình', text: 'Dòng một\nDòng hai\n\nDòng ba' });
  msg(db, { msg_id: '8372420766852', ts: vn(2026, 10, 21, 0, 5), sender_name: 'Chi', text: 'Tin sau nửa đêm giờ Việt Nam' });

  const group = groupFile(runExport(db, root));
  assert.match(group, /^# Nhóm Năng Lượng$/m);
  assert.match(group, /^\[09:15\] An: Bộ Công Thương vừa ban hành quy định mới về DPPA #m8372420766850$/m);
  assert.match(group, /^\[09:16\] Bình: Dòng một ⏎ Dòng hai ⏎ Dòng ba #m8372420766851$/m, 'a multi-line message stays one line');
  const lines = messageLines(group);
  assert.equal(lines.length, 3);
  for (const line of lines) assert.match(line, / #m\d+$/);
  assert.match(group, /^## 2026-10-20 \(Thứ Ba\)$/m, 'grouped by Vietnam date');
  assert.match(group, /^## 2026-10-21 \(Thứ Tư\)$/m);
  assert.ok(group.indexOf('2026-10-20') < group.indexOf('2026-10-21'), 'oldest day first');
  assert.match(group, /^\[00:05\] Chi: /m, 'a UTC+7 time after midnight lands on the next Vietnam day');
});

// ---------------------------------------------------------------------------------------------------------------------
// Dates and UTC+7 (ruling 5)
// ---------------------------------------------------------------------------------------------------------------------

test('Vietnam time formatting does not depend on the machine time zone', () => {
  const ts = Date.UTC(2026, 9, 20, 17, 5); // 17:05 UTC = 00:05 on the 21st in Vietnam
  assert.equal(formatVnDateTime(ts), '2026-10-21 00:05');
  assert.equal(formatVnDate(ts), '2026-10-21');
  assert.equal(formatVnTime(ts), '00:05');
});

test('parseVnDate reads YYYY-MM-DD as Vietnam time; --to covers the whole day', () => {
  assert.equal(parseVnDate('2026-10-01'), Date.UTC(2026, 9, 1) - 7 * H);
  assert.equal(parseVnDate('2026-10-02', { endOfDay: true }), Date.UTC(2026, 9, 3) - 7 * H - 1);
  for (const bad of ['2026-13-01', '2026-02-30', '22/10/2026', '2026-10-1', 'hôm qua', '']) {
    assert.throws(() => parseVnDate(bad), ExportError, bad);
  }
});

test('resolveRange: default is the 14 days before now; dates are Vietnam days; to is inclusive', () => {
  assert.deepEqual(resolveRange({}, NOW), { from: NOW - 14 * D, to: NOW });
  assert.deepEqual(resolveRange({ from: '2026-10-01', to: '2026-10-02' }, NOW), {
    from: Date.UTC(2026, 9, 1) - 7 * H, to: Date.UTC(2026, 9, 3) - 7 * H - 1,
  });
  assert.deepEqual(resolveRange({ from: '2026-10-01' }, NOW), { from: Date.UTC(2026, 9, 1) - 7 * H, to: NOW });
  // Only --to: the 14 calendar days that end on that day, so the default never lands after --to.
  const onlyTo = resolveRange({ to: '2026-09-30' }, NOW);
  assert.equal(onlyTo.to, Date.UTC(2026, 9, 1) - 7 * H - 1);
  assert.equal(onlyTo.from, Date.UTC(2026, 8, 17) - 7 * H);
  assert.throws(() => resolveRange({ from: '2026-10-05', to: '2026-10-01' }, NOW), /--from/);
});

test('export keeps only the range, with --to inclusive of the whole last day (Vietnam time)', t => {
  const root = scratch(t);
  const db = memDb(t);
  msg(db, { ts: vn(2026, 9, 30, 23, 59), text: 'TRUOC-KY' });
  msg(db, { ts: vn(2026, 10, 1, 0, 0), text: 'DAU-KY' });
  msg(db, { ts: vn(2026, 10, 2, 23, 59), text: 'CUOI-KY' });
  msg(db, { ts: vn(2026, 10, 3, 0, 0), text: 'SAU-KY' });
  const { from, to } = resolveRange({ from: '2026-10-01', to: '2026-10-02' }, NOW);
  const group = groupFile(runExport(db, root, { from, to }));
  assert.match(group, /DAU-KY/);
  assert.match(group, /CUOI-KY/);
  assert.doesNotMatch(group, /TRUOC-KY|SAU-KY/);
});

test('exportRange defaults to the last 14 days and to the tracked groups', t => {
  const root = scratch(t);
  const db = memDb(t, { groups: [['g1', 'Nhóm Một'], ['g2', 'Nhóm Hai']] });
  db.upsertGroup({ conv_id: 'g3', name: 'Nhóm Không Theo Dõi', tracked: 0 });
  msg(db, { conv_id: 'g1', ts: NOW - 13 * D, text: 'TRONG-KY-1' });
  msg(db, { conv_id: 'g1', ts: NOW - 15 * D, text: 'NGOAI-KY-1' });
  msg(db, { conv_id: 'g2', ts: NOW - D, text: 'TRONG-KY-2' });
  msg(db, { conv_id: 'g3', ts: NOW - D, text: 'KHONG-THEO-DOI' });
  const dir = exportRange(db, { rootDir: root, out: join(root, 'out'), now: () => NOW });
  const everything = allText(dir);
  assert.match(everything, /TRONG-KY-1/);
  assert.match(everything, /TRONG-KY-2/);
  assert.doesNotMatch(everything, /NGOAI-KY-1|KHONG-THEO-DOI/);
});

test('default --out is exports/<YYYYMMDD-HHmm> in Vietnam time under the repo root, never overwriting an earlier run', t => {
  const root = scratch(t);
  const db = memDb(t);
  msg(db);
  const first = exportRange(db, { rootDir: root, now: () => NOW });
  assert.equal(first, join(root, 'exports', '20261022-1430'));
  assert.ok(existsSync(join(first, 'index.md')));
  const second = exportRange(db, { rootDir: root, now: () => NOW });
  assert.equal(second, join(root, 'exports', '20261022-1430-2'), 'same minute twice: a new folder');
});

test('an explicit --out that already has files is refused, an empty or new one is fine', t => {
  const root = scratch(t);
  const db = memDb(t);
  msg(db);
  const full = join(root, 'full');
  mkdirSync(full);
  writeFileSync(join(full, 'ghi-chu.txt'), 'x');
  assert.throws(() => runExport(db, root, { out: full }), err => err instanceof ExportError && /--out/.test(err.message));
  assert.ok(existsSync(join(full, 'ghi-chu.txt')), 'nothing deleted');
  const empty = join(root, 'empty');
  mkdirSync(empty);
  assert.equal(runExport(db, root, { out: empty }), empty);
  assert.equal(runExport(db, root, { out: join(root, 'a', 'b', 'c') }), join(root, 'a', 'b', 'c'));
});

// ---------------------------------------------------------------------------------------------------------------------
// Attachment lines (rulings 3 and 4)
// ---------------------------------------------------------------------------------------------------------------------

function seedAttachments(db) {
  // 3 photos with text: stored, text_only, stored without caption; 1 photo without text (+caption), 1 without text or caption
  msg(db, { msg_id: '5001', kind: 'photo', msg_type: '2', ts: vn(2026, 10, 20, 9, 20), sender_name: 'Bình', text: 'Bảng giá' });
  db.upsertImage({ msg_id: '5001', conv_id: 'g1', ts: vn(2026, 10, 20, 9, 20), caption: 'Bảng giá', has_text: 1, status: 'stored', stored_path: 'data/images/g1/5001.jpg', ocr_text: 'BẢNG GIÁ ĐIỆN\nMặt trời mái nhà\n1.200 đ/kWh', shape_class: 'phone_screenshot' });
  msg(db, { msg_id: '5002', kind: 'photo', msg_type: '2', ts: vn(2026, 10, 20, 9, 21), sender_name: 'Bình', text: 'Slide cũ' });
  db.upsertImage({ msg_id: '5002', conv_id: 'g1', ts: vn(2026, 10, 20, 9, 21), caption: 'Slide cũ', has_text: 1, status: 'text_only', stored_path: null, ocr_text: 'Lộ trình DPPA 2026', shape_class: 'photo' });
  msg(db, { msg_id: '5003', kind: 'photo', msg_type: '2', ts: vn(2026, 10, 20, 9, 22), sender_name: 'Bình', text: null });
  db.upsertImage({ msg_id: '5003', conv_id: 'g1', ts: vn(2026, 10, 20, 9, 22), has_text: 1, status: 'stored', stored_path: 'data/images/g1/5003.png', ocr_text: `${'x'.repeat(10)} ${'dòng '.repeat(80)}`, shape_class: 'desktop_screenshot' });
  msg(db, { msg_id: '5004', kind: 'photo', msg_type: '2', ts: vn(2026, 10, 20, 9, 23), sender_name: 'Chi', text: 'Công trường sáng nay' });
  db.upsertImage({ msg_id: '5004', conv_id: 'g1', ts: vn(2026, 10, 20, 9, 23), caption: 'Công trường sáng nay', has_text: 0, status: 'no_text', ocr_text: 'logo' });
  msg(db, { msg_id: '5005', kind: 'photo', msg_type: '2', ts: vn(2026, 10, 20, 9, 24), sender_name: 'Chi', text: null });
  // files: stored, link only (href kept), no href at all
  msg(db, { msg_id: '5101', kind: 'file', msg_type: '19', ts: vn(2026, 10, 20, 10, 0), sender_name: 'An', text: null, title: 'Bao-cao-NLTT.pdf' });
  db.upsertFile({ msg_id: '5101', conv_id: 'g1', ts: vn(2026, 10, 20, 10, 0), file_name: 'Bao-cao-NLTT.pdf', size: 4_089_446, status: 'stored', stored_path: 'data/files/g1/2026-10-20_Bao-cao-NLTT.pdf', remote_url: 'https://cdn.example.vn/x' });
  msg(db, { msg_id: '5102', kind: 'file', msg_type: '19', ts: vn(2026, 10, 20, 10, 1), sender_name: 'An', text: null, title: 'Cu.xlsx' });
  db.upsertFile({ msg_id: '5102', conv_id: 'g1', ts: vn(2026, 10, 20, 10, 1), file_name: 'Cu.xlsx', size: 250_000, status: 'failed', error: 'HTTP 404', remote_url: 'https://cdn.example.vn/cu' });
  msg(db, { msg_id: '5103', kind: 'file', msg_type: '19', ts: vn(2026, 10, 20, 10, 2), sender_name: 'An', text: null, title: 'Nho.txt' });
  db.upsertFile({ msg_id: '5103', conv_id: 'g1', ts: vn(2026, 10, 20, 10, 2), file_name: 'Nho.txt', size: 2048, status: 'skipped' });
}

test('image lines: with text -> caption | OCR -> path; text_only -> no path; without text -> [Ảnh] + caption', t => {
  const root = scratch(t);
  const db = memDb(t);
  seedAttachments(db);
  const group = groupFile(runExport(db, root));
  const p = rel => resolve(root, rel);

  assert.match(group, new RegExp(`^\\[09:20\\] Bình: \\[Ảnh có chữ\\] Bảng giá \\| BẢNG GIÁ ĐIỆN Mặt trời mái nhà 1\\.200 đ/kWh → ${esc(p('data/images/g1/5001.jpg'))} #m5001$`, 'm'));
  assert.match(group, /^\[09:21\] Bình: \[Ảnh có chữ\] Slide cũ \| Lộ trình DPPA 2026 → \(chỉ còn chữ, ảnh đã xoá\) #m5002$/m);
  const noCaption = group.split('\n').find(l => l.includes('#m5003'));
  assert.match(noCaption, /^\[09:22\] Bình: \[Ảnh có chữ\] x{10} (dòng ){5,}/, 'no caption: no caption and no separator');
  assert.ok(noCaption.includes(`→ ${p('data/images/g1/5003.png')} #m5003`));
  const ocrPart = noCaption.slice(noCaption.indexOf('xxxxxxxxxx'), noCaption.indexOf(' → '));
  assert.ok([...ocrPart].length <= 201, `OCR is cut to about 200 characters (got ${[...ocrPart].length})`);
  assert.match(group, /^\[09:23\] Chi: \[Ảnh\] Công trường sáng nay #m5004$/m);
  assert.match(group, /^\[09:24\] Chi: \[Ảnh\] #m5005$/m);
  assert.doesNotMatch(group, /logo/, 'OCR of an image without enough text is not exported');
});

test('file lines: size with a decimal comma, absolute path when stored, otherwise "chỉ có link"', t => {
  const root = scratch(t);
  const db = memDb(t);
  seedAttachments(db);
  const group = groupFile(runExport(db, root));
  assert.ok(group.includes(`[10:00] An: [File] Bao-cao-NLTT.pdf (3,9 MB) → ${resolve(root, 'data/files/g1/2026-10-20_Bao-cao-NLTT.pdf')} #m5101`));
  assert.ok(group.includes('[10:01] An: [File] Cu.xlsx (0,2 MB) → chỉ có link: https://cdn.example.vn/cu #m5102'));
  assert.ok(group.includes('[10:02] An: [File] Nho.txt (2 KB) → chỉ có link #m5103'), 'no href stored: no href printed');
});

test('link lines: the sender text, then [Link] title — domain; a bare URL is not repeated; no uids anywhere', t => {
  const root = scratch(t);
  const db = memDb(t);
  const when = vn(2026, 10, 20, 11, 0);
  msg(db, { msg_id: '6001', kind: 'link', msg_type: '6', ts: when, sender_name: 'An', text: 'Đọc giúp mình https://baomoi.example/a', url: 'https://baomoi.example/a', title: 'EVN đề xuất giá điện hai thành phần', description: 'Cơ chế mới áp dụng từ quý 1' });
  db.upsertLink({ msg_id: '6001', conv_id: 'g1', ts: when, url: 'https://baomoi.example/a', domain: 'baomoi.example', title: 'EVN đề xuất giá điện hai thành phần', description: 'Cơ chế mới áp dụng từ quý 1' });
  msg(db, { msg_id: '6002', kind: 'link', msg_type: '6', ts: when + 60e3, sender_name: 'An', text: 'https://vnexpress.example/b', url: 'https://vnexpress.example/b', title: 'Điện gió ngoài khơi' });
  db.upsertLink({ msg_id: '6002', conv_id: 'g1', ts: when + 60e3, url: 'https://vnexpress.example/b', domain: 'vnexpress.example', title: 'Điện gió ngoài khơi' });

  const dir = runExport(db, root);
  const group = groupFile(dir);
  assert.match(group, /^\[11:00\] An: Đọc giúp mình https:\/\/baomoi\.example\/a \[Link\] EVN đề xuất giá điện hai thành phần — baomoi\.example \| Cơ chế mới áp dụng từ quý 1 #m6001$/m);
  assert.match(group, /^\[11:01\] An: \[Link\] Điện gió ngoài khơi — vnexpress\.example #m6002$/m);
  assert.doesNotMatch(allText(dir), /u-an/, 'from_uid never reaches the output');
});

test('member events are lines too: [Thành viên] text', t => {
  const root = scratch(t);
  const db = memDb(t);
  msg(db, { msg_id: '7001', kind: 'member_event', msg_type: '-4', ts: vn(2026, 10, 20, 8, 0), sender_name: null, text: 'Hạnh Mai được Tuấn Anh thêm vào nhóm' });
  db.upsertMemberEvent({ msg_id: '7001', conv_id: 'g1', ts: vn(2026, 10, 20, 8, 0), event: 'added', member_uids_json: '["u-mai"]', member_name: 'Hạnh Mai', actor_name: 'Tuấn Anh', text: 'Hạnh Mai được Tuấn Anh thêm vào nhóm' });
  const group = groupFile(runExport(db, root));
  assert.match(group, /^\[08:00\] \[Thành viên\] Hạnh Mai được Tuấn Anh thêm vào nhóm #m7001$/m);
});

// ---------------------------------------------------------------------------------------------------------------------
// Noise (ruling 7)
// ---------------------------------------------------------------------------------------------------------------------

test('isNoiseMessage drops short greetings and thanks, keeps anything with substance', () => {
  for (const noise of ['Chào mọi người', 'chào anh', 'Cảm ơn', 'Cảm ơn anh', 'cám ơn các anh', 'Cảm ơn anh Nam', 'cam on a', 'Thanks', 'thanks ạ', 'Thank you', 'thx', 'ok', 'OK anh', 'Okie nhé', '👍', '👍👍', '🙏', 'Cảm ơn ạ 🙏', 'Hello', 'chào cả nhà', '...', '', '   ', null]) {
    assert.equal(isNoiseMessage(noise), true, `should be noise: ${JSON.stringify(noise)}`);
  }
  for (const keep of [
    'Cảm ơn anh Nam đã chia sẻ thông tin rất hữu ích', // 15+ characters
    'ok 500 MW', 'Ok, 2 MW', 'Thanks EVN 2026', // a figure: substance
    'DPPA mới', 'Giá 2.000đ', 'Nghị định 57', 'BESS là gì?', // short but not a greeting
    'Hello anh em hôm nay có giá điện mới chưa', 'ok giá bao nhiêu vậy',
  ]) {
    assert.equal(isNoiseMessage(keep), false, `should be kept: ${JSON.stringify(keep)}`);
  }
});

test('export drops short greetings but never a link, file or image, and counts what it dropped', t => {
  const root = scratch(t);
  const db = memDb(t);
  msg(db, { text: 'Cảm ơn anh' });
  msg(db, { text: 'ok' });
  msg(db, { text: '👍' });
  msg(db, { text: 'Giá điện tháng 10 là 2.204 đồng/kWh' });
  msg(db, { kind: 'photo', msg_type: '2', text: 'Cảm ơn' });
  msg(db, { msg_id: '6101', kind: 'link', msg_type: '6', text: 'ok', url: 'https://example.com/z', title: 'Tin' });
  msg(db, { msg_id: '6102', kind: 'file', msg_type: '19', text: null, title: 'ok.pdf' });
  db.upsertFile({ msg_id: '6102', conv_id: 'g1', ts: vn(2026, 10, 20, 9, 0), file_name: 'ok.pdf', size: 1, status: 'skipped' });

  const dir = runExport(db, root);
  const lines = messageLines(groupFile(dir));
  assert.equal(lines.length, 4, lines.join('\n'));
  assert.ok(lines.some(l => l.includes('Giá điện tháng 10')));
  assert.ok(lines.some(l => l.includes('[Ảnh] Cảm ơn')), 'an image caption is kept');
  assert.ok(lines.some(l => l.includes('[Link]')), 'a link message is kept');
  assert.ok(lines.some(l => l.includes('[File] ok.pdf')), 'a file is kept');
  assert.match(read(dir, 'index.md'), /3 tin chào/, 'the index counts the dropped greetings');
});

// ---------------------------------------------------------------------------------------------------------------------
// index.md, file names, members.md, attachments.md
// ---------------------------------------------------------------------------------------------------------------------

test('an exact repost in the same group shrinks to a pointer at its first copy; short lines and other groups are not touched', t => {
  const root = scratch(t);
  const db = memDb(t, { groups: [['g1', 'Nhóm Năng Lượng'], ['g2', 'Nhóm Khác']] });
  const post = 'Tấm pin 650W hàng sẵn kho HCM, giá tốt cho đại lý, inbox để nhận báo giá chi tiết';
  const first = msg(db, { text: post, ts: vn(2026, 10, 18, 9, 0) });
  const again = msg(db, { text: post, ts: vn(2026, 10, 19, 9, 0), sender_name: 'Bình' });
  msg(db, { text: 'Có ai đi hội thảo không?', ts: vn(2026, 10, 19, 10, 0) });
  msg(db, { text: 'Có ai đi hội thảo không?', ts: vn(2026, 10, 19, 11, 0) });
  msg(db, { conv_id: 'g2', text: post, ts: vn(2026, 10, 19, 12, 0) });

  const dir = runExport(db, root, { convIds: ['g1', 'g2'] });
  const lines = messageLines(groupFile(dir));
  assert.equal(lines.filter(l => l.includes('Tấm pin 650W')).length, 1, 'the post text appears once in g1');
  assert.match(groupFile(dir), new RegExp(`\\[09:00\\] Bình: \\(đăng lại tin #m${first}\\) #m${again}`));
  assert.equal(lines.filter(l => l.includes('hội thảo')).length, 2, 'short messages are never shortened');
  assert.match(groupFile(dir, 'Nhóm-Khác.md'), /Tấm pin 650W/, 'cross-group duplicates stay for the report to merge');
  assert.match(read(dir, 'index.md'), /1 tin đăng lại/);
});

test('index.md lists each group with its message count and first/last time; empty groups get no file', t => {
  const root = scratch(t);
  const db = memDb(t, { groups: [['g1', 'Nhóm Năng Lượng'], ['g2', 'Solar | Mái nhà'], ['g3', 'Nhóm Trống']] });
  msg(db, { conv_id: 'g1', ts: vn(2026, 10, 18, 9, 0), text: 'tin đầu của nhóm một' });
  msg(db, { conv_id: 'g1', ts: vn(2026, 10, 21, 17, 45), text: 'tin cuối của nhóm một' });
  msg(db, { conv_id: 'g1', ts: vn(2026, 10, 19, 8, 0), kind: 'sticker', msg_type: '4', text: null });
  msg(db, { conv_id: 'g2', ts: vn(2026, 10, 20, 12, 0), text: 'chỉ một tin' });
  const dir = runExport(db, root);
  const index = read(dir, 'index.md');
  assert.match(index, /Nhóm Năng Lượng.*\b2\b.*2026-10-18 09:00.*2026-10-21 17:45.*Nhóm-Năng-Lượng\.md/);
  assert.match(index, /Solar \/ Mái nhà.*\b1\b.*2026-10-20 12:00/, 'a pipe in a name does not break the table');
  assert.match(index, /Nhóm Trống.*\b0\b/);
  assert.deepEqual(readdirSync(dir).sort(), ['Nhóm-Năng-Lượng.md', 'Solar-Mái-nhà.md', 'attachments.md', 'index.md', 'members.md']);
  assert.match(index, /2026-10-08 14:30/, 'shows the range, from = 14 days before now');
  assert.match(index, /#m/, 'explains how to read the #m ids');
});

test('slugify: keeps Vietnamese letters, drops emoji and Windows-reserved characters', () => {
  assert.equal(slugify('☀️ Future Energy Vietnam 🇻🇳'), 'Future-Energy-Vietnam');
  assert.equal(slugify('Điện gió: Ninh Thuận/Bình Thuận?'), 'Điện-gió-Ninh-Thuận-Bình-Thuận');
  assert.equal(slugify('  a<b>c"d|e*f\\g  '), 'a-b-c-d-e-f-g');
  assert.equal(slugify('🇻🇳🇻🇳'), 'nhom', 'nothing left: a neutral fallback');
  assert.equal(slugify('CON'), '_CON', 'a Windows device name cannot be a file name');
  assert.equal(slugify('x'.repeat(200)).length <= 60, true);
  assert.equal(slugify('Năng lượng.'), 'Năng-lượng', 'no trailing dot');
});

test('group file names are unique per export, even when two names reduce to the same slug or collide with index/members', t => {
  const root = scratch(t);
  const db = memDb(t, { groups: [['g1111', '☀️ Solar VN'], ['g2222', 'Solar VN'], ['g3333', 'Index'], ['g4444', 'Members']] });
  for (const c of ['g1111', 'g2222', 'g3333', 'g4444']) msg(db, { conv_id: c, text: `tin của ${c} về điện mặt trời` });
  const dir = runExport(db, root);
  const names = readdirSync(dir).filter(f => !['index.md', 'members.md', 'attachments.md'].includes(f));
  assert.equal(names.length, 4);
  assert.equal(new Set(names.map(n => n.toLowerCase())).size, 4, 'unique, case-insensitively (Windows)');
  for (const n of names) assert.doesNotMatch(n, /[<>:"/\\|?*]/);
  // every group file holds its own group's message
  for (const c of ['g1111', 'g2222', 'g3333', 'g4444']) {
    const holders = names.filter(n => read(dir, n).includes(`tin của ${c} về`));
    assert.equal(holders.length, 1, c);
  }
  assert.match(read(dir, 'index.md'), /Index.*\.md/);
});

test('members.md: who joined in the range, who added them, up to 2 of their own messages; no uids', t => {
  const root = scratch(t);
  const db = memDb(t);
  const join_ = (id, ts, event, uid, member, actor, text) => {
    msg(db, { msg_id: id, kind: 'member_event', msg_type: '-4', ts, sender_name: null, from_uid: 'u-sys', text });
    db.upsertMemberEvent({ msg_id: id, conv_id: 'g1', ts, event, member_uids_json: JSON.stringify([uid]), member_name: member, actor_name: actor, text });
  };
  join_('7101', vn(2026, 10, 20, 8, 0), 'added', 'uid-mai-123', 'Hạnh Mai', 'Tuấn Anh', 'Hạnh Mai được Tuấn Anh thêm vào nhóm');
  join_('7102', vn(2026, 10, 20, 8, 30), 'joined', 'uid-khoa-456', 'Đăng Khoa', null, 'Đăng Khoa đã tham gia nhóm');
  join_('7103', vn(2026, 10, 20, 8, 40), 'removed', 'uid-bi-789', 'Văn Bi', 'Tuấn Anh', 'Văn Bi bị Tuấn Anh xóa khỏi nhóm');
  join_('7104', vn(2026, 9, 1, 8, 0), 'added', 'uid-cu-000', 'Người Cũ', 'Tuấn Anh', 'Người Cũ được Tuấn Anh thêm vào nhóm'); // before the range
  msg(db, { msg_id: '7201', from_uid: 'uid-mai-123', sender_name: 'Hạnh Mai', ts: vn(2026, 10, 20, 8, 5), text: 'Chào mọi người' }); // greeting only
  msg(db, { msg_id: '7202', from_uid: 'uid-mai-123', sender_name: 'Hạnh Mai', ts: vn(2026, 10, 20, 8, 6), text: 'Em phụ trách điện mặt trời mái nhà tại công ty ABC, SĐT 0912 345 678' });
  msg(db, { msg_id: '7203', from_uid: 'uid-mai-123', sender_name: 'Hạnh Mai', ts: vn(2026, 10, 20, 9, 0), text: 'Tin thứ hai của Mai' });
  msg(db, { msg_id: '7204', from_uid: 'uid-mai-123', sender_name: 'Hạnh Mai', ts: vn(2026, 10, 20, 9, 5), text: 'Tin thứ ba của Mai' });
  msg(db, { msg_id: '7205', from_uid: 'uid-mai-123', sender_name: 'Hạnh Mai', ts: vn(2026, 10, 20, 7, 0), text: 'Tin TRƯỚC khi vào nhóm' });
  msg(db, { msg_id: '7206', from_uid: 'someone-else', sender_name: 'Khác', ts: vn(2026, 10, 20, 8, 7), text: 'Tin của người khác' });

  const dir = runExport(db, root);
  const members = read(dir, 'members.md');
  assert.match(members, /^## Nhóm Năng Lượng$/m);
  assert.match(members, /\[2026-10-20 08:00\] Hạnh Mai — được Tuấn Anh thêm vào nhóm #m7101/);
  assert.match(members, /\[2026-10-20 08:30\] Đăng Khoa — tham gia nhóm #m7102/);
  assert.doesNotMatch(members, /Văn Bi|Người Cũ/, 'removed and out-of-range events are not "new members"');
  assert.match(members, /giới thiệu.*Em phụ trách điện mặt trời mái nhà tại công ty ABC, SĐT \[SĐT\].*#m7202/, 'intro is redacted');
  assert.match(members, /Tin thứ hai của Mai.*#m7203/, 'second intro message');
  assert.doesNotMatch(members, /Chào mọi người/, 'a greeting-only message is not an introduction');
  assert.doesNotMatch(members, /Tin thứ ba|TRƯỚC khi vào|người khác/, 'at most 2, only after joining, only their own');
  assert.doesNotMatch(allText(dir), /uid-|u-sys/, 'no uids in any file');
  assert.match(read(dir, 'index.md'), /members\.md/);
});

test('attachments.md: files, screenshots with text and links of the range, per group, without recalled ones', t => {
  const root = scratch(t);
  const db = memDb(t, { groups: [['g1', 'Nhóm Năng Lượng'], ['g2', 'Nhóm Khác']] });
  seedAttachments(db);
  msg(db, { msg_id: '5900', kind: 'link', msg_type: '6', ts: vn(2026, 10, 20, 12, 0), text: 'x https://example.com/p?id=1', url: 'https://example.com/p?id=1', title: 'Tiêu đề Link' });
  db.upsertLink({ msg_id: '5900', conv_id: 'g1', ts: vn(2026, 10, 20, 12, 0), url: 'https://example.com/p?id=1', domain: 'example.com', title: 'Tiêu đề Link' });
  // a file whose message was recalled afterwards: the files row stays, but it must not be exported
  msg(db, { msg_id: '5901', kind: 'recalled', msg_type: '20', ts: vn(2026, 10, 20, 12, 1), text: null });
  db.upsertFile({ msg_id: '5901', conv_id: 'g1', ts: vn(2026, 10, 20, 12, 1), file_name: 'THU-HOI.pdf', size: 10, status: 'stored', stored_path: 'data/files/g1/THU-HOI.pdf' });
  // out of range
  msg(db, { msg_id: '5902', kind: 'file', msg_type: '19', ts: NOW - 40 * D, text: null, title: 'CU-QUA.pdf' });
  db.upsertFile({ msg_id: '5902', conv_id: 'g1', ts: NOW - 40 * D, file_name: 'CU-QUA.pdf', size: 10, status: 'stored', stored_path: 'data/files/g1/CU-QUA.pdf' });

  const dir = runExport(db, root);
  const a = read(dir, 'attachments.md');
  assert.match(a, /^## Nhóm Năng Lượng$/m);
  assert.doesNotMatch(a, /Nhóm Khác/, 'a group without attachments is left out');
  assert.match(a, /^### File$/m);
  assert.ok(a.includes(`[2026-10-20 10:00] An: Bao-cao-NLTT.pdf (3,9 MB) → ${resolve(root, 'data/files/g1/2026-10-20_Bao-cao-NLTT.pdf')} #m5101`), a);
  assert.match(a, /^### Ảnh có chữ$/m);
  assert.match(a, /\[2026-10-20 09:20\] Bình: Bảng giá \| BẢNG GIÁ ĐIỆN .*#m5001$/m);
  assert.match(a, /#m5003$/m, 'a stored screenshot without a caption');
  assert.doesNotMatch(a, /#m5002/, 'a text_only photo (file deleted on purpose) has no file to open: it stays in the group file only');
  assert.doesNotMatch(a, /#m5004|#m5005/, 'images without text are not attachments');
  assert.match(a, /^### Link$/m);
  assert.match(a, /\[2026-10-20 12:00\] An: Tiêu đề Link — example\.com — https:\/\/example\.com\/p\?id=1 #m5900/);
  assert.doesNotMatch(a, /THU-HOI|CU-QUA/);
});

test('attachments.md and members.md exist (with a "none" line) when there is nothing to list', t => {
  const root = scratch(t);
  const db = memDb(t);
  msg(db);
  const dir = runExport(db, root);
  assert.match(read(dir, 'members.md'), /Không có/);
  assert.match(read(dir, 'attachments.md'), /Không có/);
});

// ---------------------------------------------------------------------------------------------------------------------
// selectGroupIds
// ---------------------------------------------------------------------------------------------------------------------

test('selectGroupIds: config tracked flags by default, --groups checked against config and database', t => {
  const db = memDb(t, { groups: [['g1', 'Một']] });
  db.upsertGroup({ conv_id: 'gdb', name: 'Chỉ trong DB', tracked: 0 });
  const config = { version: 1, groups: [
    { convId: 'g1', name: 'Một', tracked: true, note: '' },
    { convId: 'g2', name: 'Hai', tracked: true, note: '', missing: true },
    { convId: 'g3', name: 'Ba', tracked: false, note: '' },
  ] };
  assert.deepEqual(selectGroupIds({ config, db }), ['g1', 'g2'], 'tracked, even one that left Zalo (its messages stay in the database)');
  assert.deepEqual(selectGroupIds({ config, db, requested: ['g3', 'g3', 'gdb'] }), ['g3', 'gdb']);
  assert.throws(() => selectGroupIds({ config, db, requested: ['g1', 'nope'] }), err => err instanceof ExportError && /nope/.test(err.message));
  assert.deepEqual(selectGroupIds({ config: null, db }), ['g1'], 'no config: the tracked flag in the database');
  assert.throws(() => selectGroupIds({ config: { version: 1, groups: [{ convId: 'g3', name: 'Ba', tracked: false, note: '' }] }, db }), /theo dõi/);
});

// ---------------------------------------------------------------------------------------------------------------------
// zmi search (ruling 10, ruling 1, ruling 2)
// ---------------------------------------------------------------------------------------------------------------------

function seedSearch(db) {
  msg(db, { msg_id: '4001', ts: vn(2026, 10, 18, 9, 0), sender_name: 'An', text: 'Cập nhật DPPA: Bộ Công Thương hướng dẫn thủ tục mua bán điện trực tiếp' });
  msg(db, { msg_id: '4002', ts: vn(2026, 10, 20, 10, 30), sender_name: 'Bình', text: 'Ai có đầu mối DPPA gọi 0963 046 382 hoặc mail bi@example.com giúp mình' });
  msg(db, { msg_id: '4003', ts: vn(2026, 10, 21, 8, 0), sender_name: 'Chi', kind: 'recalled', msg_type: '20', text: 'DPPA THUHOI bí mật' });
  msg(db, { msg_id: '4004', ts: vn(2026, 10, 21, 9, 0), sender_name: 'Chi', kind: 'deleted', msg_type: '-27', text: 'DPPA DAXOA' });
  msg(db, { msg_id: '4005', ts: vn(2026, 10, 21, 9, 5), sender_name: 'Chi', kind: 'sticker', msg_type: '4', text: 'DPPA sticker' });
  msg(db, { msg_id: '4006', ts: vn(2026, 10, 21, 9, 6), sender_name: 'Chi', kind: 'video', msg_type: '18', text: 'DPPA video' });
  msg(db, { msg_id: '4007', ts: vn(2026, 10, 10, 9, 0), sender_name: 'Dũng', text: `${'Mở đầu dài. '.repeat(30)}Lộ trình DPPA nằm cuối tin nhắn dài này. ${'Phần đuôi. '.repeat(30)}` });
  msg(db, { msg_id: '4008', ts: vn(2026, 10, 19, 9, 0), sender_name: 'Em', conv_id: 'g2', text: 'Giá điện ĐẶC BIỆT hôm nay' });
  msg(db, { msg_id: '4009', ts: vn(2026, 10, 19, 9, 5), sender_name: 'Em', kind: 'photo', msg_type: '2', text: null });
  db.upsertImage({ msg_id: '4009', conv_id: 'g1', ts: vn(2026, 10, 19, 9, 5), has_text: 1, status: 'stored', stored_path: 'data/images/g1/4009.jpg', ocr_text: 'Poster hội thảo DPPA Hotline 0912 345 678' });
}

test('search: one line per hit, newest first, Vietnam time, group | sender: text #m<id>', t => {
  const db = memDb(t, { groups: [['g1', 'Nhóm Năng Lượng'], ['g2', 'Nhóm Hai']] });
  seedSearch(db);
  const { lines, total } = searchMessages(db, 'dppa');
  assert.equal(total, 4, 'recalled, deleted, sticker and video rows are excluded after the full-text match');
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map(l => l.match(/#m(\d+)$/)[1]), ['4002', '4009', '4001', '4007'], 'newest first');
  assert.match(lines[0], /^\[2026-10-20 10:30\] Nhóm Năng Lượng \| Bình: Ai có đầu mối DPPA gọi \[SĐT\] hoặc mail \[email\] giúp mình #m4002$/);
  assert.doesNotMatch(lines.join('\n'), /THUHOI|DAXOA|sticker|video|0963 046 382|bi@example/);
});

test('search: folds diacritics and d/đ, filters by group and range, honours --limit', t => {
  const db = memDb(t, { groups: [['g1', 'Nhóm Năng Lượng'], ['g2', 'Nhóm Hai']] });
  seedSearch(db);
  assert.equal(searchMessages(db, 'dac biet').total, 1);
  assert.match(searchMessages(db, 'đặc biệt').lines[0], /Nhóm Hai \| Em: Giá điện ĐẶC BIỆT hôm nay #m4008$/);
  assert.equal(searchMessages(db, 'dppa', { convIds: ['g2'] }).total, 0);
  assert.equal(searchMessages(db, 'dppa', { from: vn(2026, 10, 19), to: vn(2026, 10, 20, 23, 59) }).total, 2);
  const limited = searchMessages(db, 'dppa', { limit: 2 });
  assert.equal(limited.lines.length, 2);
  assert.equal(limited.total, 4, 'total is the number of hits, lines the number shown');
  assert.equal(searchMessages(db, 'khong-co-tu-nay').total, 0);
  assert.equal(searchMessages(db, '   ').total, 0);
});

test('search: a long message is cut to about 200 characters around the match; OCR hits are not redacted', t => {
  const db = memDb(t, { groups: [['g1', 'Nhóm Năng Lượng']] });
  seedSearch(db);
  const long = searchMessages(db, 'lộ trình').lines[0];
  const body = long.slice(long.indexOf(': ') + 2, long.lastIndexOf(' #m'));
  assert.ok([...body].length <= 206, `about 200 characters, got ${[...body].length}`);
  assert.match(body, /Lộ trình DPPA/, 'the window contains the match');
  assert.ok(body.startsWith('…') && body.endsWith('…'), 'cut ends are marked');

  const ocr = searchMessages(db, 'hội thảo').lines[0];
  assert.match(ocr, /\[Ảnh có chữ\] .*Poster hội thảo DPPA Hotline 0912 345 678 #m4009$/, 'OCR text is image content: not redacted');
});

test('formatSearchLine puts the pieces together', () => {
  assert.equal(
    formatSearchLine({ ts: vn(2026, 10, 3, 7, 9), group: 'Nhóm A', sender: 'An', content: 'nội dung', msgId: '123' }),
    '[2026-10-03 07:09] Nhóm A | An: nội dung #m123',
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------------------------------------------------

async function captured(fn) {
  const out = [];
  const err = [];
  const { log, error } = console;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = await fn();
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function cliScratch(t) {
  const dir = scratch(t);
  const dbPath = join(dir, 'data', 'zalo-mi.db');
  const configPath = join(dir, 'config', 'groups.json');
  mkdirSync(join(dir, 'config'), { recursive: true });
  const db = openDb(dbPath, { now: () => NOW });
  db.upsertGroup({ conv_id: 'g1', name: 'Nhóm Năng Lượng', tracked: 1 });
  db.upsertGroup({ conv_id: 'g2', name: 'Nhóm Mua Sắm', tracked: 0 });
  db.recordSyncRun({ started_at: NOW - H, finished_at: NOW - H + 5000, groups: 1, new_messages: 0, updated_messages: 0, errors_json: '[]' });
  db.upsertMessage({ msg_id: '3001', conv_id: 'g1', ts: NOW - D, sender_name: 'An', kind: 'text', text: 'Tin về DPPA hôm qua, gọi 0963046382' });
  db.upsertMessage({ msg_id: '3002', conv_id: 'g2', ts: NOW - D, sender_name: 'Bình', kind: 'text', text: 'Khuyến mãi DPPA ở nhóm mua sắm' });
  db.close();
  writeFileSync(configPath, JSON.stringify({ version: 1, groups: [
    { convId: 'g1', name: 'Nhóm Năng Lượng', tracked: true, note: '' },
    { convId: 'g2', name: 'Nhóm Mua Sắm', tracked: false, note: '' },
  ] }), 'utf8');
  return { dir, dbPath, configPath };
}

test('zmi export: tracked groups by default, prints a summary and the output directory as the LAST line', async t => {
  const s = cliScratch(t);
  const r = await captured(() => exportCommand({ dbPath: s.dbPath, configPath: s.configPath, now: () => NOW }));
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  const dir = lines.at(-1);
  assert.equal(dir, join(s.dir, 'exports', '20261022-1430'), 'default --out under the repo root derived from the database path');
  assert.ok(existsSync(join(dir, 'index.md')));
  assert.ok(existsSync(join(dir, 'Nhóm-Năng-Lượng.md')));
  assert.equal(existsSync(join(dir, 'Nhóm-Mua-Sắm.md')), false, 'untracked group not exported by default');
  assert.match(read(dir, 'Nhóm-Năng-Lượng.md'), /Tin về DPPA hôm qua, gọi \[SĐT\]/);
  assert.match(r.out, /1 nhóm/);
});

test('zmi export --groups / --from / --to / --out', async t => {
  const s = cliScratch(t);
  const out = join(s.dir, 'mine');
  const r = await captured(() => exportCommand({
    dbPath: s.dbPath, configPath: s.configPath, now: () => NOW, groups: 'g2', from: '2026-10-01', to: '2026-10-22', out,
  }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.split('\n').at(-1), out);
  assert.match(read(out, 'Nhóm-Mua-Sắm.md'), /Khuyến mãi DPPA/);
  assert.equal(existsSync(join(out, 'Nhóm-Năng-Lượng.md')), false);
});

test('zmi export: bad input exits 2 with a Vietnamese message, a missing database exits 1, nothing is written', async t => {
  const s = cliScratch(t);
  const run = opts => captured(() => exportCommand({ dbPath: s.dbPath, configPath: s.configPath, now: () => NOW, ...opts }));
  for (const bad of [{ from: '2026-13-40' }, { to: 'hôm qua' }, { from: '2026-10-05', to: '2026-10-01' }, { groups: 'khong-co' }, { groups: ' , ' }]) {
    const r = await run(bad);
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.ok(r.err.length > 0);
  }
  assert.equal(existsSync(join(s.dir, 'exports')), false, 'no export folder after a rejected command');
  const none = await captured(() => exportCommand({ dbPath: join(s.dir, 'nothing', 'data', 'zalo-mi.db'), configPath: s.configPath, now: () => NOW }));
  assert.equal(none.code, 1);
  assert.match(none.err, /node zmi\.mjs sync/);
  assert.equal(existsSync(join(s.dir, 'nothing')), false, 'no database is created');
});

test('zmi export warns on stdout when the data is stale', async t => {
  const s = cliScratch(t);
  const r = await captured(() => exportCommand({ dbPath: s.dbPath, configPath: s.configPath, now: () => NOW + 3 * D }));
  assert.equal(r.code, 0);
  assert.match(r.out, /CẢNH BÁO/);
  assert.match(r.out.split('\n').at(-1), /exports/);
});

test('zmi search: prints the hit lines, tracked groups only by default, --groups widens, --limit cuts', async t => {
  const s = cliScratch(t);
  const run = opts => captured(() => searchCommand({ dbPath: s.dbPath, configPath: s.configPath, query: 'dppa', ...opts }));
  const r = await run();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\[\d{4}-\d\d-\d\d \d\d:\d\d\] Nhóm Năng Lượng \| An: Tin về DPPA hôm qua, gọi \[SĐT\] #m3001$/m);
  assert.doesNotMatch(r.out, /Mua Sắm/);
  const wide = await run({ groups: 'g1,g2' });
  assert.match(wide.out, /Nhóm Mua Sắm \| Bình: /);
  const cut = await run({ groups: 'g1,g2', limit: 1 });
  assert.equal(cut.out.split('\n').filter(l => l.startsWith('[')).length, 1);
  assert.match(cut.out, /1\/2/, 'says how many of how many hits are shown');
  const none = await run({ query: 'khong-co-tu-nay' });
  assert.equal(none.code, 0);
  assert.match(none.out, /Không tìm thấy/);
  const missing = await run({ query: '' });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /từ khóa/);
});

test('zmi.mjs CLI: export/search flags are validated per command', () => {
  const zmi = join(import.meta.dirname, '..', 'zmi.mjs');
  const run = (...args) => spawnSync(process.execPath, ['--no-warnings', zmi, ...args], { encoding: 'utf8' });
  for (const args of [['sync', '--from', '2026-10-01'], ['groups', '--out', 'x'], ['search', 'dppa', '--out', 'x'], ['export', '--limit', '5'], ['files', '--to', '2026-10-01'], ['export', '--limit', 'x']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
  }
  const help = run('--help').stdout;
  assert.match(help, /export/);
  assert.match(help, /search/);
});

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
