// `zmi export` and `zmi search` (spec section 8): the filtered, redacted, compact view of the database that Claude reads.
//
//   exportRange(db, { from, to, convIds, out, rootDir, now }) -> output directory
//   runExport(db, options)                                      -> { dir, stats }  (same, plus numbers for the CLI summary)
//   searchMessages(db, query, { from, to, convIds, limit })     -> { lines, total }
//
// Pure of Zalo and of node:sqlite (the DB comes in as an argument; this module only reads it). Output files:
//   index.md        groups, message counts, first/last time, last sync (with a warning when older than 24 h), how to read
//   <group>.md      one per group that has lines in the range; `[HH:mm] Sender: content #m<msgId>`, grouped by day
//   members.md      people who joined in the range, who added them, up to 2 of their own messages
//   attachments.md  files, screenshots with text (the ones stored under data/images/) and links of the range, per group.
//                   Photos whose file was deleted on purpose (status text_only) stay in the group file only: they are
//                   thousands of product photos, not attachments Claude can open.
//
// Rules (spec 6.7, 8 and the controller rulings)
// - Recalled / deleted / sticker / video messages are never exported or found by search. Recalled and deleted rows still
//   hold their old text in the database (and in the full-text index), so the kind is filtered here.
// - Chat text, link title/description, sender names and file hrefs go through redact(). OCR text (image content) and file
//   names do not.
// - A word-for-word repost within one group becomes `(đăng lại tin #m<first>)` (see REPOST_MIN_CHARS).
// - Times are stored as UTC milliseconds and shown as Vietnam time (UTC+7, no DST) whatever the machine's time zone is.
// - Paths of stored files and images are absolute (the database keeps them relative to the repo root), so Claude can open them.
// - Never `SELECT *` on messages (it has the internal fts_rowid): every query lists its columns.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { redact } from './redact.mjs';

const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;
const VN_OFFSET_MS = 7 * HOUR_MS;
const DEFAULT_DAYS = 14;
const STALE_AFTER_MS = 24 * HOUR_MS;
const DEFAULT_SEARCH_LIMIT = 50;
const SEARCH_EXCERPT_CHARS = 200;
const OCR_CHARS = 200;
const DESCRIPTION_CHARS = 200;
const INTRO_CHARS = 300;
const INTRO_COUNT = 2;
const REPO_ROOT = resolve(import.meta.dirname, '..');

/** Messages that never reach the output. */
export const EXCLUDED_KINDS = Object.freeze(['recalled', 'deleted', 'sticker', 'video']);
const EXCLUDED_SQL = EXCLUDED_KINDS.map(k => `'${k}'`).join(', ');
const NOT_EXCLUDED = `(m.kind IS NULL OR m.kind NOT IN (${EXCLUDED_SQL}))`;

/** A problem with what the user asked for (bad date, unknown group, output folder in use). exitCode: 2 usage, 1 state. */
export class ExportError extends Error {
  constructor(message, { exitCode = 2 } = {}) {
    super(message);
    this.name = 'ExportError';
    this.exitCode = exitCode;
  }
}

const thousands = n => Number(n).toLocaleString('vi-VN');

// ---------------------------------------------------------------------------------------------------------------------
// Vietnam time
// ---------------------------------------------------------------------------------------------------------------------

const pad = n => String(n).padStart(2, '0');
const vnDate = ts => new Date(Number(ts) + VN_OFFSET_MS); // read with the getUTC* methods: the shifted instant IS the wall clock

