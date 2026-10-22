// Message normalization (spec 6.4): one raw Zalo message -> the row objects lib/db.mjs upserts.
//
//   normalizeMessage(raw, { convId }) -> { message, links, files, images, memberEvents }
//   classifyMemberEvent(text)         -> 'joined' | 'added' | 'removed' | 'promoted' | 'other'
//
// Pure: no Zalo access, no I/O, the input is never mutated. Object keys are the spec section 7 column names.
//
// Conventions
// - Every id value is a string (msg_id, conv_id, cli_msg_id, from_uid, quote_msg_id): lib/db.mjs rejects numbers,
//   because Zalo ids can exceed 2^53. Zalo hands some quote ids over as JS numbers; today's ids are ~13 digits, so
//   String() is exact. ts is a Number (milliseconds); Zalo sends sendDttm as a string.
// - Empty values become null, never "" / "undefined".
// - Columns that later tasks own are left OUT of the side rows (files.status/stored_path, images.status/stored_path/
//   shape_class/text_score/ocr_text/has_text/scanned_at). db.mjs leaves absent keys alone on update, so a re-sync of
//   an already-processed message cannot reset them.
// - raw_json is the raw message with empty fields dropped, so a message can be re-processed without asking Zalo again.

const KIND_BY_MSG_TYPE = new Map([
  [1, 'text'], [2, 'photo'], [6, 'link'], [19, 'file'], [-4, 'member_event'],
  [20, 'recalled'], [-27, 'deleted'], [4, 'sticker'], [18, 'video'],
]);

// ---------------------------------------------------------------------------------------------------------------------
// Small coercions
// ---------------------------------------------------------------------------------------------------------------------

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A non-empty string, else null. */
const text = v => (typeof v === 'string' && v !== '' ? v : null);

/** An id as a string, else null. */
const id = v => (v === undefined || v === null || v === '' ? null : String(v));

/** A finite number from a number or numeric string, else null. */
const num = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Zalo stores structured bodies (and their `params`) either as an object or as a JSON string. Returns an object or null. */
function asObject(v) {
  if (isPlainObject(v)) return v;
  if (typeof v === 'string' && v.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(v);
      return isPlainObject(parsed) ? parsed : null;
    } catch { /* not JSON after all */ }
  }
  return null;
}

/** The readable text of a message body: the string itself, or `title` of an object body (rich text, notices). */
const textOf = message => (typeof message === 'string' ? text(message) : isPlainObject(message) ? text(message.title) : null);

const isEmpty = v => v === null || v === undefined || v === '' || (Array.isArray(v) ? v.length === 0 : isPlainObject(v) && Object.keys(v).length === 0);

/** Deep copy without null / undefined / '' / [] / {} (0 and false stay). */
function compact(v) {
  if (Array.isArray(v)) return v.map(compact).filter(x => !isEmpty(x));
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const c = compact(x);
      if (!isEmpty(c)) out[k] = c;
    }
    return out;
  }
  return typeof v === 'bigint' ? v.toString() : v;
}

/** Hostname without a leading "www.", or null when the URL cannot be parsed. */
function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Lowercase extension of a file name ("Báo cáo.v2.XLSX" -> "xlsx"), or null. */
function extOfName(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name ?? '');
  return m ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Member events (msgType -4)
// ---------------------------------------------------------------------------------------------------------------------

// Zalo says "nhóm" for groups and "cộng đồng" for communities. The subject (who) and the actor (by whom) are optional
// so that "đã tham gia cộng đồng" still classifies. Keywords are matched case-sensitively on purpose: a person named
// "Được" must not be taken for the word "được". The order matters: "được" appears in both added and removed, and a
// notice such as "chỉ cho phép trưởng/phó cộng đồng xem ..." mentions trưởng/phó without promoting anyone.
const NOUN = '(?:nhóm|cộng đồng)';
const MEMBER_EVENT_PATTERNS = [
  ['removed', new RegExp(`^(?:(.+?) )?(?:được|bị) (?:(.+?) )?x(?:óa|oá) khỏi ${NOUN}`)],
  ['added', new RegExp(`^(?:(.+?) )?được (?:(.+?) )?thêm vào ${NOUN}`)],
  ['joined', new RegExp(`^(?:(.+?) )?(?:đã|vừa) tham gia ${NOUN}`)],
  ['promoted', new RegExp('^(?:(.+?) )?(?:đã )?được (?:(.+?) )?bổ nhiệm')],
];

/** { event, member_name, actor_name } from the notice text. Names are best effort (null when the pattern has none). */
function parseMemberEvent(message) {
  // NFC: some Vietnamese text arrives decomposed. Spaces collapse because Zalo sometimes writes "Phu Nguyen  xóa khỏi".
  const s = typeof message === 'string' ? message.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  for (const [event, pattern] of MEMBER_EVENT_PATTERNS) {
    const m = pattern.exec(s);
    if (m) return { event, member_name: text(m[1]), actor_name: event === 'joined' ? null : text(m[2]) };
  }
  return { event: 'other', member_name: null, actor_name: null };
}

/** @returns {'joined'|'added'|'removed'|'promoted'|'other'} */
export const classifyMemberEvent = message => parseMemberEvent(message).event;

// ---------------------------------------------------------------------------------------------------------------------
// Per-kind content. Each builder gets { raw, row, sender_name } (row = { msg_id, conv_id, ts }) and returns the
// messages columns it fills (text/title/description/url) plus its side rows. Returning null means "treat as other".
// ---------------------------------------------------------------------------------------------------------------------

const structured = raw => asObject(raw.message) ?? {};

