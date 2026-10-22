import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  suggestTracked, mergeGroups, readGroupsConfig, writeGroupsConfig, formatGroupsTable, AUTO_NOTE, GroupsConfigError,
} from '../lib/groups.mjs';
import { groupsCommand } from '../zmi.mjs';
import { CdpError } from '../lib/cdp.mjs';
import { openDb } from '../lib/db.mjs';

const root = join(import.meta.dirname, '..');

/** suggestTracked for a single name. */
const suggest = name => suggestTracked([{ convId: 'g1', name }]).g1;

// ---------------------------------------------------------------------------
// suggestTracked
// ---------------------------------------------------------------------------

test('suggestTracked turns on every keyword of the spec', () => {
  const names = [
    'Diễn đàn Năng Lượng Việt Nam', // năng lượng
    'Solar Technology VN',
    'Hỏi đáp kỹ thuật Điện Mặt Trời', // điện
    'Điện gió ngoài khơi', // gió
    'BESS Technology VN',
    'Renewable Energy',
    'RE Developers Vietnam', // RE, whole word, uppercase
    'ESG & Carbon Club',
    'Hội carbon Việt Nam',
    'Chuyên gia NLTT',
    'Năng lượng tái tạo Việt Nam', // tái tạo
    'Tái tạo Việt Nam',
    'Pin lưu trữ Việt Nam', // pin, whole word
  ];
  for (const name of names) assert.equal(suggest(name), true, name);
});

test('suggestTracked ignores case, and accepts names typed without diacritics', () => {
  for (const name of ['NĂNG LƯỢNG SẠCH', 'nang luong sach', 'DIEN MAT TROI', 'dien gio', 'SOLAR', 'bess', 'Tai Tao Viet Nam']) {
    assert.equal(suggest(name), true, name);
  }
});

test('suggestTracked does not mistake other Vietnamese words for the keywords', () => {
  // The diacritics that are present must agree: "diễn" is not "điện" and "giờ" is not "gió".
  for (const name of ['Diễn Thành 10 years ago', 'Họp lúc 9 giờ', 'Lương tháng 13', 'Nắng đẹp']) {
    assert.equal(suggest(name), false, name);
  }
});

test('suggestTracked: RE counts only as an uppercase whole word, pin only as a whole word', () => {
  for (const name of ['Real Estate', 'Re: bàn việc', 'Re-invest club', 'VREN - LAOS', 'CARE Vietnam', 'Spin class', 'Pinterest VN']) {
    assert.equal(suggest(name), false, name);
  }
  assert.equal(suggest('Nhóm RE-Developers'), true);
  assert.equal(suggest('PIN mặt trời'), true);
});

test('suggestTracked turns off the clearly unrelated groups (brief cases)', () => {
  for (const name of ['SĂN SALE SHOPEE | NGHIỆN SHOPPING 🛍', 'Cần Giờ Adventure', 'Cơ Điện K5 Khoá 2007', 'Cơ Điện K5 Khoá 2007-2011']) {
    assert.equal(suggest(name), false, name);
  }
});

test('suggestTracked: exclusions win over keywords', () => {
  const names = [
    'Solar Shopping Club', 'Săn sale solar', 'Shopee điện máy', // shopping
    'Du lịch điện gió', 'Solar Adventure', 'Energy Schedule 2026', // travel
    'Cơ Điện K5', 'Bách khoa Điện K12', 'Cơ điện khóa 2007', 'Điện lực Khoá 2001-2005', // class cohorts
  ];
  for (const name of names) assert.equal(suggest(name), false, name);
});

test('suggestTracked: exclusions are specific (sales, a bare year, a letter before K)', () => {
  assert.equal(suggest('Solar Sales Vietnam'), true, '"sales" is not "sale"');
  assert.equal(suggest('Năng lượng 2026'), true, 'a year alone is not a class cohort');
  assert.equal(suggest('Khóa học năng lượng'), true, '"khóa học" without a year is a course, not a cohort');
});

test('suggestTracked returns one boolean per convId and tolerates empty names', () => {
  assert.deepEqual(suggestTracked([]), {});
  assert.deepEqual(
    suggestTracked([
      { convId: 'g1', name: 'Solar VN', totalMember: 5 },
      { convId: 'g2', name: 'Gia đình' },
      { convId: 'g3', name: '' },
      { convId: 'g4', name: null },
      { convId: 'g5' },
    ]),
    { g1: true, g2: false, g3: false, g4: false, g5: false },
  );
});

