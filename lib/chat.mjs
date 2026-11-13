// `zmi chat`: read ONE conversation (a 1-1 chat or any group, tracked or not) on demand, for a report Cong asks for.
//
//   findChats(bridge, query)          -> [{ convId, isGroup, name, altName, lastTs }]   conversations whose name matches
//   readChat(bridge, convId, options) -> { title, lines, page, pages, stats }           one page of the chat as text lines
//
// Cong's rules for this command (09/11/2026):
// - Read only when he asks, one chat at a time. Nothing goes into data/zalo-mi.db and no file holds the chat text: the
//   lines are only printed. This module never imports lib/db.mjs.
// - Every shared file is copied to the folder he names (`saveTo`, the workstream's "Zalo files\<chat>" folder), any type
//   up to 100 MB; a file already there is not copied again. Screenshots with text are copied there too, so Claude can
//   open them; ordinary photos are neither copied nor read.
// - Chat text is not redacted: the report is for Cong only.
// Zalo is read through the same read-only bridge as `zmi sync` (store reads + the OCR/JXL compute allowlist), so nothing
// is written to Zalo and nothing is marked as seen.

import { mkdirSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { normalizeMessage } from './normalize.mjs';
import { resolveFile, localCandidates as fileCandidates, pickMediaRow, sanitizeFileName } from './files.mjs';
import { cacheIndexFor, chatImageTo, shapeClass } from './images.mjs';
import {
  EXCLUDED_KINDS, clip, fold, formatSize, formatVnDate, formatVnTime, linkCard, oneLine, oneSpace, weekdayOf,
} from './export.mjs';

export const PAGE_CHARS = 20_000;
const FIND_MAX = 30;
const QUOTE_CHARS = 80;
const OCR_CHARS = 200;
const SENDER_PROBE = 50;
const MAX_IMAGE_FAILURES_IN_A_ROW = 3;
const REPO_DATA = resolve(import.meta.dirname, '..', 'data');

const EXCLUDED = new Set(EXCLUDED_KINDS);

/** A problem with what was asked (unknown chat, bad folder, bad page). exitCode 2 = usage. */
export class ChatError extends Error {
  constructor(message, { exitCode = 2 } = {}) {
    super(message);
    this.name = 'ChatError';
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------------------------

/** The other person's display name in a 1-1 chat, from the newest messages they sent (null when none is on this PC). */
async function partnerName(bridge, convId) {
  const rows = await bridge.getMessages(convId, { limit: SENDER_PROBE, maxPages: 1 });
  const theirs = rows.find(m => String(m.fromUid) === convId && m.dName);
  return theirs ? String(theirs.dName) : null;
}

/** convId -> { isGroup, name, altName } for every conversation. Strangers (no contact row) get name null here. */
async function directory(bridge) {
  const [conversations, friends, groups] = await Promise.all([bridge.listConversations(), bridge.listFriends(), bridge.listGroups()]);
  const friendById = new Map(friends.map(f => [f.userId, f]));
  const groupById = new Map(groups.map(g => [String(g.convId), g]));
  return conversations.map(({ convId, isGroup }) => {
    if (isGroup) return { convId, isGroup, name: groupById.get(convId)?.name ?? null, altName: null };
    const f = friendById.get(convId);
    const name = f?.displayName ?? f?.zaloName ?? null;
    return { convId, isGroup, name, altName: f?.zaloName && f.zaloName !== name ? f.zaloName : null };
  });
}

const matches = (words, ...names) => {
  const hay = fold(names.filter(Boolean).join(' '));
  return words.every(w => hay.includes(w));
};

/**
 * Conversations whose name (contact alias, Zalo name or group name) contains every word of `query`, ignoring case and
 * accents, newest message first. When no contact or group matches, the 1-1 chats with people who are not in the contact
 * list are searched too, by the name they send under (one small read per chat).
 * @returns {Promise<{ chats: object[], total: number, searchedStrangers: boolean }>}
 */
export async function findChats(bridge, query, { max = FIND_MAX } = {}) {
  const words = fold(String(query ?? '')).split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new ChatError('Thiếu tên cần tìm. Ví dụ: node zmi.mjs chat find "Nam GreenPower"');
  const all = await directory(bridge);
  let found = all.filter(c => c.name !== null && matches(words, c.name, c.altName));
  let searchedStrangers = false;
  if (found.length === 0) {
    searchedStrangers = true;
    for (const c of all.filter(x => !x.isGroup && x.name === null)) {
      const name = await partnerName(bridge, c.convId);
      if (name && matches(words, name)) found.push({ ...c, name });
    }
  }
  const total = found.length;
  found = found.slice(0, max);
  for (const c of found) {
    const [last] = await bridge.getMessages(c.convId, { limit: 1, maxPages: 1 });
    c.lastTs = last ? Number(last.sendDttm) : null;
  }
  found.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  return { chats: found, total, searchedStrangers };
}

export function formatChatLine(c) {
  const kind = c.isGroup ? 'nhóm' : '1-1';
  const name = oneLine(c.name ?? '(không rõ tên)') + (c.altName ? ` (tên Zalo: ${oneLine(c.altName)})` : '');
  const last = c.lastTs ? `tin cuối ${formatVnDate(c.lastTs)} ${formatVnTime(c.lastTs)}` : 'chưa có tin trên máy';
  return `${c.convId} | ${kind} | ${name} | ${last}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The save folder
// ---------------------------------------------------------------------------------------------------------------------

const inside = (dir, path) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** Checks and creates the folder files are copied to. Refuses Zalo's own folders and zmi's data/. Returns the absolute path. */
export function prepareSaveDir(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new ChatError('--save-to cần một thư mục.');
  if (!isAbsolute(dir)) throw new ChatError(`--save-to phải là đường dẫn đầy đủ (ví dụ C:\\...\\Zalo files\\Ten khach), nhận được: "${dir}".`);
  const abs = resolve(dir);
  if (/[\\/](ZaloData|ZaloPC)([\\/]|$)/i.test(abs)) throw new ChatError('--save-to không được nằm trong thư mục dữ liệu của Zalo.');
  if (inside(REPO_DATA.toLowerCase(), abs.toLowerCase())) throw new ChatError('--save-to không được nằm trong thư mục data/ của zmi (chat riêng không lưu cùng dữ liệu nhóm).');
  mkdirSync(abs, { recursive: true });
  return abs;
}

// ---------------------------------------------------------------------------------------------------------------------
// One chat
// ---------------------------------------------------------------------------------------------------------------------

const textOf = s => (s === null || s === undefined ? '' : oneLine(String(s)));

/** The line content before files/images are resolved. null = nothing to show. */
function baseContent(n) {
  const m = n.message;
  switch (m.kind) {
    case 'file': {
      const f = n.files[0] ?? {};
      const size = formatSize(f.size);
      return `[File] ${textOf(f.file_name ?? m.title) || '(không tên)'}${size ? ` (${size})` : ''}`;
    }
    case 'photo': {
      const caption = textOf(n.images[0]?.caption ?? m.text);
      return caption ? `[Ảnh] ${caption}` : '[Ảnh]';
    }
    case 'link': {
      const own = m.text && m.url && m.text.trim() === m.url.trim() ? '' : textOf(m.text);
      return [own, linkCard({ title: m.title, description: m.description, domain: n.links[0]?.domain, url: m.url })].filter(Boolean).join(' ');
    }
    case 'member_event':
      return m.text ? `[Thành viên] ${textOf(m.text)}` : null;
    default:
      return m.text && String(m.text).trim() !== '' ? textOf(m.text) : null;
  }
}

function linePrefix(n) {
  const m = n.message;
  const sender = m.kind === 'member_event' ? '' : `${textOf(m.sender_name) || '(không rõ)'}: `;
  const quote = m.quote_text ? `(trả lời "${clip(oneSpace(m.quote_text), QUOTE_CHARS)}") ` : '';
  return `[${formatVnTime(m.ts)}] ${sender}${quote}`;
}

const isScreenshot = image => image && shapeClass(image.width, image.height) !== 'photo';

/** Splits the entries into pages of about `pageChars` characters, always at a message boundary. */
function paginate(entries, pageChars) {
  const pages = [];
  let current = [];
  let size = 0;
  for (const e of entries) {
    const len = e.base.length + 40; // room for the time, the id and a saved-file path
    if (current.length > 0 && size + len > pageChars) { pages.push(current); current = []; size = 0; }
    current.push(e);
    size += len;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

/**
 * One page of a chat, oldest first. Reads the conversation from Zalo (read-only), never the database.
 * With `saveTo`, the files and screenshots of THIS page are copied there (files of any type; screenshots only when OCR finds text).
 * @param {object} bridge read-only bridge (lib/zalo-bridge.mjs)
 * @param {string} convId from `zmi chat find`
 * @param {{ from?: number, to?: number, page?: number, pageChars?: number, saveTo?: string,
 *   fileOptions?: object, imageOptions?: object }} options from/to are epoch ms (inclusive)
 */
export async function readChat(bridge, convId, { from, to, page = 1, pageChars = PAGE_CHARS, saveTo, fileOptions = {}, imageOptions = {} } = {}) {
  if (!Number.isInteger(page) || page < 1) throw new ChatError(`--page cần một số nguyên từ 1 trở lên, nhận được: "${page}".`);
  const entry = (await directory(bridge)).find(c => c.convId === String(convId));
  if (!entry) throw new ChatError(`Không có chat "${convId}" trên Zalo này. Tìm mã chat bằng: node zmi.mjs chat find "tên khách"`);
  const name = entry.name ?? (entry.isGroup ? null : await partnerName(bridge, entry.convId)) ?? '(không rõ tên)';

  const raw = await bridge.getMessages(entry.convId, { fromTs: from });
  const all = raw
    .map(r => normalizeMessage(r, { convId: entry.convId }))
    .filter(n => !EXCLUDED.has(n.message.kind) && (to === undefined || n.message.ts <= to) && (from === undefined || n.message.ts >= from))
    .sort((a, b) => a.message.ts - b.message.ts || a.message.msg_id.localeCompare(b.message.msg_id));
  const entries = all.map(n => ({ n, base: baseContent(n) })).filter(e => e.base !== null);
  const pages = paginate(entries, pageChars);
  const total = Math.max(pages.length, 1);
  if (page > total) throw new ChatError(`Chat này chỉ có ${total} trang trong kỳ đã chọn (đang xin trang ${page}).`);
  const onPage = pages[page - 1] ?? [];

  const stats = { messages: entries.length, onPage: onPage.length, files: { stored: 0, notStored: 0 }, screenshots: { stored: 0, noText: 0, failed: 0 }, photos: 0 };
  const dir = saveTo ? prepareSaveDir(saveTo) : null;

  // Files and screenshots of this page only.
  let mediaFiles = null;
  let imageIndex = null;
  let imageFailures = 0;
  let ocrStopped = false;
  const lines = [];
  let day = null;
  for (const { n, base } of onPage) {
    const m = n.message;
    let content = base;
    if (m.kind === 'file' && n.files[0]) {
      if (dir) {
        const f = n.files[0];
        mediaFiles ??= await bridge.getMediaRows(entry.convId, 'File').catch(() => []);
        const raw_json = m.raw_json;
        const result = await resolveFile(f, {
          outDir: dir, allExtensions: true,
          localPaths: fileCandidates(raw_json, pickMediaRow(mediaFiles, { cli_msg_id: m.cli_msg_id, from_uid: m.from_uid, ts: m.ts }), { appData: fileOptions.appData }),
          ...fileOptions,
        });
        if (result.status === 'stored') { stats.files.stored++; content += ` → ${result.stored_path}`; }
        else { stats.files.notStored++; content += ` → chưa lưu được (${result.error ?? result.status})${f.remote_url ? `; link: ${f.remote_url}` : ''}`; }
      }
    } else if (m.kind === 'photo') {
      const image = n.images[0];
      if (!isScreenshot(image)) {
        stats.photos++;
      } else if (dir && !ocrStopped) {
        imageIndex ??= cacheIndexFor([entry.convId], { appData: imageOptions.appData });
        const baseName = sanitizeFileName(`${formatVnDate(m.ts)}_${formatVnTime(m.ts).replace(':', '')}_anh-${m.msg_id}`);
        try {
          const got = await chatImageTo({ ...image, cli_msg_id: m.cli_msg_id, from_uid: m.from_uid }, { bridge, index: imageIndex, outDir: dir, baseName, ...imageOptions });
          imageFailures = 0;
          const caption = textOf(image.caption);
          if (got.status === 'stored') {
            stats.screenshots.stored++;
            const parts = [caption, got.ocr_text ? clip(oneSpace(got.ocr_text), OCR_CHARS) : ''].filter(Boolean);
            content = `[Ảnh có chữ] ${parts.length ? `${parts.join(' | ')} ` : ''}→ ${got.path}`;
          } else if (got.status === 'no_text') {
            stats.screenshots.noText++;
            content = `[Ảnh chụp màn hình, không có chữ]${caption ? ` ${caption}` : ''}`;
          } else {
            stats.screenshots.failed++;
            content = `[Ảnh chụp màn hình]${caption ? ` ${caption}` : ''} (không lấy được ảnh: ${got.error})`;
          }
        } catch (error) {
          stats.screenshots.failed++;
          content = `${base} (lỗi đọc ảnh: ${String(error?.message ?? error).split('\n')[0]})`;
          if (++imageFailures >= MAX_IMAGE_FAILURES_IN_A_ROW) ocrStopped = true;
        }
      }
    }
    const date = formatVnDate(m.ts);
    if (date !== day) {
      day = date;
      lines.push('', `## ${date} (${weekdayOf(m.ts)})`, '');
    }
    lines.push(`${linePrefix(n)}${content} #m${m.msg_id}`);
  }
  if (ocrStopped) stats.ocrStopped = true;

  const first = all[0]?.message.ts;
  const last = all.at(-1)?.message.ts;
  const title = `# ${oneLine(name)} (${entry.isGroup ? 'nhóm' : 'chat 1-1'})`;
  const header = [
    title,
    '',
    `Kỳ: ${from === undefined && to === undefined ? 'toàn bộ lịch sử trên máy' : `${from === undefined ? 'đầu' : formatVnDate(from)} → ${to === undefined ? 'nay' : formatVnDate(to)}`}`
      + (first ? ` · tin từ ${formatVnDate(first)} đến ${formatVnDate(last)}` : '')
      + ` · ${entries.length.toLocaleString('vi-VN')} tin · trang ${page}/${total}`,
  ];
  return { title, header, lines, page, pages: total, stats, saveDir: dir };
}

/** One summary line about what this page did with files and images. */
export function formatChatStats(stats, saveDir) {
  const parts = [`${stats.onPage} tin trên trang này`];
  if (saveDir) {
    parts.push(`file: ${stats.files.stored} đã lưu${stats.files.notStored ? `, ${stats.files.notStored} chưa lưu được` : ''}`);
    parts.push(`ảnh chụp màn hình: ${stats.screenshots.stored} có chữ đã lưu, ${stats.screenshots.noText} không có chữ${stats.screenshots.failed ? `, ${stats.screenshots.failed} lỗi` : ''}`);
  }
  parts.push(`${stats.photos} ảnh thường (không đọc)`);
  return parts.join(' · ');
}
