// Which Zalo groups to follow (spec section 6.2): keyword suggestion, the config/groups.json merge rules,
// the printed table. Pure logic: no Zalo, no SQLite import (the DB is passed in).
//
// config/groups.json is the source of truth for `tracked`. A refresh never overrides what Cong set by hand:
// existing entries keep `tracked` and `note` (only the name follows Zalo), new groups get the keyword suggestion,
// and groups that left Zalo are kept with `missing: true` rather than deleted.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const AUTO_NOTE = 'đề xuất tự động';

const CONFIG_VERSION = 1;
const CONFIG_LABEL = 'config/groups.json';
const NAME_MAX_WIDTH = 50;

// ---------------------------------------------------------------------------
// Keyword suggestion
// ---------------------------------------------------------------------------

const BASE_LETTER = ch => ch.normalize('NFD').replace(/\p{M}/gu, '').replace('đ', 'd');
const escapeRegExp = ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Regex source for `phrase`, written in lower case. A letter that carries a diacritic in the phrase also accepts its
 * bare letter (so "điện" matches "dien"), but a letter in the text that carries a *different* diacritic does not:
 * "diễn" is not "điện" and "giờ" is not "gió".
 */
function tolerant(phrase) {
  return [...phrase.normalize('NFC')].map(ch => {
    if (/\s/u.test(ch)) return '\\s+';
    const base = BASE_LETTER(ch);
    return base === ch ? escapeRegExp(ch) : `[${ch}${base}]`;
  }).join('');
}

/** Whole word: no letter directly before or after (digits may touch, as in "BESS2026"). */
const wholeWord = source => `(?<!\\p{L})(?:${source})(?!\\p{L})`;

const KEYWORDS = new RegExp([
  tolerant('năng lượng'), 'solar', tolerant('điện'), wholeWord(tolerant('gió')), wholeWord('bess'), 'energy',
  wholeWord('esg'), 'carbon', wholeWord('nltt'), tolerant('tái tạo'), wholeWord('pin'),
].join('|'), 'u');

// "RE" (renewable energy) is only a keyword in capitals and as a whole word: "Re:" and "Real Estate" are not.
const UPPERCASE_RE = /(?<!\p{L})RE(?!\p{L})/u;

const EXCLUSIONS = new RegExp([
  'shopping', 'shopee', wholeWord('sale'), // shopping
  tolerant('du lịch'), 'adventure', 'schedule', // travel
  '(?<![\\p{L}\\p{N}])k\\d+(?!\\p{L})', // class cohort: K5, K12
  `${tolerant('khóa')}\\s*\\d{4}`, `${tolerant('khoá')}\\s*\\d{4}`, // class cohort: "Khoá 2007"
].join('|'), 'u');

function looksRelevant(name) {
  if (typeof name !== 'string' || name === '') return false;
  const text = name.normalize('NFC');
  const lower = text.toLowerCase();
  return (KEYWORDS.test(lower) || UPPERCASE_RE.test(text)) && !EXCLUSIONS.test(lower);
}

/**
 * Guesses which groups are about energy, from the group name: keywords (năng lượng, solar, điện, gió, BESS, energy,
 * RE, ESG, carbon, NLTT, tái tạo, pin) minus exclusions (shopping, travel, class cohorts), which always win.
 * @param {{ convId: string, name?: string|null }[]} groups
 * @returns {Record<string, boolean>}
 */
export function suggestTracked(groups) {
  return Object.fromEntries(groups.map(g => [g.convId, looksRelevant(g.name)]));
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const byName = new Intl.Collator('vi', { sensitivity: 'base' });
const trackedFirstThenName = (a, b) =>
  Number(b.tracked) - Number(a.tracked) || byName.compare(a.name, b.name) || (a.convId < b.convId ? -1 : 1);

/**
 * Merges Zalo's current group list into the config (or `null` for a first run). Does not modify its arguments.
 * @param {{ version: number, groups: object[] } | null} existing
 * @param {{ convId: string, name?: string }[]} zaloGroups
 * @returns {{ config: object, added: object[], missing: object[] }} `added`: entries created by this merge;
 *   `missing`: entries whose group is no longer on Zalo.
 */
export function mergeGroups(existing, zaloGroups) {
  const known = new Map((existing?.groups ?? []).map(g => [g.convId, g]));
  const suggestions = suggestTracked(zaloGroups);
  const groups = [];
  const added = [];
  const onZalo = new Set();

  for (const { convId, name } of zaloGroups) {
    if (typeof convId !== 'string' || convId === '') throw new TypeError('Zalo trả về một nhóm không có convId dạng chuỗi.');
    if (onZalo.has(convId)) continue; // listed twice by Zalo: one entry is enough
    onZalo.add(convId);
    const previous = known.get(convId);
    if (previous) {
      const { missing: _backOnZalo, ...kept } = previous;
      groups.push({ ...kept, name: name || previous.name });
    } else {
      const created = { convId, name: name ?? '', tracked: suggestions[convId], note: AUTO_NOTE };
      groups.push(created);
      added.push(created);
    }
  }

  const missing = [];
  for (const [convId, previous] of known) {
    if (onZalo.has(convId)) continue;
    const kept = { ...previous, missing: true };
    groups.push(kept);
    missing.push(kept);
  }

  groups.sort(trackedFirstThenName);
  return { config: { version: CONFIG_VERSION, groups }, added, missing };
}

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

export class GroupsConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GroupsConfigError';
  }
}

