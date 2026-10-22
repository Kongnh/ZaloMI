import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeMessage, classifyMemberEvent } from '../lib/normalize.mjs';
import { openDb } from '../lib/db.mjs';

const CONV = 'g8318398124727869839';
const FIXTURES = new URL('./fixtures/messages/', import.meta.url);

/** Raw message exactly as stored in test/fixtures/messages (real structure, redacted names/phones/emails). */
const load = name => JSON.parse(fs.readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));
const norm = name => normalizeMessage(load(name), { convId: CONV });

/** Minimal raw message for synthetic edge cases the real conversation never produced. */
const rawMsg = (over = {}) => ({
  msgId: '1000', cliMsgId: '2000', msgType: 1, sendDttm: '1700000000000', fromUid: '3000', dName: 'Người X', message: 'xin chào', ...over,
});

const EXPECTED_KIND = {
  'text-plain': 'text',
  'text-quote-mentions': 'text',
  'text-rtf': 'text',
  'photo-caption-cached': 'photo',
  'photo-no-caption': 'photo',
  'photo-no-hd-url': 'photo',
  'link-text-and-url': 'link',
  'link-www-host': 'link',
  'link-bare-url': 'link',
  'link-no-text': 'link',
  'link-contact-card': 'other',
  'file-cached': 'file',
  'file-remote': 'file',
  'member-added': 'member_event',
  'member-joined': 'member_event',
  'member-removed': 'member_event',
  'member-promoted': 'member_event',
  'member-you-joined': 'member_event',
  'member-setting': 'member_event',
  recalled: 'recalled',
  'recalled-object': 'recalled',
  deleted: 'deleted',
  'deleted-image': 'deleted',
  sticker: 'sticker',
  video: 'video',
  'system-notice': 'other',
};
const fixtureNames = fs.readdirSync(FIXTURES).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort();

const MESSAGE_KEYS = ['msg_id', 'conv_id', 'cli_msg_id', 'ts', 'from_uid', 'sender_name', 'msg_type', 'kind', 'text', 'title', 'description',
  'url', 'quote_msg_id', 'quote_text', 'mentions_json', 'raw_json'];
const rowCounts = r => ({ links: r.links.length, files: r.files.length, images: r.images.length, memberEvents: r.memberEvents.length });
const NO_ROWS = { links: 0, files: 0, images: 0, memberEvents: 0 };

// ---------------------------------------------------------------------------------------------------------------------
// Every fixture
// ---------------------------------------------------------------------------------------------------------------------

test('every fixture file has an expectation (no fixture is left untested)', () => {
  assert.deepEqual(fixtureNames, Object.keys(EXPECTED_KIND).sort());
});

