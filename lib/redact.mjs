// Personal-data redaction for exports (spec 6.7).
//
//   redact(text) -> text with phone numbers replaced by "[SĐT]" and e-mail addresses by "[email]"
//
// Pure, no dependencies. The database keeps the raw text; `zmi export` runs every piece of chat text (message text,
// link titles and descriptions) through this function so the report never carries personal phone numbers or e-mails.
//
// What counts as a phone number
// - Vietnamese mobile: 0 + 3/5/7/8/9 + 8 digits (10 digits), typed contiguous or grouped 4-3-3, 3-3-4 or 3-4-3 with
//   spaces, dots or hyphens (0963046382, 0963.046.382, 0963 046 382, 0963-046-382).
// - Vietnamese landline: 0 + 2x area code, 10-11 digits (028 3822 1234, 024.3825.1234, (028) 3822 1234, 0236 3822 345).
// - With country code: +84, (+84), 0084 in front of the number without its leading 0 (a stray 0 or "(0)" after the
//   code is tolerated), and "84" immediately followed by a contiguous mobile (84963046382).
// Chat phone numbers are mostly personal, so every one of these shapes goes.
//
// What must stay (the reason the patterns are strict)
// - Document codes, capacities, money, dates, times, percentages: nothing starts with 0 + [2-9] and has the right
//   group lengths, e.g. 1-BC-BCT-2026-760, 3.088 MW, 1.234.567.890 đồng, 22/10/2026, 09:30, 09.03.2026 15:30.
// - Service hotlines (1900 1234, 1800 5678): they start with 1, not 0 or +84, and are organisation numbers.
// - Longer digit runs (a 12-digit citizen id, a tax code with a "-001" branch suffix, a 19-digit Zalo id) are never cut
//   into a phone number: the match must not touch another digit, letter or "_" on either side.
// - URLs are left entirely untouched (a digit run inside a link path must not be cut).
//
// Known blind spot: a bare 10-digit tax code (mã số thuế) starting 03/05/07/08/09 has the exact shape of a mobile number
// and is redacted. Tax codes with a branch suffix ("0312345678-001") are not.

const PHONE_TOKEN = '[SĐT]';
const EMAIL_TOKEN = '[email]';

// ---------------------------------------------------------------------------------------------------------------------
// Phone pattern, assembled from group-length tables so the shapes stay readable
// ---------------------------------------------------------------------------------------------------------------------

const SEP = '[ \\u00a0.\\-]?'; // one optional space / non-breaking space / dot / hyphen between digit groups

/** `head` followed by each tail's digit groups (optional separator before every group), tails joined by `|`. */
const shapes = (head, tails) => tails.map(groups => head + groups.map(n => `${SEP}\\d{${n}}`).join('')).join('|');

const MOBILE = [
  shapes('0[35789]\\d\\d', [[3, 3]]), // 0963 046 382
  shapes('0[35789]\\d', [[3, 4], [4, 3]]), // 096 304 6382, 096 3046 382
].join('|');

const LANDLINE = [
  shapes('02\\d', [[4, 4], [3, 4], [4, 3]]), // 028 3822 1234 (11 digits), 024 3825 123 (10)
  shapes('02\\d\\d', [[3, 4], [4, 3]]), // 0236 382 2345, 0236 3822 345
  shapes('\\(02\\d\\)', [[4, 4], [3, 4], [4, 3]]), // (028) 3822 1234
  shapes('\\(02\\d\\d\\)', [[3, 4], [4, 3]]), // (0236) 3822 345
].join('|');

// After the country code: a mobile has 9 digits (963046382), a landline 10 (28 3822 1234). Any split into groups is
// accepted here because "+84" is already a strong signal.
const INTERNATIONAL = `(?:\\(\\+84\\)|\\+84|0084)${SEP}(?:(?:\\(0\\)|0)${SEP})?(?:[35789](?:${SEP}\\d){8}|2(?:${SEP}\\d){9})`;
const BARE_COUNTRY_CODE = '84(?:[35789]\\d{8}|2\\d{9})'; // contiguous only: "84.963.046.382" is an amount of money

const PHONE_RE = new RegExp(
  // Not glued to a letter, digit or "_" in front...
  '(?<![\\p{L}\\p{N}_])' +
    `(?:${INTERNATIONAL}|${BARE_COUNTRY_CODE}|${MOBILE}|${LANDLINE})` +
    // ...nor behind. Also not followed by ".", ",", "-" or "/" plus a digit (the number is the head of a longer grouped
    // number), unless that digit starts another phone number ("0963046382,0912345678", "0963046382/0912345678").
    '(?![\\p{L}\\p{N}_])(?![.,\\-/](?!0[235789]|84)\\d)',
  'gu',
);

// ---------------------------------------------------------------------------------------------------------------------
// E-mail and URL patterns
// ---------------------------------------------------------------------------------------------------------------------

// local@domain.tld. The lookbehind makes the engine start only at the beginning of a run of local-part characters, so
// a long token without "@" is scanned once, not once per character.
const EMAIL_RE = /(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}/gu;

// A link with a scheme or "www.", or a bare "domain.tld/path". Splitting on this (capturing) pattern puts the URLs at the
// odd indexes, which are copied through untouched.
const URL_RE = /((?:https?:\/\/|www\.)\S+|(?<![\p{L}\p{N}@._\-])(?:[a-z0-9\-]+\.)+[a-z]{2,}\/\S*)/giu;

const redactSegment = segment => segment.replace(EMAIL_RE, () => EMAIL_TOKEN).replace(PHONE_RE, () => PHONE_TOKEN);

/**
 * Replace phone numbers with "[SĐT]" and e-mail addresses with "[email]". URLs are left as they are.
 * `null` and `undefined` come back unchanged (so callers can pass nullable columns straight through); `''` stays `''`.
 * @param {string | null | undefined} text
 * @returns {string | null | undefined}
 * @throws {TypeError} when `text` is anything else than a string, null or undefined
 */
export function redact(text) {
  if (text === null || text === undefined) return text;
  if (typeof text !== 'string') throw new TypeError(`redact: text phải là chuỗi, null hoặc undefined (nhận được ${typeof text})`);
  if (text === '') return text;
  return text
    .split(URL_RE)
    .map((part, i) => (i % 2 === 1 ? part : redactSegment(part)))
    .join('');
}