function invalid(detail) {
  return new GroupsConfigError(`${CONFIG_LABEL} có lỗi: ${detail}. zmi không ghi đè file này; hãy sửa lỗi rồi chạy lại.`);
}

/**
 * Reads and validates the config. Returns null if the file does not exist.
 * @throws {GroupsConfigError} when the file is unreadable as JSON or an entry is malformed (it is never overwritten then).
 */
export function readGroupsConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, '')); // Notepad adds a BOM
  } catch (error) {
    throw invalid(`không phải JSON hợp lệ (${error.message})`);
  }
  if (data?.version !== CONFIG_VERSION) throw invalid(`version phải là ${CONFIG_VERSION}`);
  if (!Array.isArray(data.groups)) throw invalid('thiếu mảng "groups"');

  const seen = new Set();
  const groups = data.groups.map((group, index) => {
    const where = `nhóm thứ ${index + 1}`;
    if (group === null || typeof group !== 'object' || Array.isArray(group)) throw invalid(`${where} không phải một đối tượng`);
    const { convId, name = '', tracked, note = '', ...rest } = group;
    if (typeof convId !== 'string' || convId === '') throw invalid(`${where} thiếu convId (chuỗi)`);
    if (typeof tracked !== 'boolean') throw invalid(`${where} (${convId}): "tracked" phải là true hoặc false`);
    if (typeof name !== 'string' || typeof note !== 'string') throw invalid(`${where} (${convId}): "name" và "note" phải là chuỗi`);
    if (seen.has(convId)) throw invalid(`convId ${convId} xuất hiện hai lần`);
    seen.add(convId);
    return { convId, name, tracked, note, ...rest };
  });
  return { version: CONFIG_VERSION, groups };
}

/** Writes the config as UTF-8 JSON (2-space indent) via a temp file and a rename, so a crash never leaves half a file. */
export function writeGroupsConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Upserts every Zalo group into `groups`, with `tracked` (0/1) taken from the merged config. */
export function saveGroupsToDb(db, zaloGroups, config) {
  const tracked = new Map(config.groups.map(g => [g.convId, g.tracked]));
  db.transaction(() => {
    for (const g of zaloGroups) {
      db.upsertGroup({
        conv_id: g.convId,
        name: g.name,
        description: g.description,
        total_member: g.totalMember,
        tracked: tracked.get(g.convId) ? 1 : 0,
      });
    }
  });
}

/** conv_id -> member count, as of the last refresh. */
export function readMemberCounts(db) {
  const rows = db.raw.prepare('SELECT conv_id, total_member FROM "groups" WHERE total_member IS NOT NULL').all();
  return new Map(rows.map(r => [r.conv_id, r.total_member]));
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/** Terminal cells a string takes: 0 for combining marks and emoji joiners, 2 for emoji and CJK, else 1. */
function displayWidth(text) {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (/\p{M}/u.test(ch) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    const wide = (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60);
    width += wide ? 2 : 1;
  }
  return width;
}

function fit(text, maxWidth) {
  if (displayWidth(text) <= maxWidth) return text;
  let cut = '';
  for (const ch of text) {
    if (displayWidth(cut + ch) > maxWidth - 1) break;
    cut += ch;
  }
  return `${cut}…`;
}

const padEnd = (text, width) => text + ' '.repeat(Math.max(0, width - displayWidth(text)));
const padStart = (text, width) => ' '.repeat(Math.max(0, width - displayWidth(text))) + text;

/**
 * The group list as text: tên nhóm, số thành viên, theo dõi (✓/–), ghi chú, then "Đang theo dõi X/Y nhóm".
 * Group names and notes only; never message content.
 * @param {{ groups: object[] }} config
 * @param {Map<string, number>} [memberCounts] conv_id -> members; a dash when unknown
 */
export function formatGroupsTable(config, memberCounts = new Map()) {
  const header = ['Tên nhóm', 'Số thành viên', 'Theo dõi', 'Ghi chú'];
  const rows = config.groups.map(g => [
    fit((g.name || g.convId).replace(/\s+/g, ' ').trim(), NAME_MAX_WIDTH),
    memberCounts.has(g.convId) ? String(memberCounts.get(g.convId)) : '–',
    g.tracked ? '✓' : '–',
    [g.note, g.missing ? '(không còn trên Zalo)' : ''].filter(Boolean).join(' '),
  ]);

  const widths = [0, 1, 2].map(i => Math.max(...[header, ...rows].map(row => displayWidth(row[i]))));
  const line = row => [padEnd(row[0], widths[0]), padStart(row[1], widths[1]), padEnd(row[2], widths[2]), row[3]].join('  ').trimEnd();

  const tracked = config.groups.filter(g => g.tracked).length;
  return [line(header), ...rows.map(line), '', `Đang theo dõi ${tracked}/${config.groups.length} nhóm`].join('\n');
}