for (const name of fixtureNames) {
  test(`${name}: kind ${EXPECTED_KIND[name]}, spec 7 keys, string ids, numeric ts, raw untouched`, () => {
    const raw = load(name);
    const before = structuredClone(raw);
    const result = normalizeMessage(raw, { convId: CONV });
    const { message } = result;

    assert.deepEqual(Object.keys(result).sort(), ['files', 'images', 'links', 'memberEvents', 'message']);
    assert.deepEqual(Object.keys(message), MESSAGE_KEYS);
    assert.equal(message.kind, EXPECTED_KIND[name]);
    assert.equal(message.msg_id, raw.msgId);
    assert.equal(message.conv_id, CONV);
    assert.equal(message.cli_msg_id, raw.cliMsgId);
    assert.equal(message.from_uid, raw.fromUid ?? null);
    assert.equal(message.sender_name, raw.dName || null);
    assert.equal(message.msg_type, String(raw.msgType));
    assert.equal(typeof message.ts, 'number');
    assert.equal(message.ts, Number(raw.sendDttm));
    for (const key of ['msg_id', 'conv_id', 'cli_msg_id', 'from_uid', 'quote_msg_id']) {
      assert.ok(message[key] === null || typeof message[key] === 'string', `${key} must be a string or null, got ${typeof message[key]}`);
    }
    for (const row of [...result.links, ...result.files, ...result.images, ...result.memberEvents]) {
      assert.equal(row.msg_id, message.msg_id);
      assert.equal(row.conv_id, CONV);
      assert.equal(row.ts, message.ts);
    }
    assert.equal(JSON.parse(message.raw_json).msgId, raw.msgId, 'raw_json round-trips');
    assert.deepEqual(raw, before, 'normalizeMessage must not mutate its input');
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// text (1)
// ---------------------------------------------------------------------------------------------------------------------

test('text: content in text, nothing else filled, no side rows', () => {
  const r = norm('text-plain');
  assert.equal(r.message.text, 'Thông tin cập nhật bổ ích, cám ơn');
  for (const key of ['title', 'description', 'url', 'quote_msg_id', 'quote_text', 'mentions_json']) assert.equal(r.message[key], null, key);
  assert.deepEqual(rowCounts(r), NO_ROWS);
});

test('text with quote and mentions: quote id is a string even when Zalo gave a number', () => {
  const raw = load('text-quote-mentions');
  assert.equal(typeof raw.quote.globalMsgId, 'number', 'fixture keeps the numeric globalMsgId Zalo really returns');
  const r = normalizeMessage(raw, { convId: CONV });
  assert.equal(r.message.text, '@Người B có a');
  assert.equal(r.message.quote_msg_id, '6663877587183');
  assert.equal(r.message.quote_text, '@Người C dự án có ở Đồng Nai ko anh ?');
  assert.deepEqual(JSON.parse(r.message.mentions_json), [{ uid: '7886905876230323340', pos: 0, len: 8, type: 0 }]);
});

test('rich text (message is an object with action rtf): the text is message.title; a link inside stays text', () => {
  const raw = load('text-rtf');
  const r = normalizeMessage(raw, { convId: CONV });
  assert.equal(r.message.kind, 'text');
  assert.equal(r.message.text, raw.message.title);
  assert.match(r.message.text, /^Nếu anh chị nào có được bản Báo cáo/);
  assert.equal(r.message.title, null);
  assert.equal(r.message.url, null);
  assert.deepEqual(r.links, [], 'text messages are not scanned for URLs');
  assert.equal(r.message.quote_msg_id, '7468288782843');
  assert.equal(r.message.quote_text, null, 'a quoted link/photo has an empty msg, so there is no quote text');
});

test('text: personal data is kept verbatim in the database (masking happens at export)', () => {
  const r = normalizeMessage(rawMsg({ message: 'Liên hệ 0900 000 000 hoặc ten@example.com' }), { convId: CONV });
  assert.equal(r.message.text, 'Liên hệ 0900 000 000 hoặc ten@example.com');
});

// ---------------------------------------------------------------------------------------------------------------------
// photo (2)
// ---------------------------------------------------------------------------------------------------------------------

test('photo with caption and cached file: caption is text and images.caption, size, hd url, cache path as-is', () => {
  const raw = load('photo-caption-cached');
  const r = normalizeMessage(raw, { convId: CONV });
  const caption = 'Solar và EV sẽ phát triển cùng xu hướng giảm giá bess';

  assert.equal(r.message.kind, 'photo');
  assert.equal(r.message.text, caption);
  assert.equal(r.message.url, raw.message.hdUrl);
  assert.equal(r.images.length, 1);
  assert.deepEqual(r.images[0], {
    msg_id: '6410886785343',
    conv_id: CONV,
    ts: 1742082425161,
    sender_name: 'Người E',
    caption,
    width: 720,
    height: 901,
    remote_url: raw.message.hdUrl,
    cache_path: raw.localPath,
  });
  assert.match(raw.localPath, /ZaloPC.*ZaloDownloads.*\.jxl$/, 'cache_path is the raw localPath, remapping is a later task');
  assert.equal(r.links.length + r.files.length + r.memberEvents.length, 0);
});

test('photo without caption: caption and text are null, width/height are numbers, no cache path', () => {
  const r = norm('photo-no-caption');
  assert.equal(r.message.text, null);
  assert.equal(r.images[0].caption, null);
  assert.equal(r.images[0].width, 1512);
  assert.equal(r.images[0].height, 2016);
  assert.equal(r.images[0].cache_path, null);
  assert.match(r.images[0].remote_url, /^https:\/\/photo-stal-20\.zdn\.vn\//);
});

test('photo without hdUrl falls back to oriUrl', () => {
  const raw = load('photo-no-hd-url');
  assert.equal(raw.message.hdUrl, undefined);
  const r = normalizeMessage(raw, { convId: CONV });
  assert.equal(r.images[0].remote_url, raw.message.oriUrl);
  assert.equal(r.images[0].width, 651);
  assert.equal(r.images[0].height, 975);
});

test('photo remote_url order is hdUrl, oriUrl, normalUrl, href; size falls back to the raw width/height', () => {
  const photo = body => normalizeMessage(rawMsg({ msgType: 2, message: body, width: 40, height: 30 }), { convId: CONV }).images[0];
  assert.equal(photo({ hdUrl: 'h', oriUrl: 'o', normalUrl: 'n', href: 'x' }).remote_url, 'h');
  assert.equal(photo({ oriUrl: 'o', normalUrl: 'n', href: 'x' }).remote_url, 'o');
  assert.equal(photo({ normalUrl: 'n', href: 'x' }).remote_url, 'n');
  assert.equal(photo({ href: 'x' }).remote_url, 'x');
  assert.equal(photo({}).remote_url, null);
  assert.equal(photo({ params: '{"width":"640","height":480}' }).width, 640, 'numeric strings become numbers');
  assert.equal(photo({}).width, 40);
  assert.equal(photo({}).height, 30);
});

test('photo/file/link rows leave the fields owned by later tasks out entirely, so a re-sync cannot reset them', () => {
  const img = norm('photo-caption-cached').images[0];
  for (const key of ['status', 'stored_path', 'shape_class', 'ocr_text', 'has_text', 'scanned_at', 'text_score']) {
    assert.equal(key in img, false, `images.${key} must be omitted`);
  }
  const file = norm('file-cached').files[0];
  for (const key of ['status', 'stored_path', 'error']) assert.equal(key in file, false, `files.${key} must be omitted`);
});

// ---------------------------------------------------------------------------------------------------------------------
// link (6)
// ---------------------------------------------------------------------------------------------------------------------

test('link: the sender text (title + URL) is text, preview title comes from params.mediaTitle', () => {
  const raw = load('link-text-and-url');
  const r = normalizeMessage(raw, { convId: CONV });
  const previewTitle = 'Xe xăng hồi sinh rực rỡ: Cuộc tháo chạy hàng loạt của các đại gia ô tô khỏi giấc...';
  const previewDescription = 'Hết thời "đốt tiền" cho xe điện: Vì sao xe xăng vẫn là "chân ái" của người tiêu dùng thực dụng?';

  assert.equal(r.message.kind, 'link');
  assert.equal(r.message.text, raw.message.title);
  assert.match(r.message.text, /^Chi tiết: https:\/\/cafebiz\.vn\//);
  assert.equal(r.message.url, raw.message.href);
  assert.equal(r.message.title, previewTitle);
  assert.equal(r.message.description, previewDescription);
  assert.deepEqual(r.links, [{
    msg_id: '7557079303708',
    conv_id: CONV,
    ts: 1771846272253,
    url: raw.message.href,
    domain: 'cafebiz.vn',
    title: previewTitle,
    description: previewDescription,
  }]);
  assert.equal(r.files.length + r.images.length + r.memberEvents.length, 0);
});

test('link: domain drops a leading www.', () => {
  const r = norm('link-www-host');
  assert.match(r.links[0].url, /^https:\/\/www\.businesstimes\.com\.sg\//);
  assert.equal(r.links[0].domain, 'businesstimes.com.sg');
  assert.equal(r.links[0].title, 'Vietnam’s data-centre investment rush faces reality check on power and site…');
  assert.match(r.message.text, /^The Business Times \(Singapore\) ngày 28\/9 có bài phân tích/);
});

test('link posted as a bare URL: text is that URL', () => {
  const raw = load('link-bare-url');
  const r = normalizeMessage(raw, { convId: CONV });
  assert.equal(raw.message.title, raw.message.href);
  assert.equal(r.message.text, raw.message.href);
  assert.equal(r.links[0].domain, 'baodautu.vn');
  assert.equal(r.links[0].title, 'Stavian nghiên cứu đầu tư khu công nghệ số 300 ha tại TP.HCM');
});

test('link without sender text: text is null but the preview is still stored', () => {
  const r = norm('link-no-text');
  assert.equal(r.message.text, null);
  assert.equal(r.message.title, 'Asean’s energy transition must move from ambition to delivery');
  assert.match(r.message.description, /^The region needs a practical stocktake/);
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].domain, 'businesstimes.com.sg');
});

test('msgType 6 that is a shared contact, not a link: kind other, no links row, no description kept', () => {
  const r = norm('link-contact-card');
  assert.equal(r.message.msg_type, '6');
  assert.equal(r.message.kind, 'other');
  assert.deepEqual(rowCounts(r), NO_ROWS);
  assert.equal(r.message.url, null);
  assert.equal(r.message.description, null);
  assert.ok(JSON.parse(r.message.raw_json).message.action === 'recommened.user', 'raw_json still has everything');
});

test('link whose message body arrives as a JSON string, with params as an object', () => {
  const body = { title: 'Đọc: https://www.example.org/a/b?x=1', description: 'D', href: 'https://www.example.org/a/b?x=1', params: { mediaTitle: 'T' } };
  const r = normalizeMessage(rawMsg({ msgType: 6, message: JSON.stringify(body) }), { convId: CONV });
  assert.equal(r.message.kind, 'link');
  assert.equal(r.message.text, body.title);
  assert.deepEqual(r.links[0], {
    msg_id: '1000', conv_id: CONV, ts: 1700000000000, url: body.href, domain: 'example.org', title: 'T', description: 'D',
  });
});

test('link with no preview title in params: title is null, never the sender text', () => {
  const r = normalizeMessage(rawMsg({ msgType: 6, message: { title: 'see this', href: 'https://example.org/x', params: '{}' } }), { convId: CONV });
  assert.equal(r.links[0].title, null);
  assert.equal(r.message.title, null);
  assert.equal(r.message.text, 'see this');
});

// ---------------------------------------------------------------------------------------------------------------------
// file (19)
// ---------------------------------------------------------------------------------------------------------------------

test('file: file_name, ext, size (Number), checksum, remote_url; text stays null', () => {
  const raw = load('file-cached');
  const r = normalizeMessage(raw, { convId: CONV });
  assert.equal(r.message.kind, 'file');
  assert.equal(r.message.text, null);
  assert.equal(r.message.title, 'TOU-Analysis_SolarBESS_Final-REVISED_VIE.pdf', 'the name is searchable through messages_fts.title');
  assert.equal(r.message.url, raw.message.href);
  assert.deepEqual(r.files, [{
    msg_id: '7802614660994',
    conv_id: CONV,
    ts: 1778204058817,
    sender_name: 'Người E',
    file_name: 'TOU-Analysis_SolarBESS_Final-REVISED_VIE.pdf',
    ext: 'pdf',
    size: 4328543,
    checksum: 'e63eb2d93995adaebbb1b378a4566040',
    remote_url: raw.message.href,
  }]);
  assert.equal(typeof r.files[0].size, 'number');
  assert.equal(r.links.length + r.images.length + r.memberEvents.length, 0);
});

test('file whose params have padded JSON and a null checksumSha', () => {
  const r = norm('file-remote');
  assert.equal(r.files[0].file_name, '1-BC-BCT-2026-760.pdf');
  assert.equal(r.files[0].size, 3879483);
  assert.equal(r.files[0].checksum, 'e123db6f49b527822b2c74f0dafe1373');
});

test('file edge cases: "null" checksum, ext from the name when fileExt is missing, uppercase ext, numeric size, body as JSON string', () => {
  const file = (body, over = {}) => normalizeMessage(rawMsg({ msgType: 19, message: body, ...over }), { convId: CONV }).files[0];

  assert.equal(file({ title: 'a.PDF', href: 'u', params: '{"fileSize":12,"checksum":"null","fileExt":"PDF"}' }).checksum, null);
  assert.equal(file({ title: 'a.PDF', href: 'u', params: '{"fileSize":12,"checksum":"null","fileExt":"PDF"}' }).ext, 'pdf');
  assert.equal(file({ title: 'a.PDF', href: 'u', params: '{"fileSize":12}' }).size, 12);
  assert.equal(file({ title: 'Báo cáo.v2.XLSX', href: 'u', params: '{}' }).ext, 'xlsx');
  assert.equal(file({ title: 'README', href: 'u', params: '{}' }).ext, null);
  assert.equal(file({ title: 'a.pdf', href: 'u', params: '{"checksum":""}' }).checksum, null);
  assert.equal(file({ title: 'a.pdf', href: 'u', params: '{}' }).size, null);
  assert.equal(file({ title: 'a.pdf', href: 'u', params: '{}' }, { fileSize: '77' }).size, 77, 'raw fileSize is the fallback');

  const asString = file(JSON.stringify({ title: 'b.docx', href: 'https://f/x', params: JSON.stringify({ fileSize: '5', checksum: 'abc', fileExt: 'docx' }) }));
  assert.deepEqual([asString.file_name, asString.ext, asString.size, asString.checksum, asString.remote_url], ['b.docx', 'docx', 5, 'abc', 'https://f/x']);
});

// ---------------------------------------------------------------------------------------------------------------------
// member events (-4)
// ---------------------------------------------------------------------------------------------------------------------

test('member event "<X> được <Y> thêm vào cộng đồng" is added, with who and by whom', () => {
  const r = norm('member-added');
  assert.equal(r.message.kind, 'member_event');
  assert.equal(r.message.msg_id, '8304300074036_001', 'suffix kept as-is');
  assert.equal(r.message.from_uid, null);
  assert.equal(r.message.sender_name, null);
  assert.equal(r.message.text, 'Người H được Người D thêm vào cộng đồng');
  assert.deepEqual(r.memberEvents, [{
    msg_id: '8304300074036_001',
    conv_id: CONV,
    ts: 1790345107229,
    event: 'added',
    member_uids_json: '["4168407517877453350"]',
    member_name: 'Người H',
    actor_name: 'Người D',
    text: 'Người H được Người D thêm vào cộng đồng',
  }]);
  assert.equal(r.links.length + r.files.length + r.images.length, 0);
});

test('member event "<X> đã tham gia cộng đồng" is joined, with no actor', () => {
  const [e] = norm('member-joined').memberEvents;
  assert.equal(e.event, 'joined');
  assert.equal(e.member_name, 'Người K');
  assert.equal(e.actor_name, null);
  assert.equal(e.member_uids_json, '["1258063758797981322"]');
});

test('member event with a double space before "xóa khỏi" is removed, names are trimmed', () => {
  const raw = load('member-removed');
  assert.match(raw.message, /Người D {2}xóa khỏi/, 'fixture keeps the real double space');
  const r = normalizeMessage(raw, { convId: CONV });
  const [e] = r.memberEvents;
  assert.equal(e.event, 'removed');
  assert.equal(e.member_name, 'Người L');
  assert.equal(e.actor_name, 'Người D');
  assert.equal(e.text, raw.message, 'text is stored as Zalo sent it');
});

test('member event "được bổ nhiệm thành phó" is promoted', () => {
  const [e] = norm('member-promoted').memberEvents;
  assert.equal(e.event, 'promoted');
  assert.equal(e.member_name, 'Người M');
  assert.equal(e.actor_name, null);
});

test('"Bạn vừa tham gia cộng đồng" is joined and the msgId keeps its leading dot', () => {
  const r = norm('member-you-joined');
  assert.equal(r.message.msg_id, '.1740466250031_001');
  assert.equal(r.memberEvents[0].event, 'joined');
  assert.equal(r.memberEvents[0].member_name, 'Bạn');
  assert.equal(r.memberEvents[0].member_uids_json, '["1498602681856850483"]');
});

test('a group-setting notice that mentions trưởng/phó is other, not promoted', () => {
  const [e] = norm('member-setting').memberEvents;
  assert.equal(e.event, 'other');
  assert.equal(e.member_name, null);
  assert.equal(e.actor_name, null);
  assert.equal(e.member_uids_json, null);
  assert.match(e.text, /xem đầy đủ danh sách thành viên/);
});

test('member event parsing: several people, "bị", nhóm instead of cộng đồng, a name containing "Được"', () => {
  const ev = (message, ids) => normalizeMessage(rawMsg({ msgId: '9_001', msgType: -4, fromUid: null, dName: '', message, updateMemberIds: ids }), { convId: CONV }).memberEvents[0];

  assert.deepEqual(
    (({ event, member_name, actor_name, member_uids_json }) => ({ event, member_name, actor_name, member_uids_json }))(
      ev('An, Bình được Châu thêm vào nhóm', ['1', '2'])),
    { event: 'added', member_name: 'An, Bình', actor_name: 'Châu', member_uids_json: '["1","2"]' });
  assert.deepEqual(
    (({ event, member_name, actor_name }) => ({ event, member_name, actor_name }))(ev('An bị Châu xóa khỏi nhóm', ['1'])),
    { event: 'removed', member_name: 'An', actor_name: 'Châu' });
  assert.deepEqual(
    (({ event, member_name, actor_name }) => ({ event, member_name, actor_name }))(ev('Nguyễn Văn Được được Trần An thêm vào nhóm', ['1'])),
    { event: 'added', member_name: 'Nguyễn Văn Được', actor_name: 'Trần An' });
  assert.equal(ev('An đã tham gia nhóm', [1234567]).member_uids_json, '["1234567"]', 'member ids are always stored as strings');
});

// ---------------------------------------------------------------------------------------------------------------------
// recalled (20), deleted (-27), sticker (4), video (18), anything else
// ---------------------------------------------------------------------------------------------------------------------

test('recalled and deleted keep their kind but have no text, and the placeholder stays in raw_json', () => {
  for (const [name, kind, placeholder] of [
    ['recalled', 'recalled', '[Tin nhắn đã được thu hồi]'],
    ['deleted', 'deleted', '[Tin nhắn đã bị xóa]'],
  ]) {
    const r = norm(name);
    assert.equal(r.message.kind, kind);
    assert.equal(r.message.text, null, `${kind}: content is gone`);
    assert.equal(JSON.parse(r.message.raw_json).message, placeholder);
    assert.deepEqual(rowCounts(r), NO_ROWS);
  }
  assert.equal(norm('recalled').message.msg_type, '20');
  assert.equal(norm('deleted').message.msg_type, '-27');
});

test('recalled/deleted whose message is an object still end up with null text', () => {
  assert.equal(norm('recalled-object').message.text, null);
  const deletedImage = norm('deleted-image');
  assert.equal(deletedImage.message.kind, 'deleted');
  assert.equal(deletedImage.message.text, null);
  assert.deepEqual(rowCounts(deletedImage), NO_ROWS);
});

test('sticker and video: minimal row, no text, no side rows, raw_json keeps the details', () => {
  const sticker = norm('sticker');
  assert.equal(sticker.message.kind, 'sticker');
  assert.equal(sticker.message.text, null);
  assert.deepEqual(rowCounts(sticker), NO_ROWS);
  assert.deepEqual(JSON.parse(sticker.message.raw_json).message, { id: 17874, catId: 10123, type: 3 });

  const video = norm('video');
  assert.equal(video.message.kind, 'video');
  assert.equal(video.message.msg_type, '18');
  assert.equal(video.message.text, null);
  assert.deepEqual(rowCounts(video), NO_ROWS);
  assert.equal(JSON.parse(video.message.raw_json).message.duration, 34000);
});

test('unknown msgType is other: the notice text is kept for search and raw_json has everything', () => {
  const r = norm('system-notice');
  assert.equal(r.message.kind, 'other');
  assert.equal(r.message.msg_type, '-1909');
  assert.equal(r.message.text, 'Người D cho phép tất cả thành viên được gửi tin nhắn vào cộng đồng.');
  assert.equal(JSON.parse(r.message.raw_json).message.action, 'msginfo.actionlist');
  assert.deepEqual(rowCounts(r), NO_ROWS);

  const mystery = normalizeMessage(rawMsg({ msgType: 9999, message: { weird: true } }), { convId: CONV });
  assert.equal(mystery.message.kind, 'other');
  assert.equal(mystery.message.text, null);
  assert.deepEqual(JSON.parse(mystery.message.raw_json).message, { weird: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// raw_json
// ---------------------------------------------------------------------------------------------------------------------

test('raw_json drops null/empty fields at every depth and keeps 0 and false', () => {
  const raw = rawMsg({
    quote: null,
    mentions: [],
    localPath: '',
    properties: { color: 0, flag: false, nothing: null, blank: '', list: [], obj: {}, deep: { x: null, y: '' } },
    list: [null, 'keep', '', 0, {}],
    zero: 0,
    off: false,
  });
  const parsed = JSON.parse(normalizeMessage(raw, { convId: CONV }).message.raw_json);
  assert.deepEqual(parsed, {
    msgId: '1000', cliMsgId: '2000', msgType: 1, sendDttm: '1700000000000', fromUid: '3000', dName: 'Người X', message: 'xin chào',
    properties: { color: 0, flag: false },
    list: ['keep', 0],
    zero: 0,
    off: false,
  });
});

test('raw_json of a real photo keeps the urls and params that were not empty', () => {
  const parsed = JSON.parse(norm('photo-caption-cached').message.raw_json);
  assert.equal(parsed.message.hdUrl, load('photo-caption-cached').message.hdUrl);
  assert.equal('folderPath' in parsed, false);
  assert.equal('description' in parsed.message, false, 'empty description dropped');
  assert.equal(parsed.localPath, load('photo-caption-cached').localPath);
});

// ---------------------------------------------------------------------------------------------------------------------
// classifyMemberEvent
// ---------------------------------------------------------------------------------------------------------------------

test('classifyMemberEvent covers the Vietnamese patterns, nhóm and cộng đồng, removed before added', () => {
  const cases = [
    ['Mark đã tham gia cộng đồng', 'joined'],
    ['Mark đã tham gia nhóm', 'joined'],
    ['Bạn vừa tham gia cộng đồng', 'joined'],
    ['Mark được Phu thêm vào cộng đồng', 'added'],
    ['Mark được Phu thêm vào nhóm', 'added'],
    ['Mark được Phu xóa khỏi cộng đồng', 'removed'],
    ['Mark được Phu  xóa khỏi nhóm', 'removed'],
    ['Mark bị Phu xóa khỏi nhóm', 'removed'],
    ['Mark bị Phu xoá khỏi nhóm', 'removed'],
    ['Mark đã được bổ nhiệm thành phó cộng đồng', 'promoted'],
    ['Mark đã được bổ nhiệm làm trưởng nhóm', 'promoted'],
    ['Phu chỉ cho phép trưởng/phó cộng đồng xem đầy đủ danh sách thành viên.', 'other'],
    ['Phu cho phép tất cả thành viên được gửi tin nhắn vào cộng đồng.', 'other'],
    ['Mark đã rời nhóm', 'other'],
    ['', 'other'],
    [null, 'other'],
    [undefined, 'other'],
    [{ not: 'text' }, 'other'],
  ];
  for (const [text, expected] of cases) assert.equal(classifyMemberEvent(text), expected, JSON.stringify(text));
});

test('classifyMemberEvent is not fooled by decomposed (NFD) Vietnamese', () => {
  assert.equal(classifyMemberEvent('Mark được Phu thêm vào cộng đồng'.normalize('NFD')), 'added');
  assert.equal(classifyMemberEvent('Mark đã tham gia cộng đồng'.normalize('NFD')), 'joined');
  assert.equal(classifyMemberEvent('Mark bị Phu xóa khỏi nhóm'.normalize('NFD')), 'removed');
});

// ---------------------------------------------------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------------------------------------------------

test('bad input throws a clear TypeError instead of producing a half-empty row', () => {
  assert.throws(() => normalizeMessage(rawMsg()), /convId/, 'convId is required');
  assert.throws(() => normalizeMessage(rawMsg(), { convId: '' }), /convId/);
  assert.throws(() => normalizeMessage(rawMsg(), { convId: 123 }), /convId/, 'a number would lose digits');
  assert.throws(() => normalizeMessage(rawMsg({ msgId: undefined }), { convId: CONV }), /msgId/);
  assert.throws(() => normalizeMessage(rawMsg({ msgId: '' }), { convId: CONV }), /msgId/);
  assert.throws(() => normalizeMessage(rawMsg({ sendDttm: 'soon' }), { convId: CONV }), /sendDttm/);
  assert.throws(() => normalizeMessage(rawMsg({ sendDttm: undefined }), { convId: CONV }), /sendDttm/);
  assert.throws(() => normalizeMessage(null, { convId: CONV }), TypeError);
  assert.throws(() => normalizeMessage('text', { convId: CONV }), TypeError);
});

test('sendDttm may be a string or a number; ids given as numbers are converted to strings', () => {
  assert.equal(normalizeMessage(rawMsg({ sendDttm: 1700000000123 }), { convId: CONV }).message.ts, 1700000000123);
  const m = normalizeMessage(rawMsg({ msgId: 8384820492222, cliMsgId: 1792226009873 }), { convId: CONV }).message;
  assert.equal(m.msg_id, '8384820492222');
  assert.equal(m.cli_msg_id, '1792226009873');
});

test('missing optional raw fields give nulls, never "undefined" or "null" strings', () => {
  const m = normalizeMessage({ msgId: '5', msgType: 1, sendDttm: '10' }, { convId: CONV }).message;
  assert.equal(m.cli_msg_id, null);
  assert.equal(m.from_uid, null);
  assert.equal(m.sender_name, null);
  assert.equal(m.text, null);
  assert.equal(m.mentions_json, null);
  assert.equal(m.quote_msg_id, null);
});

// ---------------------------------------------------------------------------------------------------------------------
// contract with lib/db.mjs (Task 2)
// ---------------------------------------------------------------------------------------------------------------------

/** Writes one normalized message the way the sync will: inside a transaction, returning each upsert result. */
function ingest(db, result) {
  return db.transaction(() => ({
    message: db.upsertMessage(result.message),
    links: result.links.map(l => db.upsertLink(l)),
    files: result.files.map(f => db.upsertFile(f)),
    images: result.images.map(i => db.upsertImage(i)),
    memberEvents: result.memberEvents.map(e => db.upsertMemberEvent(e)),
  }));
}

test('every normalized fixture upserts into the real db, a second pass changes nothing, and counts add up', () => {
  const db = openDb(':memory:');
  const results = fixtureNames.map(n => norm(n));
  for (const r of results) ingest(db, r);

  const count = t => db.raw.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n;
  const sum = k => results.reduce((n, r) => n + r[k].length, 0);
  assert.equal(count('messages'), fixtureNames.length);
  assert.equal(count('links'), sum('links'));
  assert.equal(count('files'), sum('files'));
  assert.equal(count('images'), sum('images'));
  assert.equal(count('member_events'), sum('memberEvents'));
  assert.deepEqual([count('links'), count('files'), count('images'), count('member_events')], [4, 2, 3, 6]);

  for (const r of results) {
    const again = ingest(db, r);
    assert.equal(again.message.changed, false, `${r.message.msg_id} message re-upsert`);
    for (const k of ['links', 'files', 'images', 'memberEvents']) for (const x of again[k]) assert.equal(x.changed, false);
  }
  assert.equal(count('messages'), fixtureNames.length);

  const row = db.raw.prepare('SELECT msg_type, kind, ts FROM messages WHERE msg_id = ?').get('6410886785343');
  assert.deepEqual({ ...row }, { msg_type: '2', kind: 'photo', ts: 1742082425161 });
  db.close();
});

test('full-text search finds what the sender wrote, the link preview and the file name', () => {
  const db = openDb(':memory:');
  for (const n of fixtureNames) ingest(db, norm(n));
  const ids = q => db.search(q).map(r => r.msg_id);

  assert.deepEqual(ids('cafebiz'), ['7557079303708'], 'sender text of a link message');
  assert.ok(ids('tháo chạy').includes('7557079303708'), 'preview title');
  assert.deepEqual(ids('giảm giá bess'), ['6410886785343'], 'photo caption');
  assert.deepEqual(ids('TOU-Analysis'), ['7802614660994'], 'file name');
  assert.ok(!ids('thu hồi').length, 'recalled placeholder is not searchable');
  db.close();
});

test('a later task filling status/stored_path survives a re-sync of the same message', () => {
  const db = openDb(':memory:');
  ingest(db, norm('file-cached'));
  ingest(db, norm('photo-caption-cached'));
  db.upsertFile({ msg_id: '7802614660994', status: 'stored', stored_path: 'data/files/x.pdf' });
  db.upsertImage({ msg_id: '6410886785343', status: 'ok', stored_path: 'data/images/x.jpg', has_text: 1, ocr_text: 'chữ trong ảnh', shape_class: 'photo' });

  ingest(db, norm('file-cached'));
  ingest(db, norm('photo-caption-cached'));

  const f = db.raw.prepare('SELECT status, stored_path, file_name FROM files').get();
  assert.deepEqual({ ...f }, { status: 'stored', stored_path: 'data/files/x.pdf', file_name: 'TOU-Analysis_SolarBESS_Final-REVISED_VIE.pdf' });
  const i = db.raw.prepare('SELECT status, stored_path, has_text, ocr_text, shape_class, caption FROM images').get();
  assert.deepEqual({ ...i }, {
    status: 'ok', stored_path: 'data/images/x.jpg', has_text: 1, ocr_text: 'chữ trong ảnh', shape_class: 'photo',
    caption: 'Solar và EV sẽ phát triển cùng xu hướng giảm giá bess',
  });
  db.close();
});