const BUILDERS = {
  // The sender's words. Long posts arrive as { title, action: 'rtf', params: styles }: the words are `title`.
  // Text messages are not scanned for URLs, only msgType 6 produces links rows.
  text: ({ raw }) => ({ fields: { text: textOf(raw.message) } }),

  // Caption is message.title. Width/height come from params (the raw width/height are usually null).
  photo: ({ raw, row, sender_name }) => {
    const body = structured(raw);
    const params = asObject(body.params) ?? {};
    const caption = text(body.title);
    const remote_url = text(body.hdUrl) ?? text(body.oriUrl) ?? text(body.normalUrl) ?? text(body.href);
    return {
      fields: { text: caption, url: remote_url },
      images: [{
        ...row, sender_name, caption,
        width: num(params.width) ?? num(raw.width),
        height: num(params.height) ?? num(raw.height),
        remote_url,
        cache_path: text(raw.localPath), // as Zalo stored it; remapping to the current media folder is a later task
      }],
    };
  },

  // For a link message message.title is what the sender wrote (usually text plus the URL, sometimes just the URL,
  // sometimes empty), so it goes to messages.text where export and search see it. The preview (what the page is
  // called) is params.mediaTitle; message.description is the preview description.
  // A msgType 6 body without an http(s) href is not a link (a shared contact has href "www.zaloapp.com").
  link: ({ raw, row }) => {
    const body = structured(raw);
    const url = text(body.href);
    if (!url || !/^https?:\/\//i.test(url)) return null;
    const title = text((asObject(body.params) ?? {}).mediaTitle);
    const description = text(body.description);
    return {
      fields: { text: text(body.title), title, description, url },
      links: [{ ...row, url, domain: domainOf(url), title, description }],
    };
  },

  // message.title is the file name. It also goes to messages.title so full-text search finds file names; text stays null.
  file: ({ raw, row, sender_name }) => {
    const body = structured(raw);
    const params = asObject(body.params) ?? {};
    const file_name = text(body.title);
    const remote_url = text(body.href);
    const ext = text(params.fileExt)?.replace(/^\./, '').toLowerCase() || extOfName(file_name);
    const checksum = text(params.checksum);
    return {
      fields: { title: file_name, url: remote_url },
      files: [{
        ...row, sender_name, file_name, ext,
        size: num(params.fileSize) ?? num(raw.fileSize),
        checksum: checksum === null || checksum.toLowerCase() === 'null' ? null : checksum,
        remote_url,
      }],
    };
  },

  member_event: ({ raw, row }) => {
    const message = textOf(raw.message);
    const { event, member_name, actor_name } = parseMemberEvent(message);
    const uids = Array.isArray(raw.updateMemberIds) ? raw.updateMemberIds.map(id).filter(uid => uid !== null) : [];
    return {
      fields: { text: message },
      memberEvents: [{ ...row, event, member_uids_json: uids.length ? JSON.stringify(uids) : null, member_name, actor_name, text: message }],
    };
  },

  // Their content is gone (the message is only a "[Tin nhắn đã được thu hồi]" placeholder): kind is all that is kept.
  recalled: () => ({ fields: {} }),
  deleted: () => ({ fields: {} }),

  // Minimal rows; the details stay in raw_json.
  sticker: () => ({ fields: {} }),
  video: () => ({ fields: {} }),

  // Unknown msgTypes (group notices, pins, ...): keep whatever readable text there is, raw_json keeps the rest.
  other: ({ raw }) => ({ fields: { text: textOf(raw.message) } }),
};

// ---------------------------------------------------------------------------------------------------------------------

/**
 * Turns one raw Zalo message into the rows to upsert.
 * @param {object} raw a message as returned by Bridge.getMessages
 * @param {{ convId: string }} options convId is the conversation the message was read from (the raw row does not
 *   reliably carry it)
 * @returns {{ message: object, links: object[], files: object[], images: object[], memberEvents: object[] }}
 */
export function normalizeMessage(raw, { convId } = {}) {
  if (!isPlainObject(raw)) throw new TypeError('normalizeMessage: raw must be a message object');
  if (typeof convId !== 'string' || convId === '') {
    throw new TypeError('normalizeMessage: convId must be a non-empty string (Zalo ids exceed 2^53, never pass a number)');
  }
  const msg_id = id(raw.msgId);
  if (msg_id === null) throw new TypeError('normalizeMessage: raw.msgId is missing');
  const ts = num(raw.sendDttm);
  if (ts === null) throw new TypeError(`normalizeMessage: raw.sendDttm is not a number (msgId ${msg_id})`);

  const row = { msg_id, conv_id: convId, ts };
  const sender_name = text(raw.dName);
  let kind = KIND_BY_MSG_TYPE.get(Number(raw.msgType)) ?? 'other';
  let built = BUILDERS[kind]({ raw, row, sender_name });
  if (built === null) {
    kind = 'other';
    built = BUILDERS.other({ raw, row, sender_name });
  }

  const quote = isPlainObject(raw.quote) ? raw.quote : null;
  const message = {
    msg_id,
    conv_id: convId,
    cli_msg_id: id(raw.cliMsgId),
    ts,
    from_uid: id(raw.fromUid),
    sender_name,
    msg_type: raw.msgType === undefined || raw.msgType === null ? null : String(raw.msgType),
    kind,
    text: null,
    title: null,
    description: null,
    url: null,
    quote_msg_id: quote ? id(quote.globalMsgId) : null,
    quote_text: quote ? text(quote.msg) : null,
    mentions_json: Array.isArray(raw.mentions) && raw.mentions.length > 0 ? JSON.stringify(raw.mentions) : null,
    raw_json: JSON.stringify(compact(raw)),
    ...built.fields,
  };

  return {
    message,
    links: built.links ?? [],
    files: built.files ?? [],
    images: built.images ?? [],
    memberEvents: built.memberEvents ?? [],
  };
}