// ---------------------------------------------------------------------------
// mergeGroups (config/groups.json is the source of truth for `tracked`)
// ---------------------------------------------------------------------------

const zalo = (convId, name, over = {}) => ({ convId, name, totalMember: 10, isGroup: true, ...over });
const entry = (convId, name, tracked, note = '', over = {}) => ({ convId, name, tracked, note, ...over });

test('mergeGroups on a first run creates version 1 with suggested tracked flags and the auto note', () => {
  const { config, added, missing } = mergeGroups(null, [zalo('g1', 'Solar VN'), zalo('g2', 'Gia đình')]);
  assert.deepEqual(config, {
    version: 1,
    groups: [entry('g1', 'Solar VN', true, AUTO_NOTE), entry('g2', 'Gia đình', false, AUTO_NOTE)],
  });
  assert.equal(AUTO_NOTE, 'đề xuất tự động');
  assert.deepEqual(added.map(g => g.convId), ['g1', 'g2']);
  assert.deepEqual(missing, []);
});

test('mergeGroups keeps what Cong edited, and only refreshes the name', () => {
  const existing = {
    version: 1,
    groups: [
      entry('g1', 'Tên cũ', false, 'Cong tắt vì nhiều tin rác'), // would be suggested, Cong switched it off
      entry('g2', 'Gia đình', true, 'Cong bật tay'), // would not be suggested, Cong switched it on
    ],
  };
  const { config, added } = mergeGroups(existing, [zalo('g1', 'Solar VN mới'), zalo('g2', 'Gia đình')]);
  assert.deepEqual(config.groups.find(g => g.convId === 'g1'), entry('g1', 'Solar VN mới', false, 'Cong tắt vì nhiều tin rác'));
  assert.deepEqual(config.groups.find(g => g.convId === 'g2'), entry('g2', 'Gia đình', true, 'Cong bật tay'));
  assert.deepEqual(added, []);
});

test('mergeGroups adds new groups with a suggestion and leaves existing ones alone', () => {
  const existing = { version: 1, groups: [entry('g1', 'Solar VN', true, 'ghi chú')] };
  const { config, added } = mergeGroups(existing, [zalo('g1', 'Solar VN'), zalo('g2', 'BESS Vietnam'), zalo('g3', 'Beer Group')]);
  assert.deepEqual(added.map(g => g.convId).sort(), ['g2', 'g3']);
  assert.deepEqual(config.groups.find(g => g.convId === 'g2'), entry('g2', 'BESS Vietnam', true, AUTO_NOTE));
  assert.deepEqual(config.groups.find(g => g.convId === 'g3'), entry('g3', 'Beer Group', false, AUTO_NOTE));
  assert.equal(config.groups.find(g => g.convId === 'g1').note, 'ghi chú');
});

test('mergeGroups keeps groups that left Zalo, flagged missing, and never deletes them', () => {
  const existing = { version: 1, groups: [entry('g1', 'Solar VN', true, 'quan trọng'), entry('g2', 'Nhóm cũ', false)] };
  const { config, missing } = mergeGroups(existing, [zalo('g2', 'Nhóm cũ')]);
  assert.deepEqual(config.groups.find(g => g.convId === 'g1'), entry('g1', 'Solar VN', true, 'quan trọng', { missing: true }));
  assert.equal('missing' in config.groups.find(g => g.convId === 'g2'), false);
  assert.deepEqual(missing.map(g => g.convId), ['g1']);
  assert.equal(config.groups.length, 2);
});

test('mergeGroups clears the missing flag when a group is back on Zalo', () => {
  const existing = { version: 1, groups: [entry('g1', 'Solar VN', true, 'x', { missing: true })] };
  const { config, missing } = mergeGroups(existing, [zalo('g1', 'Solar VN')]);
  assert.deepEqual(config.groups, [entry('g1', 'Solar VN', true, 'x')]);
  assert.deepEqual(missing, []);
});

test('mergeGroups makes one entry for a group that Zalo lists twice, and rejects a group without a string convId', () => {
  const { config } = mergeGroups(null, [zalo('g1', 'Solar VN'), zalo('g1', 'Solar VN')]);
  assert.equal(config.groups.length, 1);
  assert.throws(() => mergeGroups(null, [{ name: 'không có id' }]), TypeError);
  assert.throws(() => mergeGroups(null, [zalo(123, 'id là số')]), TypeError);
});