export function formatVnDate(ts) {
  const d = vnDate(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function formatVnTime(ts) {
  const d = vnDate(ts);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export const formatVnDateTime = ts => `${formatVnDate(ts)} ${formatVnTime(ts)}`;
const stampOf = ts => `${formatVnDate(ts).replaceAll('-', '')}-${formatVnTime(ts).replace(':', '')}`; // 20261022-1430

const WEEKDAYS = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
export const weekdayOf = ts => WEEKDAYS[vnDate(ts).getUTCDay()];
const startOfVnDay = ts => Math.floor((Number(ts) + VN_OFFSET_MS) / DAY_MS) * DAY_MS - VN_OFFSET_MS;

/**
 * "YYYY-MM-DD" as Vietnam time -> epoch ms of its first millisecond, or (endOfDay) of its last one.
 * @throws {ExportError}
 */
export function parseVnDate(text, { endOfDay = false, flag } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? '').trim());
  const utc = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  const back = new Date(utc);
  if (!m || back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) {
    throw new ExportError(`${flag ? `${flag}: ` : ''}ngày không hợp lệ: "${text}". Dùng dạng YYYY-MM-DD (giờ Việt Nam), ví dụ 2026-10-01.`);
  }
  const start = utc - VN_OFFSET_MS;
  return endOfDay ? start + DAY_MS - 1 : start;
}

const asMs = (value, options) => (typeof value === 'number' ? value : parseVnDate(value, options));

/**
 * The export range. Strings are Vietnam dates ("--to" covers its whole day), numbers are epoch ms.
 * Default: the 14 days before `now`. Only --to: the 14 calendar days that end on that day. Only --from: up to `now`.
 * @returns {{ from: number, to: number }}
 * @throws {ExportError}
 */
export function resolveRange({ from, to } = {}, now = Date.now()) {
  const toMs = to === undefined ? now : asMs(to, { endOfDay: true, flag: '--to' });
  let fromMs;
  if (from !== undefined) fromMs = asMs(from, { flag: '--from' });
  else if (to === undefined) fromMs = now - DEFAULT_DAYS * DAY_MS;
  else fromMs = startOfVnDay(toMs) - (DEFAULT_DAYS - 1) * DAY_MS;
  if (fromMs > toMs) throw new ExportError('--from phải trước hoặc bằng --to.');
  return { from: fromMs, to: toMs };
}

/** Range for `zmi search`: no default, so only the bounds the user gave are set. */
export function resolveSearchRange({ from, to } = {}) {
  const range = {};
  if (from !== undefined) range.from = asMs(from, { flag: '--from' });
  if (to !== undefined) range.to = asMs(to, { endOfDay: true, flag: '--to' });
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) throw new ExportError('--from phải trước hoặc bằng --to.');
  return range;
}

// ---------------------------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------------------------

/** Lower case, no diacritics, d for đ: "Cảm ơn" -> "cam on". */
export const fold = s => String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replaceAll('đ', 'd');

/** Lines trimmed, empty ones dropped, joined on " ⏎ ": one message stays on one line. */
export const oneLine = s => String(s).split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean).join(' ⏎ ');
export const oneSpace = s => String(s).replace(/\s+/g, ' ').trim();

export function clip(s, max) {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max).join('').trimEnd()}…`;
}

/** Chat text for the output: redacted, on one line. null/undefined -> ''. */
const chat = s => (s === null || s === undefined ? '' : oneLine(redact(String(s))));

const domainOf = url => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
};

/** "3,9 MB" (Vietnamese decimal comma); under 100 KB "85 KB" so a small file does not read "0,0 MB". null when unknown. */
export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 100 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Noise: short greetings and thanks (spec 8, ruling 7)
// ---------------------------------------------------------------------------------------------------------------------

// A text message is noise when it is shorter than NOISE_MAX_CHARS, has no figure and no link, and is a greeting or thanks:
// one of the words below plus at most ONE other word (usually a name: "Cảm ơn anh Nam"). The little polite words around
// them ("anh", "mọi người", "nhé", "ạ") do not count as "other". A message of only emoji or punctuation ("👍") is noise too.
// Matching ignores case and diacritics, so "cam on" is "cảm ơn". Extend these lists as needed.
export const NOISE_MAX_CHARS = 15;
const GREETING_WORDS = ['chào', 'hello', 'hi', 'hey', 'cảm ơn', 'cám ơn', 'thanks', 'thank', 'thx', 'tks', 'ty', 'ok', 'oke', 'okie', 'okay', 'morning'];
const POLITE_WORDS = ['anh', 'chị', 'em', 'bạn', 'các', 'mọi', 'người', 'cả', 'nhà', 'nhé', 'nha', 'ạ', 'ơi', 'nhiều', 'rất', 'lắm', 'xin', 'you', 'so', 'much', 'good', 'team', 'all', 'a', 'e', 'c'];

const GREETING_PHRASES = GREETING_WORDS.filter(w => w.includes(' ')).map(fold);
const GREETING_SET = new Set(GREETING_WORDS.filter(w => !w.includes(' ')).map(fold));
const POLITE_SET = new Set(POLITE_WORDS.map(fold));
const LINK_RE = /https?:\/\/|www\./i;

/** True for text the export leaves out: empty, a short greeting/thanks, or only emoji/punctuation. */
export function isNoiseMessage(text) {
  if (text === null || text === undefined) return true;
  const trimmed = String(text).trim();
  if (trimmed === '') return true;
  if (Array.from(trimmed).length >= NOISE_MAX_CHARS) return false;
  if (/\p{N}/u.test(trimmed) || LINK_RE.test(trimmed)) return false; // a figure or a link is substance

  let folded = ` ${fold(trimmed.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️]/gu, ' ')).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  if (folded.trim() === '') return true;

  let hasGreeting = false;
  for (const phrase of GREETING_PHRASES) {
    while (folded.includes(` ${phrase} `)) { hasGreeting = true; folded = folded.replace(` ${phrase} `, ' '); }
  }
  let others = 0;
  for (const word of folded.split(' ').filter(Boolean)) {
    if (GREETING_SET.has(word)) hasGreeting = true;
    else if (!POLITE_SET.has(word)) others++;
  }
  return hasGreeting && others <= 1;
}

