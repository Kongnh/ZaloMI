// Pulls the messages of the tracked groups from Zalo into the database (spec 6.3, 6.4 last bullets, 6.8).
//
//   syncGroup(bridge, db, convId, opts)   one group: read from Zalo, then normalize + upsert in one transaction
//   syncAll(bridge, db, convIds, opts)    every group in turn, one failing group never stops the next; one sync_runs row
//   resolveTargets / format*              which groups `zmi sync` reads, and how its result is printed
//
// Pure orchestration: no Zalo and no SQLite import (the bridge and the db are passed in), so tests drive it with a fake bridge.
// Reading Zalo is async and a db transaction must be synchronous, so each group is read completely first
// (outside any transaction) and written afterwards.

import { normalizeMessage } from './normalize.mjs';

const DAY_MS = 86400000;
const RETRACTED_KINDS = new Set(['recalled', 'deleted']);
const MAX_ERROR_LINES = 3;

const thousands = n => Number(n).toLocaleString('vi-VN'); // 2698 -> "2.698"

// ---------------------------------------------------------------------------------------------------------------------
// One group
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What to write for a normalized message. A message that Zalo now reports as recalled/deleted, and that is already
 * stored, only changes kind and msg_type: its text, title, description and raw_json stay (spec 6.4: the old content is
 * kept, it is private data on this machine). Partial upserts leave absent columns alone and the full-text row is rebuilt
 * from the stored columns, so the old text stays searchable. This also covers a message that was merged on an earlier
 * run: the overlap window fetches it again every run, and must not blank it then.
 */
function messageToWrite(message, stored) {
  if (!stored || !RETRACTED_KINDS.has(message.kind)) return message;
  const { msg_id, conv_id, kind, msg_type } = message;
  return { msg_id, conv_id, kind, msg_type };
}

/**
 * Syncs one group.
 * - Window: `full`, or nothing stored yet, reads the whole history; otherwise only messages from
 *   (newest stored ts - overlapDays), which catches late-synced, recalled and deleted messages. Upserts make overlap harmless.
 * - A message that cannot be normalized is recorded in `errors` and skipped; the rest still land.
 * - A failure while reading Zalo or writing the db throws, after the group's transaction was rolled back.
 * @param {{ getMessages(convId: string, opts?: { fromTs?: number }): Promise<object[]> }} bridge
 * @param {object} db the lib/db.mjs API
 * @param {string} convId
 * @param {{ overlapDays?: number, full?: boolean, now?: () => number }} [options]
 * @returns {Promise<{ fetched: number, new: number, updated: number, errors: { msg_id: string|null, error: string }[] }>}
 */
export async function syncGroup(bridge, db, convId, { overlapDays = 3, full = false, now = Date.now } = {}) {
  // maxTs(undefined) would quietly answer 0 and turn an incremental run into a full backfill of nothing.
  if (typeof convId !== 'string' || convId === '') {
    throw new TypeError('syncGroup: convId must be a non-empty string (Zalo ids exceed 2^53, never pass a number)');
  }
  if (!Number.isFinite(overlapDays) || overlapDays < 0) throw new RangeError(`syncGroup: overlapDays must be 0 or more, got ${String(overlapDays)}`);

  const newest = full ? 0 : db.maxTs(convId);
  const fromTs = newest > 0 ? Math.max(0, Math.floor(newest - overlapDays * DAY_MS)) : undefined;
  const raws = await bridge.getMessages(convId, fromTs === undefined ? {} : { fromTs });

  // Zalo answers newest first; storing oldest first keeps the insert order chronological.
  const rows = [];
  const errors = [];
  for (const raw of [...raws].reverse()) {
    try {
      rows.push(normalizeMessage(raw, { convId }));
    } catch (error) {
      errors.push({ msg_id: raw?.msgId === undefined || raw.msgId === null ? null : String(raw.msgId), error: error.message });
    }
  }

  const storedKind = db.raw.prepare('SELECT kind FROM messages WHERE msg_id = ?');
  let added = 0;
  let changed = 0;
  db.transaction(() => {
    for (const { message, links, files, images, memberEvents } of rows) {
      const result = db.upsertMessage(messageToWrite(message, storedKind.get(message.msg_id)));
      if (result.inserted) added++;
      else if (result.changed) changed++;
      for (const link of links) db.upsertLink(link);
      for (const file of files) db.upsertFile(file);
      for (const image of images) db.upsertImage(image);
      for (const event of memberEvents) db.upsertMemberEvent(event);
    }
    const latest = db.maxTs(convId);
    db.upsertGroup({ conv_id: convId, last_synced_at: now(), ...(latest > 0 ? { last_msg_ts: latest } : {}) });
  });

  return { fetched: raws.length, new: added, updated: changed, errors };
}