test('mergeGroups sorts tracked first, then by name', () => {
  const { config } = mergeGroups(null, [
    zalo('g1', 'Zeta'), zalo('g2', 'Solar B'), zalo('g3', 'Alpha'), zalo('g4', 'Solar A'), zalo('g5', 'Điện gió'),
  ]);
  assert.deepEqual(config.groups.map(g => g.name), ['Điện gió', 'Solar A', 'Solar B', 'Alpha', 'Zeta']);
  assert.deepEqual(config.groups.map(g => g.tracked), [true, true, true, false, false]);
});

test('mergeGroups is idempotent, keeps unknown fields and does not touch its input', () => {
  const existing = { version: 1, groups: [entry('g1', 'Solar VN', true, 'x', { owner: 'Cong' })] };
  const snapshot = structuredClone(existing);
  const list = [zalo('g1', 'Solar VN'), zalo('g2', 'Gia đình')];
  const once = mergeGroups(existing, list).config;
  const twice = mergeGroups(once, list).config;
  assert.deepEqual(twice, once);
  assert.equal(once.groups.find(g => g.convId === 'g1').owner, 'Cong');
  assert.deepEqual(existing, snapshot);
});

// ---------------------------------------------------------------------------
// config file: read, validate, write atomically
// ---------------------------------------------------------------------------

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zmi-groups-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('readGroupsConfig returns null when the file does not exist', t => {
  assert.equal(readGroupsConfig(join(scratch(t), 'config', 'groups.json')), null);
});

test('writeGroupsConfig writes UTF-8 with 2-space indent, creates the folder, and leaves no temp file', t => {
  const dir = scratch(t);
  const path = join(dir, 'config', 'groups.json');
  const config = { version: 1, groups: [entry('g1', '☀️ Năng lượng', true, 'đề xuất tự động')] };
  writeGroupsConfig(path, config);
  const text = readFileSync(path, 'utf8');
  assert.equal(text, `${JSON.stringify(config, null, 2)}\n`);
  assert.match(text, /Năng lượng/, 'Vietnamese stays readable, not \\u-escaped');
  assert.deepEqual(readdirSync(join(dir, 'config')), ['groups.json']);
  assert.deepEqual(readGroupsConfig(path), config);
  writeGroupsConfig(path, { version: 1, groups: [] }); // overwrite an existing file
  assert.deepEqual(readGroupsConfig(path), { version: 1, groups: [] });
  assert.deepEqual(readdirSync(join(dir, 'config')), ['groups.json']);
});

test('writeGroupsConfig cleans up its temp file when the rename fails', t => {
  const dir = scratch(t);
  const path = join(dir, 'groups.json');
  mkdirSync(path); // a directory cannot be replaced by a file, so the final rename fails
  assert.throws(() => writeGroupsConfig(path, { version: 1, groups: [] }));
  assert.deepEqual(readdirSync(dir), ['groups.json'], 'only the directory is left, no groups.json.*.tmp');
});

test('readGroupsConfig refuses a broken file instead of letting it be overwritten', t => {
  const dir = scratch(t);
  const path = join(dir, 'groups.json');
  const broken = [
    ['{ không phải json', /JSON/],
    [JSON.stringify({ version: 2, groups: [] }), /version/],
    [JSON.stringify({ version: 1 }), /groups/],
    [JSON.stringify({ version: 1, groups: [{ name: 'thiếu convId', tracked: true }] }), /convId/],
    [JSON.stringify({ version: 1, groups: [{ convId: 'g1', name: 'x', tracked: 'true' }] }), /tracked/],
    [JSON.stringify({ version: 1, groups: [entry('g1', 'a', true), entry('g1', 'b', false)] }), /g1/],
  ];
  for (const [content, pattern] of broken) {
    writeFileSync(path, content);
    assert.throws(() => readGroupsConfig(path), error => error instanceof GroupsConfigError && pattern.test(error.message) && /groups\.json/.test(error.message), content);
  }
});

test('readGroupsConfig fills in a missing name or note', t => {
  const path = join(scratch(t), 'groups.json');
  writeFileSync(path, JSON.stringify({ version: 1, groups: [{ convId: 'g1', tracked: true }] }));
  assert.deepEqual(readGroupsConfig(path), { version: 1, groups: [entry('g1', '', true, '')] });
});