// ---------------------------------------------------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------------------------------------------------

const RESERVED_BASE_NAMES = ['index', 'members', 'attachments']; // the other files of an export
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SLUG_MAX_CHARS = 60;

/** A file-system-safe name made of the group name: Vietnamese letters kept, emoji and <>:"/\|?* dropped, spaces to "-". */
export function slugify(name) {
  let s = String(name ?? '').normalize('NFC')
    .replace(/[​-‍⁠︀-️﻿⃣]/gu, '') // zero-width joiners, emoji variation selectors, keycap
    .replace(/[^\p{L}\p{N}\p{M}._ -]+/gu, ' ')
    .replace(/(^|\s)\p{M}+/gu, '$1')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-');
  const strip = t => t.replace(/^[-._]+|[-._]+$/g, '');
  s = strip(Array.from(strip(s)).slice(0, SLUG_MAX_CHARS).join(''));
  if (s === '') return 'nhom';
  return WINDOWS_DEVICE.test(s.split('.')[0]) ? `_${s}` : s;
}

/** convId -> "<slug>.md", unique case-insensitively (Windows) and never one of the fixed files. */
function assignFileNames(groups) {
  const used = new Set(RESERVED_BASE_NAMES);
  const names = new Map();
  for (const { convId, name } of groups) {
    const base = slugify(name);
    const tag = convId.slice(-4);
    let candidate = base;
    for (let n = 1; used.has(candidate.toLowerCase()); n++) candidate = n === 1 ? `${base}-${tag}` : `${base}-${tag}-${n}`;
    used.add(candidate.toLowerCase());
    names.set(convId, `${candidate}.md`);
  }
  return names;
}

// ---------------------------------------------------------------------------------------------------------------------
// Line content
// ---------------------------------------------------------------------------------------------------------------------

const absolute = (rootDir, storedPath) => resolve(rootDir, storedPath);

/** `name (3,9 MB) → <absolute path>` when stored, else `name (…) → chỉ có link[: href]`. */
function fileBody({ name, size, status, path, url }, rootDir) {
  const label = oneLine(name || '(không tên)');
  const sized = formatSize(size);
  const head = sized ? `${label} (${sized})` : label;
  if (status === 'stored' && path) return `${head} → ${absolute(rootDir, path)}`;
  return `${head} → chỉ có link${url ? `: ${chat(url)}` : ''}`;
}

/** Image with text: `caption | first ~200 chars of OCR → path`; text_only (file deleted on purpose): no path. */
function textImageBody({ caption, ocr, status, path }, rootDir) {
  const where = status === 'text_only' || !path ? '(chỉ còn chữ, ảnh đã xoá)' : absolute(rootDir, path);
  const parts = [chat(caption), ocr ? clip(oneSpace(ocr), OCR_CHARS) : ''].filter(Boolean);
  return `${parts.length ? `${parts.join(' | ')} ` : ''}→ ${where}`;
}

/** `[Link] title — domain | description`. */
export function linkCard({ title, description, domain, url }) {
  const host = domain ?? (url ? domainOf(url) : null);
  const heading = [chat(title), host].filter(Boolean).join(' — ');
  const summary = description ? clip(chat(description), DESCRIPTION_CHARS) : '';
  return ['[Link]', heading, summary && `| ${summary}`].filter(Boolean).join(' ');
}

const hasOcrText = row => Number(row.i_has_text) === 1;

/**
 * The content of one message line (after "[HH:mm] Sender: "), or null when the message adds nothing:
 * an empty message, a short greeting, or a member event without text.
 */
function messageContent(row, rootDir, counters) {
  switch (row.kind) {
    case 'file':
      return `[File] ${fileBody({ name: row.f_name ?? row.title, size: row.f_size, status: row.f_status, path: row.f_path, url: row.f_url }, rootDir)}`;
    case 'photo': {
      const caption = row.i_caption ?? row.text;
      if (hasOcrText(row)) return `[Ảnh có chữ] ${textImageBody({ caption, ocr: row.i_ocr, status: row.i_status, path: row.i_path }, rootDir)}`;
      const c = chat(caption);
      return c ? `[Ảnh] ${c}` : '[Ảnh]';
    }
    case 'link': {
      const url = row.url ?? row.l_url;
      const own = row.text && url && row.text.trim() === url.trim() ? '' : chat(row.text); // a bare URL is not repeated
      return [own, linkCard({ title: row.l_title ?? row.title, description: row.l_description ?? row.description, domain: row.l_domain, url })].filter(Boolean).join(' ');
    }
    default: {
      // text, other
      if (row.text === null || row.text === undefined || String(row.text).trim() === '') { counters.empty++; return null; }
      if (isNoiseMessage(row.text)) { counters.noise++; return null; }
      return chat(row.text);
    }
  }
}