// ---------------------------------------------------------------------------------------------------------------------
// Every group
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Syncs `convIds` one after another and records one sync_runs row for the whole call.
 * A group that fails (Zalo unreadable, db write rejected) is reported with ok: false and the run goes on with the next.
 * @param {object} bridge
 * @param {object} db
 * @param {string[]} convIds
 * @param {{ overlapDays?: number, full?: boolean, now?: () => number, onGroup?: (result: object) => void }} [options]
 *   `onGroup` is called with each group's result as soon as it is done (for progress output).
 * @returns {Promise<{ runId: number, startedAt: number, finishedAt: number, groups: object[], totals: object }>}
 */
export async function syncAll(bridge, db, convIds, { onGroup, ...options } = {}) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const groups = [];
  const errors = [];
  const totals = { groups: convIds.length, fetched: 0, new: 0, updated: 0, errors: 0, failedGroups: 0 };

  for (const convId of convIds) {
    let result;
    try {
      result = { convId, ok: true, ...await syncGroup(bridge, db, convId, options) };
    } catch (error) {
      result = { convId, ok: false, fetched: 0, new: 0, updated: 0, errors: [], error: error.message };
    }
    groups.push(result);

    totals.fetched += result.fetched;
    totals.new += result.new;
    totals.updated += result.updated;
    totals.errors += result.errors.length;
    if (!result.ok) {
      totals.failedGroups++;
      errors.push({ conv_id: convId, error: result.error });
    }
    for (const e of result.errors) errors.push({ conv_id: convId, ...e });

    onGroup?.(result);
  }

  const finishedAt = now();
  const runId = db.recordSyncRun({
    started_at: startedAt,
    finished_at: finishedAt,
    groups: convIds.length,
    new_messages: totals.new,
    updated_messages: totals.updated,
    errors_json: JSON.stringify(errors),
  });
  return { runId, startedAt, finishedAt, groups, totals };
}

// ---------------------------------------------------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------------------------------------------------

export class SyncUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SyncUsageError';
  }
}

/**
 * The groups `zmi sync` reads, as [{ convId, name }]. Default: groups with tracked: true that are still on Zalo, in
 * config order. With `requestedIds` exactly those groups (tracked or not, each once), which must be in the config and
 * still on Zalo.
 * @throws {SyncUsageError} for an id that is not in the config, or whose group is gone from Zalo.
 */
export function resolveTargets(config, requestedIds = []) {
  const pick = g => ({ convId: g.convId, name: g.name || g.convId });
  if (requestedIds.length === 0) return config.groups.filter(g => g.tracked && !g.missing).map(pick);

  const byId = new Map(config.groups.map(g => [g.convId, g]));
  const targets = [];
  const unknown = [];
  const gone = [];
  for (const convId of new Set(requestedIds)) {
    const group = byId.get(convId);
    if (!group) unknown.push(convId);
    else if (group.missing) gone.push(convId);
    else targets.push(pick(group));
  }
  const problems = [];
  if (unknown.length) problems.push(`Không có trong config/groups.json: ${unknown.join(', ')} (xem danh sách bằng: node zmi.mjs groups).`);
  if (gone.length) problems.push(`Nhóm không còn trên Zalo: ${gone.join(', ')}.`);
  if (problems.length) throw new SyncUsageError(problems.join(' '));
  return targets;
}

/** How many messages of the group are in the database. */
export function storedCount(db, convId) {
  return db.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_id = ?').get(convId).n;
}

/** One Vietnamese line per group: "<name>: +12 tin mới, 1 cập nhật (2.698 tin trên máy)". */
export function formatGroupLine(result, { name, stored }) {
  if (!result.ok) return `✗ ${name}: lỗi, chưa ghi gì cho nhóm này (${result.error})`;
  const bad = result.errors.length > 0 ? `, ${thousands(result.errors.length)} tin lỗi` : '';
  return `${name}: +${thousands(result.new)} tin mới, ${thousands(result.updated)} cập nhật${bad} (${thousands(stored)} tin trên máy)`;
}

/** Indented lines naming the first bad messages of a group (ids and reasons only, never message text). */
export function formatErrorLines(result, max = MAX_ERROR_LINES) {
  if (!result.ok) return [];
  const lines = result.errors.slice(0, max).map(e => `    tin ${e.msg_id ?? '(không có msgId)'}: ${e.error}`);
  if (result.errors.length > max) lines.push(`    … và ${thousands(result.errors.length - max)} tin lỗi khác (chi tiết trong sync_runs.errors_json)`);
  return lines;
}

/** The closing line: "Tổng: 28 nhóm, +12.345 tin mới, 3 cập nhật (42 giây)", plus bad messages / failed groups when there are any. */
export function formatTotalLine(totals, { seconds }) {
  const parts = [`${thousands(totals.groups)} nhóm`, `+${thousands(totals.new)} tin mới`, `${thousands(totals.updated)} cập nhật`];
  if (totals.errors > 0) parts.push(`${thousands(totals.errors)} tin lỗi`);
  if (totals.failedGroups > 0) parts.push(`${thousands(totals.failedGroups)} nhóm lỗi`);
  return `Tổng: ${parts.join(', ')} (${thousands(Math.round(seconds))} giây)`;
}