test('readGroupsConfig accepts a file saved with a BOM (Notepad does that)', t => {
  const path = join(scratch(t), 'groups.json');
  writeFileSync(path, `﻿${JSON.stringify({ version: 1, groups: [entry('g1', 'Solar VN', true, 'x')] })}`);
  assert.deepEqual(readGroupsConfig(path), { version: 1, groups: [entry('g1', 'Solar VN', true, 'x')] });
});

// ---------------------------------------------------------------------------
// formatGroupsTable
// ---------------------------------------------------------------------------

test('formatGroupsTable has the Vietnamese headers, one row per group and the summary line', () => {
  const config = {
    version: 1,
    groups: [
      entry('g1', 'Solar VN', true, 'đề xuất tự động'),
      entry('g2', 'Gia đình', false, ''),
      entry('g3', 'Nhóm cũ', true, 'x', { missing: true }),
    ],
  };
  const text = formatGroupsTable(config, new Map([['g1', 1000], ['g2', 4]]));
  const lines = text.split('\n');
  assert.match(lines[0], /^Tên nhóm\s+Số thành viên\s+Theo dõi\s+Ghi chú$/);
  assert.match(text, /Solar VN\s+1000\s+✓\s+đề xuất tự động/);
  assert.match(text, /Gia đình\s+4\s+–/);
  assert.match(text, /Nhóm cũ\s+–\s+✓\s+x \(không còn trên Zalo\)/, 'unknown member count is a dash, missing groups are labelled');
  assert.match(text, /Đang theo dõi 2\/3 nhóm/);
  assert.equal(lines.at(-1), 'Đang theo dõi 2/3 nhóm');
});

test('formatGroupsTable lines the columns up and cuts very long names', () => {
  const longName = 'Một cái tên nhóm rất dài '.repeat(5).trim();
  const config = {
    version: 1,
    groups: [entry('g1', 'Điện gió Việt Nam', true, 'a'), entry('g2', longName, false, 'b'), entry('g3', 'Ngắn', false, 'c')],
  };
  const [header, ...rows] = formatGroupsTable(config, new Map([['g1', 431], ['g2', 12], ['g3', 3]])).split('\n').slice(0, 4);
  const trackedAt = header.indexOf('Theo dõi');
  const noteAt = header.indexOf('Ghi chú');
  for (const row of rows) {
    assert.match(row[trackedAt], /[✓–]/, 'tracked mark sits under its header');
    assert.equal(row.length - 1, noteAt, 'note sits under its header');
  }
  const nameCell = rows[1].slice(0, header.indexOf('Số thành viên')).trimEnd();
  assert.ok(nameCell.endsWith('…') && nameCell.length <= 50, 'a very long name is cut with an ellipsis');
});

test('formatGroupsTable keeps emoji names intact', () => {
  const name = '☀️ Future Energy Vietnam 🇻🇳';
  assert.match(formatGroupsTable({ version: 1, groups: [entry('g1', name, true, '')] }, new Map([['g1', 431]])), /☀️ Future Energy Vietnam 🇻🇳\s+431\s+✓/);
});

test('formatGroupsTable shows the convId for a group without a name', () => {
  const text = formatGroupsTable({ version: 1, groups: [entry('g99', '', false)] });
  assert.match(text, /g99/);
});

// ---------------------------------------------------------------------------
// zmi groups [--refresh]
// ---------------------------------------------------------------------------

/** Runs groupsCommand with a fake Zalo that lists `zaloGroups`, or fails to open with `openError`. */
async function run(t, paths, { refresh = false, zaloGroups = [], openError = null } = {}) {
  const out = [];
  const err = [];
  t.mock.method(console, 'log', (...a) => out.push(a.join(' ')));
  t.mock.method(console, 'error', (...a) => err.push(a.join(' ')));
  const state = { opened: 0, closed: 0, listed: 0 };
  const open = async () => {
    state.opened++;
    if (openError) throw openError;
    return { listGroups: async () => { state.listed++; return zaloGroups; }, close() { state.closed++; } };
  };
  const code = await groupsCommand({ refresh, port: 9222, open, configPath: paths.config, dbPath: paths.db });
  return { code, out: out.join('\n'), err: err.join('\n'), ...state };
}