function memberEventLine(row) {
  const text = chat(row.e_text ?? row.text);
  return text ? `[Thành viên] ${text}` : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// One group
// ---------------------------------------------------------------------------------------------------------------------

const MESSAGE_SQL = `
  SELECT m.msg_id, m.ts, m.sender_name, m.kind, m.text, m.title, m.description, m.url,
         f.file_name AS f_name, f.size AS f_size, f.status AS f_status, f.stored_path AS f_path, f.remote_url AS f_url,
         i.caption AS i_caption, i.has_text AS i_has_text, i.ocr_text AS i_ocr, i.status AS i_status, i.stored_path AS i_path,
         l.title AS l_title, l.description AS l_description, l.domain AS l_domain, l.url AS l_url,
         e.text AS e_text
    FROM messages m
    LEFT JOIN files f ON f.msg_id = m.msg_id
    LEFT JOIN images i ON i.msg_id = m.msg_id
    LEFT JOIN links l ON l.msg_id = m.msg_id
    LEFT JOIN member_events e ON e.msg_id = m.msg_id
   WHERE m.conv_id = ? AND m.ts >= ? AND m.ts <= ? AND ${NOT_EXCLUDED}
   ORDER BY m.ts, m.msg_id`;

// Sales posts are re-posted word for word every day (43% of the biggest group file in the first real export). A repost of
// at least REPOST_MIN_CHARS within one group keeps its line (who, when, its own #m) but not the text again. Reposts across
// groups stay: the report merges those itself.
const REPOST_MIN_CHARS = 40;
const repostKey = content => content.replace(/ → [^→]*$/, ''); // the same image or file stored twice has two paths

function groupLines(db, convId, { from, to }, rootDir) {
  const counters = { noise: 0, empty: 0, repost: 0 };
  const lines = [];
  const firstCopy = new Map();
  for (const row of db.raw.prepare(MESSAGE_SQL).all(convId, from, to)) {
    let content = row.kind === 'member_event' ? memberEventLine(row) : messageContent(row, rootDir, counters);
    if (content === null) continue;
    const key = repostKey(content);
    if (Array.from(key).length >= REPOST_MIN_CHARS) {
      const first = firstCopy.get(key);
      if (first === undefined) firstCopy.set(key, row.msg_id);
      else { content = `(đăng lại tin #m${first})`; counters.repost++; }
    }
    const sender = row.kind === 'member_event' ? null : chat(row.sender_name) || '(không rõ)';
    const prefix = `[${formatVnTime(row.ts)}] ${sender === null ? '' : `${sender}: `}`;
    lines.push({ ts: Number(row.ts), text: `${prefix}${content} #m${row.msg_id}` });
  }
  return { lines, counters };
}

function renderGroupFile(name, range, lines) {
  const out = [`# ${oneLine(name)}`, '', `Kỳ: ${formatVnDateTime(range.from)} → ${formatVnDateTime(range.to)} (giờ Việt Nam) · ${thousands(lines.length)} dòng`];
  let day = null;
  for (const line of lines) {
    const date = formatVnDate(line.ts);
    if (date !== day) {
      day = date;
      out.push('', `## ${date} (${weekdayOf(line.ts)})`, '');
    }
    out.push(line.text);
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// members.md
// ---------------------------------------------------------------------------------------------------------------------

const JOIN_SQL = `
  SELECT e.msg_id, e.ts, e.event, e.member_uids_json, e.member_name, e.actor_name, e.text AS e_text, m.text AS m_text
    FROM member_events e JOIN messages m ON m.msg_id = e.msg_id
   WHERE e.conv_id = ? AND e.ts >= ? AND e.ts <= ? AND e.event IN ('joined', 'added') AND ${NOT_EXCLUDED}
   ORDER BY e.ts, e.msg_id`;

const INTRO_SQL = `
  SELECT m.msg_id, m.ts, m.text
    FROM messages m
   WHERE m.conv_id = ? AND m.from_uid = ? AND m.ts >= ? AND m.ts <= ? AND m.kind IN ('text', 'link', 'other') AND m.text IS NOT NULL
   ORDER BY m.ts, m.msg_id LIMIT 30`;

const parseUids = json => {
  try {
    const list = JSON.parse(json ?? '[]');
    return Array.isArray(list) ? list.filter(u => typeof u === 'string' && u !== '') : [];
  } catch {
    return [];
  }
};

/** What the member said after joining, as `giới thiệu` context: their first INTRO_COUNT real messages in the range. */
function introductions(db, convId, uids, since, until) {
  const found = new Map();
  for (const uid of uids) {
    for (const m of db.raw.prepare(INTRO_SQL).all(convId, uid, since, until)) if (!isNoiseMessage(m.text)) found.set(m.msg_id, m);
  }
  return [...found.values()].sort((a, b) => a.ts - b.ts || (a.msg_id < b.msg_id ? -1 : 1)).slice(0, INTRO_COUNT);
}

function memberSection(db, convId, name, range) {
  const out = [];
  for (const e of db.raw.prepare(JOIN_SQL).all(convId, range.from, range.to)) {
    const who = chat(e.member_name);
    const how = e.event === 'added' ? (e.actor_name ? `được ${chat(e.actor_name)} thêm vào nhóm` : 'được thêm vào nhóm') : 'tham gia nhóm';
    out.push(`- [${formatVnDateTime(e.ts)}] ${who ? `${who} — ${how}` : chat(e.e_text ?? e.m_text)} #m${e.msg_id}`);
    for (const m of introductions(db, convId, parseUids(e.member_uids_json), e.ts, range.to)) {
      out.push(`  - giới thiệu: "${clip(chat(m.text), INTRO_CHARS)}" (${formatVnDateTime(m.ts)}) #m${m.msg_id}`);
    }
  }
  return out.length ? [`## ${oneLine(name)}`, '', ...out, ''] : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// attachments.md
// ---------------------------------------------------------------------------------------------------------------------

const ATTACH_WHERE = `m.conv_id = ? AND m.ts >= ? AND m.ts <= ? AND ${NOT_EXCLUDED}`;
const FILES_SQL = `
  SELECT m.msg_id, m.ts, m.sender_name, f.file_name AS name, f.size, f.status, f.stored_path AS path, f.remote_url AS url
    FROM files f JOIN messages m ON m.msg_id = f.msg_id WHERE ${ATTACH_WHERE} ORDER BY m.ts, m.msg_id`;
const IMAGES_SQL = `
  SELECT m.msg_id, m.ts, m.sender_name, i.caption, i.ocr_text AS ocr, i.status, i.stored_path AS path
    FROM images i JOIN messages m ON m.msg_id = i.msg_id
   WHERE ${ATTACH_WHERE} AND i.has_text = 1 AND i.stored_path IS NOT NULL AND COALESCE(i.status, '') <> 'text_only' ORDER BY m.ts, m.msg_id`;
const LINKS_SQL = `
  SELECT m.msg_id, m.ts, m.sender_name, l.url, l.domain, l.title, l.description
    FROM links l JOIN messages m ON m.msg_id = l.msg_id WHERE ${ATTACH_WHERE} ORDER BY m.ts, m.msg_id`;

function attachmentSection(db, convId, name, range, rootDir) {
  const args = [convId, range.from, range.to];
  const stamp = r => `- [${formatVnDateTime(r.ts)}] ${chat(r.sender_name) || '(không rõ)'}:`;
  const files = db.raw.prepare(FILES_SQL).all(...args).map(r => `${stamp(r)} ${fileBody(r, rootDir)} #m${r.msg_id}`);
  const images = db.raw.prepare(IMAGES_SQL).all(...args).map(r => `${stamp(r)} ${textImageBody(r, rootDir)} #m${r.msg_id}`);
  const links = db.raw.prepare(LINKS_SQL).all(...args).map(r => {
    const heading = [chat(r.title), r.domain ?? domainOf(r.url ?? '')].filter(Boolean).join(' — ');
    const summary = r.description ? ` | ${clip(chat(r.description), DESCRIPTION_CHARS)}` : '';
    return `${stamp(r)} ${[heading, chat(r.url)].filter(Boolean).join(' — ')}${summary} #m${r.msg_id}`;
  });
  if (files.length + images.length + links.length === 0) return null;
  const out = [`## ${oneLine(name)}`, ''];
  for (const [title, items] of [['File', files], ['Ảnh có chữ', images], ['Link', links]]) {
    if (items.length) out.push(`### ${title}`, '', ...items, '');
  }
  return { text: out, counts: { files: files.length, images: images.length, links: links.length } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Groups and the output folder
// ---------------------------------------------------------------------------------------------------------------------

const groupNameMap = db => new Map(db.raw.prepare('SELECT conv_id, name FROM groups').all().map(g => [g.conv_id, g.name || g.conv_id]));

/**
 * Which groups to read. `requested` (convIds) wins and must be known to the config or the database; otherwise the groups
 * the config marks tracked (also when they left Zalo: their messages stay in the database), or without a config the
 * database's own tracked flag.
 * @param {{ config?: { groups: { convId: string, tracked: boolean }[] } | null, db: object, requested?: string[] }} args
 * @returns {string[]}
 * @throws {ExportError}
 */
export function selectGroupIds({ config, db, requested }) {
  if (requested && requested.length > 0) {
    const known = new Set([...(config?.groups ?? []).map(g => g.convId), ...db.raw.prepare('SELECT conv_id FROM groups').all().map(g => g.conv_id)]);
    const ids = [...new Set(requested)];
    const unknown = ids.filter(id => !known.has(id));
    if (unknown.length) throw new ExportError(`Không có nhóm nào có convId: ${unknown.join(', ')} (xem danh sách bằng: node zmi.mjs groups).`);
    return ids;
  }
  const tracked = config
    ? config.groups.filter(g => g.tracked).map(g => g.convId)
    : db.raw.prepare('SELECT conv_id FROM groups WHERE tracked = 1 ORDER BY conv_id').all().map(g => g.conv_id);
  if (tracked.length === 0) {
    throw new ExportError('Chưa có nhóm nào đang theo dõi. Đặt "tracked": true cho nhóm cần theo dõi trong config/groups.json (xem: node zmi.mjs groups).', { exitCode: 1 });
  }
  return tracked;
}

function prepareOutDir({ out, rootDir, now }) {
  if (out) {
    const dir = resolve(out);
    if (existsSync(dir)) {
      if (!statSync(dir).isDirectory()) throw new ExportError(`--out "${dir}" không phải thư mục.`);
      if (readdirSync(dir).length > 0) throw new ExportError(`Thư mục --out "${dir}" đã có file. Chọn thư mục khác (hoặc bỏ --out để dùng exports/<ngày-giờ>).`);
    }
    return dir;
  }
  const base = join(rootDir, 'exports', stampOf(now));
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`; // two exports in the same minute never overwrite each other
  return dir;
}

// ---------------------------------------------------------------------------------------------------------------------
// index.md
// ---------------------------------------------------------------------------------------------------------------------

function syncStatus(db, now) {
  const { t } = db.raw.prepare('SELECT MAX(finished_at) AS t FROM sync_runs WHERE finished_at IS NOT NULL').get();
  if (t === null || t === undefined) {
    return { at: null, warning: 'CẢNH BÁO: chưa có lần sync nào được ghi nhận (bảng sync_runs trống), dữ liệu có thể thiếu. Chạy "node zmi.mjs sync" rồi export lại.' };
  }
  const age = now - Number(t);
  const hours = Math.max(0, Math.floor(age / HOUR_MS));
  const warning = age > STALE_AFTER_MS
    ? `CẢNH BÁO: lần sync gần nhất cách đây ${thousands(hours)} giờ (${formatVnDateTime(t)}, giờ Việt Nam), nên dữ liệu có thể thiếu tin mới. Chạy "node zmi.mjs sync" (cần mở Zalo ở chế độ thu thập) rồi export lại trước khi lập báo cáo.`
    : null;
  return { at: Number(t), hours, warning };
}

function renderIndex({ now, range, sync, groups, totals, dropped, members, attachments }) {
  const cell = s => oneLine(s).replaceAll('|', '/');
  const out = ['# Bản xuất Zalo MI', ''];
  if (sync.warning) out.push(`> ${sync.warning}`, '');
  out.push(
    `- Xuất lúc: ${formatVnDateTime(now)} (giờ Việt Nam, UTC+7)`,
    `- Kỳ: ${formatVnDateTime(range.from)} → ${formatVnDateTime(range.to)}`,
    `- Sync gần nhất: ${sync.at === null ? 'chưa có' : `${formatVnDateTime(sync.at)} (cách đây ${thousands(sync.hours)} giờ)`}`,
    `- Tổng: ${thousands(totals.groups)} nhóm có tin (trên ${thousands(groups.length)} nhóm được chọn), ${thousands(totals.lines)} dòng`,
    '',
    '| Nhóm | Số tin | Tin đầu | Tin cuối | File |',
    '| --- | ---: | --- | --- | --- |',
  );
  for (const g of groups) {
    out.push(`| ${cell(g.name)} | ${thousands(g.lines.length)} | ${g.lines.length ? formatVnDateTime(g.lines[0].ts) : '–'} | ${g.lines.length ? formatVnDateTime(g.lines.at(-1).ts) : '–'} | ${g.lines.length ? g.fileName : '–'} |`);
  }
  out.push(
    '',
    `Các file khác: members.md (${thousands(members)} người mới vào nhóm), attachments.md (${thousands(attachments.files)} file, ${thousands(attachments.images)} ảnh có chữ, ${thousands(attachments.links)} link).`,
    '',
    '## Cách đọc',
    '',
    '- Mỗi tin một dòng: `[HH:mm] Người gửi: nội dung #m<mã tin>`. Khi dẫn nguồn trong bản tin, ghi mã `#m…`. Giờ là giờ Việt Nam.',
    '- `[File] tên (dung lượng) → đường dẫn`: mở file bằng đường dẫn tuyệt đối đó. `→ chỉ có link` là không còn bản trên máy.',
    '- `[Ảnh có chữ] chú thích | chữ đọc được trong ảnh → đường dẫn`: ảnh chụp màn hình có chữ; mở ảnh bằng đường dẫn nếu cần xem. `(chỉ còn chữ, ảnh đã xoá)` nghĩa là chỉ còn phần chữ.',
    '- `[Ảnh]` ảnh không có chữ; `[Link] tiêu đề — tên miền`; `[Thành viên]` người vào/ra nhóm.',
    '- `(đăng lại tin #m…)`: tin giống hệt một tin trước đó trong cùng nhóm; nội dung xem ở tin gốc.',
    '- Số điện thoại và email trong tin nhắn đã được che (`[SĐT]`, `[email]`); chữ đọc từ ảnh và tên file thì không.',
  );
  const left = [
    [dropped.recalled, 'tin thu hồi'], [dropped.deleted, 'tin đã xóa'], [dropped.sticker, 'sticker'], [dropped.video, 'video'],
    [dropped.noise, 'tin chào/cảm ơn ngắn'], [dropped.empty, 'tin không có nội dung'],
  ].filter(([n]) => n > 0).map(([n, label]) => `${thousands(n)} ${label}`);
  out.push(`- Đã lọc bỏ khỏi bản xuất: ${left.length ? left.join(', ') : 'không có'}.`);
  if (dropped.repost > 0) out.push(`- Rút gọn: ${thousands(dropped.repost)} tin đăng lại trong cùng nhóm.`);
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// exportRange
// ---------------------------------------------------------------------------------------------------------------------

const byVietnameseName = new Intl.Collator('vi', { sensitivity: 'base' });

/**
 * Builds the export folder and returns its path plus the numbers for the CLI summary.
 * @param {object} db a lib/db.mjs handle (only read)
 * @param {{ from?: number, to?: number, convIds?: string[], out?: string, rootDir?: string, now?: () => number }} [options]
 *   from/to: inclusive epoch ms (default: the 14 days before now). convIds: default the tracked groups of the database.
 *   out: folder (must be new or empty; default <rootDir>/exports/<YYYYMMDD-HHmm>, with -2, -3 … if that exists).
 *   rootDir: the repo root, against which stored_path values are resolved. now: clock (tests inject one).
 * @returns {{ dir: string, stats: object }}
 * @throws {ExportError}
 */
export function runExport(db, { from, to, convIds, out, rootDir = REPO_ROOT, now = Date.now } = {}) {
  const nowMs = now();
  const range = resolveRange({ from, to }, nowMs);
  const ids = convIds ?? selectGroupIds({ db });
  if (ids.length === 0) throw new ExportError('Không có nhóm nào để xuất.', { exitCode: 1 });

  const names = groupNameMap(db);
  const groups = ids.map(convId => ({ convId, name: names.get(convId) ?? convId }))
    .sort((a, b) => byVietnameseName.compare(a.name, b.name) || (a.convId < b.convId ? -1 : 1));
  const fileNames = assignFileNames(groups);
  const dir = prepareOutDir({ out, rootDir, now: nowMs });

  const dropped = { recalled: 0, deleted: 0, sticker: 0, video: 0, noise: 0, empty: 0, repost: 0 };
  const files = new Map();
  const memberBlocks = [];
  const attachmentBlocks = [];
  const attachmentTotals = { files: 0, images: 0, links: 0 };
  let members = 0;

  for (const g of groups) {
    const { lines, counters } = groupLines(db, g.convId, range, rootDir);
    g.lines = lines;
    g.fileName = fileNames.get(g.convId);
    dropped.noise += counters.noise;
    dropped.empty += counters.empty;
    dropped.repost += counters.repost;
    for (const row of db.raw.prepare(
      `SELECT m.kind, COUNT(*) AS n FROM messages m WHERE m.conv_id = ? AND m.ts >= ? AND m.ts <= ? AND m.kind IN (${EXCLUDED_SQL}) GROUP BY m.kind`,
    ).all(g.convId, range.from, range.to)) dropped[row.kind] += Number(row.n);

    if (lines.length > 0) files.set(g.fileName, renderGroupFile(g.name, range, lines));
    const section = memberSection(db, g.convId, g.name, range);
    if (section) {
      memberBlocks.push(...section);
      members += section.filter(l => l.startsWith('- [')).length;
    }
    const attached = attachmentSection(db, g.convId, g.name, range, rootDir);
    if (attached) {
      attachmentBlocks.push(...attached.text);
      for (const key of Object.keys(attachmentTotals)) attachmentTotals[key] += attached.counts[key];
    }
  }

  const sync = syncStatus(db, nowMs);
  const totals = { groups: groups.filter(g => g.lines.length > 0).length, lines: groups.reduce((n, g) => n + g.lines.length, 0) };
  const period = `${formatVnDateTime(range.from)} → ${formatVnDateTime(range.to)}`;
  files.set('index.md', renderIndex({ now: nowMs, range, sync, groups, totals, dropped, members, attachments: attachmentTotals }));
  files.set('members.md', `${['# Thành viên mới vào nhóm', '', `Kỳ: ${period} (giờ Việt Nam). Chỉ gồm người vào nhóm (đã tham gia hoặc được thêm vào), kèm tối đa ${INTRO_COUNT} tin của chính họ sau khi vào.`, '', ...(memberBlocks.length ? memberBlocks : ['Không có.'])].join('\n')}\n`);
  files.set('attachments.md', `${['# File, ảnh có chữ và link', '', `Kỳ: ${period} (giờ Việt Nam).`, '', ...(attachmentBlocks.length ? attachmentBlocks : ['Không có.'])].join('\n')}\n`);

  mkdirSync(dir, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(dir, name), text, 'utf8');

  return { dir, stats: { ...totals, range, syncWarning: sync.warning, dropped, members, attachments: attachmentTotals } };
}

/** @returns {string} the output folder */
export const exportRange = (db, options) => runExport(db, options).dir;

// ---------------------------------------------------------------------------------------------------------------------
// zmi search
// ---------------------------------------------------------------------------------------------------------------------

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where (in code points of `text`) the first query word occurs as a whole word, ignoring case and diacritics; null if none. */
function matchPosition(text, words) {
  if (words.length === 0) return null;
  const chars = Array.from(text);
  let folded = '';
  const owner = [];
  chars.forEach((ch, i) => {
    const f = fold(ch);
    folded += f;
    for (let k = 0; k < f.length; k++) owner.push(i);
  });
  let best = null;
  for (const word of words) {
    const m = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'u').exec(folded);
    if (m && (best === null || m.index < best)) best = m.index;
  }
  return best === null ? null : owner[best];
}

/** ~max characters of `text` around code point `at`, with … where it is cut. */
function excerpt(text, at, max = SEARCH_EXCERPT_CHARS) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  let start = Math.max(0, (at ?? 0) - 60);
  if (start + max > chars.length) start = Math.max(0, chars.length - max);
  const end = start + max;
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`;
}

/** What to print for a hit: the first of text / title / description / OCR that contains a query word, around the match. */
function hitContent(row, words) {
  const candidates = [
    { value: chat(row.text), label: row.kind === 'member_event' ? '[Thành viên] ' : '' },
    { value: chat(row.title), label: row.kind === 'file' ? '[File] ' : '[Link] ' },
    { value: chat(row.description), label: '[Link] ' },
    { value: row.ocr_text ? oneSpace(row.ocr_text) : '', label: '[Ảnh có chữ] ' }, // image content: not redacted
  ].filter(c => c.value);
  const hit = candidates.map(c => ({ ...c, at: matchPosition(c.value, words) })).find(c => c.at !== null) ?? { ...candidates[0], at: 0 };
  return hit.value === undefined ? '' : `${hit.label}${excerpt(hit.value, hit.at)}`;
}

/** `[YYYY-MM-DD HH:mm] <group> | <sender>: <content> #m<msgId>` */
export function formatSearchLine({ ts, group, sender, content, msgId }) {
  return `[${formatVnDateTime(ts)}] ${oneLine(group)} | ${sender}: ${content} #m${msgId}`;
}

/**
 * Full-text search (accent- and case-insensitive, via db.search) with the export's filters: recalled, deleted, sticker and
 * video rows are dropped after the match, and the printed text is redacted. Newest first.
 * @returns {{ lines: string[], total: number }} total: all hits; lines: the first `limit` of them.
 */
export function searchMessages(db, query, { from, to, convIds, limit = DEFAULT_SEARCH_LIMIT } = {}) {
  const excluded = new Set(EXCLUDED_KINDS);
  const hits = db.search(query, { from, to, convIds }).filter(r => !excluded.has(r.kind));
  const names = groupNameMap(db);
  const words = String(query ?? '').split(/\s+/).map(fold).filter(w => /[\p{L}\p{N}]/u.test(w));
  const lines = hits.slice(0, limit).map(r => formatSearchLine({
    ts: r.ts,
    group: names.get(r.conv_id) ?? r.conv_id,
    sender: chat(r.sender_name) || '(không rõ)',
    content: hitContent(r, words),
    msgId: r.msg_id,
  }));
  return { lines, total: hits.length };
}