const paths = dir => ({ config: join(dir, 'config', 'groups.json'), db: join(dir, 'data', 'zalo-mi.db') });
const dbRows = file => {
  const db = openDb(file);
  try { return db.raw.prepare('SELECT conv_id, name, description, total_member, tracked FROM "groups" ORDER BY conv_id').all().map(r => ({ ...r })); } finally { db.close(); }
};

test('zmi groups without a config tells Cong to run --refresh, and never touches Zalo', async t => {
  const p = paths(scratch(t));
  const r = await run(t, p);
  assert.equal(r.code, 1);
  assert.match(r.err, /--refresh/);
  assert.match(r.err, /node zmi\.mjs groups --refresh/);
  assert.equal(r.opened, 0, 'Zalo not contacted');
  assert.equal(existsSync(p.config), false);
  assert.equal(existsSync(p.db), false);
});

test('zmi groups --refresh reads Zalo, writes the config and the DB, then prints the table', async t => {
  const p = paths(scratch(t));
  const r = await run(t, p, {
    refresh: true,
    zaloGroups: [
      zalo('g1', 'Solar Technology VN', { totalMember: 1000, description: 'Mô tả nhóm solar' }),
      zalo('g2', 'Gia Đình', { totalMember: 4, description: null }),
      zalo('g3', 'SĂN SALE SHOPEE', { totalMember: 660 }),
    ],
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.opened, r.listed, r.closed], [1, 1, 1], 'the bridge is opened, read once and closed');

  assert.deepEqual(readGroupsConfig(p.config), {
    version: 1,
    groups: [entry('g1', 'Solar Technology VN', true, AUTO_NOTE), entry('g2', 'Gia Đình', false, AUTO_NOTE), entry('g3', 'SĂN SALE SHOPEE', false, AUTO_NOTE)],
  });
  assert.deepEqual(dbRows(p.db), [
    { conv_id: 'g1', name: 'Solar Technology VN', description: 'Mô tả nhóm solar', total_member: 1000, tracked: 1 },
    { conv_id: 'g2', name: 'Gia Đình', description: null, total_member: 4, tracked: 0 },
    { conv_id: 'g3', name: 'SĂN SALE SHOPEE', description: null, total_member: 660, tracked: 0 },
  ]);
  assert.match(r.out, /Tên nhóm\s+Số thành viên\s+Theo dõi\s+Ghi chú/);
  assert.match(r.out, /Solar Technology VN\s+1000\s+✓/);
  assert.match(r.out, /Đang theo dõi 1\/3 nhóm/);
  assert.doesNotMatch(r.out, /Mô tả nhóm solar/, 'descriptions are stored, not printed');
});

test('zmi groups --refresh keeps Cong\'s edits, adds new groups, marks vanished ones, and syncs tracked to the DB', async t => {
  const p = paths(scratch(t));
  await run(t, p, { refresh: true, zaloGroups: [zalo('g1', 'Solar VN'), zalo('g2', 'Gia Đình'), zalo('g3', 'Nhóm sắp biến mất')] });

  // Cong edits the file by hand.
  const edited = readGroupsConfig(p.config);
  edited.groups.find(g => g.convId === 'g1').tracked = false;
  edited.groups.find(g => g.convId === 'g1').note = 'tạm tắt';
  edited.groups.find(g => g.convId === 'g2').tracked = true;
  writeGroupsConfig(p.config, edited);

  const r = await run(t, p, {
    refresh: true,
    zaloGroups: [zalo('g1', 'Solar VN (đổi tên)', { totalMember: 11 }), zalo('g2', 'Gia Đình', { totalMember: 5 }), zalo('g4', 'BESS Vietnam', { totalMember: 30 })],
  });
  assert.equal(r.code, 0, r.err);

  const config = readGroupsConfig(p.config);
  const byId = Object.fromEntries(config.groups.map(g => [g.convId, g]));
  assert.deepEqual(byId.g1, entry('g1', 'Solar VN (đổi tên)', false, 'tạm tắt'));
  assert.equal(byId.g2.tracked, true);
  assert.deepEqual(byId.g4, entry('g4', 'BESS Vietnam', true, AUTO_NOTE));
  assert.equal(byId.g3.missing, true);
  assert.equal(config.groups.length, 4, 'nothing deleted');

  const db = Object.fromEntries(dbRows(p.db).map(row => [row.conv_id, row]));
  assert.equal(db.g1.tracked, 0, 'the DB follows the config, not the keyword guess');
  assert.equal(db.g1.name, 'Solar VN (đổi tên)');
  assert.equal(db.g1.total_member, 11);
  assert.equal(db.g2.tracked, 1);
  assert.equal(db.g4.tracked, 1);
  assert.match(r.out, /Đang theo dõi 2\/4 nhóm/);
  assert.match(r.out, /không còn trên Zalo/);
});

test('zmi groups prints the table from the config without touching Zalo, with member counts from the DB', async t => {
  const p = paths(scratch(t));
  await run(t, p, { refresh: true, zaloGroups: [zalo('g1', 'Solar VN', { totalMember: 321 }), zalo('g2', 'Gia Đình', { totalMember: 4 })] });
  const r = await run(t, p, { openError: new Error('Zalo must not be contacted') });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.opened, 0);
  assert.match(r.out, /Solar VN\s+321\s+✓/);
  assert.match(r.out, /Gia Đình\s+4\s+–/);
  assert.match(r.out, /Đang theo dõi 1\/2 nhóm/);
});

test('zmi groups still works from the config alone when there is no database yet', async t => {
  const p = paths(scratch(t));
  writeGroupsConfig(p.config, { version: 1, groups: [entry('g1', 'Solar VN', true, 'x')] });
  const r = await run(t, p);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Solar VN\s+–\s+✓\s+x/);
  assert.equal(existsSync(p.db), false, 'listing does not create the database');
});

test('zmi groups --refresh with Zalo closed explains how to open it and changes nothing', async t => {
  const p = paths(scratch(t));
  writeGroupsConfig(p.config, { version: 1, groups: [entry('g1', 'Solar VN', true, 'x')] });
  const before = readFileSync(p.config, 'utf8');
  const r = await run(t, p, { refresh: true, openError: new CdpError('PORT_CLOSED', 'Không kết nối được cổng debug 9222 của Zalo.') });
  assert.equal(r.code, 1);
  assert.match(r.err, /9222/);
  assert.match(r.err, /Zalo \(MI\)/);
  assert.equal(readFileSync(p.config, 'utf8'), before);
  assert.equal(existsSync(p.db), false);
});

test('zmi groups --refresh refuses an empty list from Zalo instead of marking everything missing', async t => {
  const p = paths(scratch(t));
  writeGroupsConfig(p.config, { version: 1, groups: [entry('g1', 'Solar VN', true, 'x')] });
  const before = readFileSync(p.config, 'utf8');
  const r = await run(t, p, { refresh: true, zaloGroups: [] });
  assert.equal(r.code, 1);
  assert.match(r.err, /0 nhóm/);
  assert.equal(readFileSync(p.config, 'utf8'), before);
  assert.equal(r.closed, 1, 'the bridge is still closed');
});

test('zmi groups stops on a broken config before contacting Zalo or changing anything', async t => {
  const p = paths(scratch(t));
  mkdirSync(join(p.config, '..'), { recursive: true });
  writeFileSync(p.config, '{ cong sửa dở');
  for (const refresh of [false, true]) {
    const r = await run(t, p, { refresh, zaloGroups: [zalo('g1', 'Solar VN')] });
    assert.equal(r.code, 1);
    assert.match(r.err, /groups\.json/);
    assert.equal(r.opened, 0);
  }
  assert.equal(readFileSync(p.config, 'utf8'), '{ cong sửa dở', 'Cong\'s file is left as it was');
});

// ---------------------------------------------------------------------------
// the real CLI
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

test('the CLI keeps stderr clean: no node:sqlite ExperimentalWarning (run WITHOUT --no-warnings)', () => {
  const run = spawnSync(process.execPath, [join(root, 'zmi.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /groups/, 'usage lists the groups command');
  assert.equal(run.stderr, '', 'nothing on stderr');
});

test('zmi groups --refresh against a closed port exits 1 with guidance and no warning noise', async () => {
  const port = await freePort();
  const run = spawnSync(process.execPath, [join(root, 'zmi.mjs'), 'groups', '--refresh', '--port', String(port)], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Zalo \(MI\)/);
  assert.doesNotMatch(run.stderr, /ExperimentalWarning/);
});

test('zmi rejects --refresh on other commands', () => {
  const run = spawnSync(process.execPath, ['--no-warnings', join(root, 'zmi.mjs'), 'doctor', '--refresh'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--refresh/);
});
