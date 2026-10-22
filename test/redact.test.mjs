import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../lib/redact.mjs';

const PHONE = '[SĐT]';
const EMAIL = '[email]';

// ---------------------------------------------------------------------------------------------------------------------
// Phone numbers that must go (spec 6.7)
// ---------------------------------------------------------------------------------------------------------------------

test('mobile numbers in the shapes people actually type', () => {
  for (const phone of [
    '0963046382', // contiguous
    '0963.046.382', // dots
    '0963 046 382', // spaces
    '0963-046-382', // hyphens
    '096 304 6382', // 3-3-4
    '096.3046.382', // 3-4-3
    '0963 046382', // 4-6
    '0963046 382', // sloppy grouping
    '0912345678',
    '0338123456',
    '0587654321',
    '0777 123 456',
    '0899.123.456',
  ]) {
    assert.equal(redact(phone), PHONE, phone);
    assert.equal(redact(`Liên hệ ${phone} nhé`), `Liên hệ ${PHONE} nhé`, phone);
  }
});

test('double spaces and a spaced hyphen between the groups', () => {
  for (const phone of ['0963  046  382', '0963 - 046 - 382', '096 - 304 - 6382', '+84  963  046  382', '+84 963 - 046 - 382', '028 - 3822 - 1234']) {
    assert.equal(redact(phone), PHONE, phone);
    assert.equal(redact(`ĐT: ${phone}.`), `ĐT: ${PHONE}.`, phone);
  }
  // digit groups separated like this that are not a phone shape stay
  for (const s of ['2026 - 2030 - 2045', '09:30 - 10:30', '05 - 03 - 2026', '10.5 - 20.5 - 30.5']) {
    assert.equal(redact(s), s, s);
  }
});

test('numbers with the country code', () => {
  for (const phone of [
    '+84 963 046 382',
    '+84963046382',
    '+84.963.046.382',
    '+84-963-046-382',
    '+84 96 304 6382',
    '+84 963046382',
    '+84 0963 046 382', // people keep the trunk 0
    '+84 (0) 963 046 382',
    '(+84) 963 046 382',
    '(+84) 963.046.382',
    '0084 963 046 382',
    '0084963046382',
    '84963046382', // country code without the plus, contiguous
    '+84 28 3822 1234', // landline with country code
    '+84 236 3822 345',
  ]) {
    assert.equal(redact(phone), PHONE, phone);
    assert.equal(redact(`ĐT: ${phone}.`), `ĐT: ${PHONE}.`, phone);
  }
});

test('Vietnamese landlines (0 + 2x area code, 10-11 digits)', () => {
  for (const phone of [
    '028 3822 1234',
    '024.3825.1234',
    '028-3822-1234',
    '02838221234',
    '(028) 3822 1234',
    '(024) 3825.1234',
    '0236 3822 345',
    '0236 382 2345',
    '0236 3822345',
    '024 3825 123', // old 10-digit form
  ]) {
    assert.equal(redact(phone), PHONE, phone);
  }
});

test('phone numbers inside real sentences', () => {
  assert.equal(redact('SĐT:0963046382'), `SĐT:${PHONE}`);
  assert.equal(redact('Zalo/Tel: 0963.046.382, anh Nam'), `Zalo/Tel: ${PHONE}, anh Nam`);
  assert.equal(redact('(0963 046 382)'), `(${PHONE})`);
  assert.equal(redact('liên hệ chị Duyên 0963 046 382.'), `liên hệ chị Duyên ${PHONE}.`);
  assert.equal(redact('"0963046382"'), `"${PHONE}"`);
  assert.equal(redact('gọi 0963046382!'), `gọi ${PHONE}!`);
  assert.equal(redact('Mr Nam\n0963046382\nMs Lan\n0912 345 678'), `Mr Nam\n${PHONE}\nMs Lan\n${PHONE}`);
  assert.equal(redact('Hotline +84 963 046 382 hoặc 028 3822 1234'), `Hotline ${PHONE} hoặc ${PHONE}`);
});

test('several numbers next to each other, with or without a space', () => {
  assert.equal(redact('0963046382, 0912345678'), `${PHONE}, ${PHONE}`);
  assert.equal(redact('0963046382,0912345678'), `${PHONE},${PHONE}`);
  assert.equal(redact('0963046382/0912345678'), `${PHONE}/${PHONE}`);
  assert.equal(redact('0963046382 - 0912345678'), `${PHONE} - ${PHONE}`);
  assert.equal(redact('0963046382 0912345678'), `${PHONE} ${PHONE}`);
  assert.equal(redact('0963046382 hoặc 0912345678 hoặc +84 988 123 456'), `${PHONE} hoặc ${PHONE} hoặc ${PHONE}`);
});

test('a phone number in the middle of a number list does not eat its neighbours', () => {
  assert.equal(redact('Số 12 gọi 0963046382 lúc 09:30 ngày 22/10/2026'), `Số 12 gọi ${PHONE} lúc 09:30 ngày 22/10/2026`);
  assert.equal(redact('2026 0963 046 382'), `2026 ${PHONE}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Emails that must go
// ---------------------------------------------------------------------------------------------------------------------

test('emails', () => {
  assert.equal(redact('thuduyen.vcci@gmail.com'), EMAIL);
  assert.equal(redact('Email: thuduyen.vcci@gmail.com.'), `Email: ${EMAIL}.`);
  assert.equal(redact('Email:abc@x.vn,xyz@y.com'), `Email:${EMAIL},${EMAIL}`);
  assert.equal(redact('gửi về Nam.Tran+mi@Sub.Company-Name.com.vn nhé'), `gửi về ${EMAIL} nhé`);
  assert.equal(redact('<info@evn.com.vn>'), `<${EMAIL}>`);
  assert.equal(redact('(a_b-c@d.org)'), `(${EMAIL})`);
  assert.equal(redact('0963046382@gmail.com'), EMAIL, 'a phone number used as the local part is an email, not a phone');
  assert.equal(redact('abc@gmail.com 0963046382'), `${EMAIL} ${PHONE}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Things that must stay exactly as written
// ---------------------------------------------------------------------------------------------------------------------

test('document codes, capacities and plain numbers are untouched', () => {
  for (const s of [
    '1-BC-BCT-2026-760',
    '3.088 MW',
    '2026',
    'TT 05/2025/TT-BCT',
    '10,7 GW',
    'Quyết định 1234/QĐ-BCT ngày 05/03/2026',
    'Nghị định 57/2025/NĐ-CP',
    'Công văn số 0123/BCT-ĐL',
    'công suất 1.234,5 MW, sản lượng 4.567 GWh',
    'QHĐ VIII: 30.000 MW điện gió ngoài khơi vào 2030',
    'Điều 5, khoản 2, điểm a',
    '03/2026 và 2026-2030',
  ]) {
    assert.equal(redact(s), s, s);
  }
});

test('money, quantities, dates, times and percentages are untouched', () => {
  for (const s of [
    '1.234.567.890 đồng',
    '500.000.000đ',
    '2.500 tỷ',
    '12.345.678.901 VND',
    '84.963.046.382 đồng', // looks like 84 + a mobile when the dots are read as separators
    '1,2 tỷ USD',
    '22/10/2026',
    '2026-10-22',
    '22.10.2026',
    '09.03.2026 15:30',
    '09:30',
    '9h30 ngày 05/10',
    '15,5%',
    '0,5 MW',
    '05 03 2026',
    '1.0 GW',
    '2025 - 2030',
  ]) {
    assert.equal(redact(s), s, s);
  }
});

test('service hotlines (start with 1, not 0 or +84) are organisation numbers and stay', () => {
  for (const s of ['1900 1234', '1800 5678', '1900545454', 'Tổng đài 1900 6666 hoặc 1800 1100']) {
    assert.equal(redact(s), s, s);
  }
});

test('longer digit runs are not cut into a phone number', () => {
  for (const s of [
    '1498602681856850483', // Zalo id
    '09630463821', // 11 digits starting 09
    '096304638212',
    '079123456789', // 12-digit citizen id
    '0312345678-001', // tax code with a branch suffix
    '10963046382',
    '0963.046.382.123',
    '12 0963046382123',
  ]) {
    assert.equal(redact(s), s, s);
  }
});

test('a phone number glued to letters is still a phone number', () => {
  for (const [input, expected] of [
    ['Zalo0963046382', `Zalo${PHONE}`],
    ['SĐT0963046382', `SĐT${PHONE}`],
    ['A0963046382', `A${PHONE}`],
    ['REF0912345678', `REF${PHONE}`],
    ['0963046382nhé', `${PHONE}nhé`],
    ['0963046382ạ', `${PHONE}ạ`],
    ['0963046382A', `${PHONE}A`],
    ['gọi0963 046 382ngay', `gọi${PHONE}ngay`],
  ]) {
    assert.equal(redact(input), expected, input);
  }
});

test('the money suffix đ and a glued underscore keep a digit run as it is', () => {
  for (const s of ['0963046382đ', '0963046382đồng', '0963046382Đ', 'mã_0963046382', '0963046382_x']) {
    assert.equal(redact(s), s, s);
  }
});

test('URLs are left alone, including long digit runs inside them', () => {
  for (const s of [
    'https://example.com/doc/0963046382123.pdf',
    'https://example.com/doc/0963046382.pdf',
    'xem http://x.vn/a?id=0912345678&b=2 nhé',
    'www.example.com/tin-tuc/0963046382',
    'example.com/files/0963046382.pdf',
    'https://zalo.me/g/abcxyz',
    'https://zalo.me/g/abcxyz?src=qr',
    'https://zalo.me/s/12345',
    'https://zalo.me/0963046382123', // longer than a phone: not cut
    'https://zalo.me/someshop',
    'https://wa.me/message/ABCDEF',
    'notzalo.me/0963046382', // a different domain
  ]) {
    assert.equal(redact(s), s, s);
  }
  assert.equal(redact('Xem https://example.com/a/0963046382123.pdf hoặc gọi 0963046382'), `Xem https://example.com/a/0963046382123.pdf hoặc gọi ${PHONE}`);
  assert.equal(redact('gọi 0963046382 rồi xem www.example.com/a/0912345678'), `gọi ${PHONE} rồi xem www.example.com/a/0912345678`);
});

test('zalo.me/<phone> and wa.me/<phone> links carry a personal number in the path', () => {
  for (const [input, expected] of [
    ['https://zalo.me/0963046382', `https://zalo.me/${PHONE}`],
    ['zalo.me/84963046382', `zalo.me/${PHONE}`],
    ['https://zalo.me/+84963046382', `https://zalo.me/${PHONE}`],
    ['https://zalo.me/02838221234', `https://zalo.me/${PHONE}`],
    ['https://zalo.me/0963046382?src=qr', `https://zalo.me/${PHONE}?src=qr`],
    ['https://wa.me/84963046382', `https://wa.me/${PHONE}`],
    ['https://wa.me/+84963046382?text=hi', `https://wa.me/${PHONE}?text=hi`],
    ['HTTPS://ZALO.ME/0963046382', `HTTPS://ZALO.ME/${PHONE}`],
    ['www.zalo.me/0963046382', `www.zalo.me/${PHONE}`],
    ['Kết bạn Zalo: https://zalo.me/0963046382 nhé', `Kết bạn Zalo: https://zalo.me/${PHONE} nhé`],
  ]) {
    assert.equal(redact(input), expected, input);
  }
});

test('an e-mail address inside a URL is redacted, the rest of the URL stays', () => {
  assert.equal(redact('https://example.com/?mail=a@b.com'), `https://example.com/?mail=${EMAIL}`);
  assert.equal(redact('xem https://example.com/form?to=nam.tran@evn.vn&x=1 nhé'), `xem https://example.com/form?to=${EMAIL}&x=1 nhé`);
  assert.equal(redact('mailto:nam.tran@evn.vn'), `mailto:${EMAIL}`);
});

test('retina asset names (logo@2x.png) are not e-mail addresses', () => {
  for (const s of ['https://cdn.example.com/img/logo@2x.png', 'logo@2x.png', 'icon@3x.JPG và bg@2x.webp', 'https://x.vn/a/b@2x.pdf?v=1']) {
    assert.equal(redact(s), s, s);
  }
  assert.equal(redact('gửi a@sub.png.com nhé'), `gửi ${EMAIL} nhé`);
});

test('text without any personal data comes back identical', () => {
  const s = 'Bộ Công Thương công bố dự thảo Thông tư 05/2025/TT-BCT; giá điện bình quân 2.204,07 đồng/kWh từ 10/05/2025. Xem thêm tại https://moit.gov.vn/tin/123456.';
  assert.equal(redact(s), s);
});

// ---------------------------------------------------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------------------------------------------------

test('null and undefined pass through, empty string stays empty', () => {
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(''), '');
});

test('any other non-string input is a programming error', () => {
  for (const bad of [0, 963046382, 42n, true, {}, [], ['0963046382'], () => 'x', Symbol('s')]) {
    assert.throws(() => redact(bad), TypeError, String(typeof bad));
  }
});

test('redacting twice gives the same result as redacting once', () => {
  const s = 'Liên hệ 0963 046 382, +84 988 123 456, thuduyen.vcci@gmail.com, 028 3822 1234, https://zalo.me/0912345678 hoặc https://example.com/0963046382123.pdf?to=a@b.vn';
  const once = redact(s);
  assert.equal(once, `Liên hệ ${PHONE}, ${PHONE}, ${EMAIL}, ${PHONE}, https://zalo.me/${PHONE} hoặc https://example.com/0963046382123.pdf?to=${EMAIL}`);
  assert.equal(redact(once), once);
});

test('replacement tokens are not treated as regex replacement patterns', () => {
  assert.equal(redact('$& 0963046382 $1'), `$& ${PHONE} $1`);
});

test('a long chat export is handled in linear time', () => {
  const line = 'Họp ngày 22/10/2026 lúc 09:30, công suất 3.088 MW, giá 1.234.567.890 đồng, TT 05/2025/TT-BCT. ';
  const big = line.repeat(20000) + 'Liên hệ 0963046382';
  const started = Date.now();
  const out = redact(big);
  assert.ok(out.endsWith(`Liên hệ ${PHONE}`));
  assert.ok(Date.now() - started < 5000, 'redact should stay fast on ~2 MB of text');
});

test('adversarial inputs do not blow up (no catastrophic backtracking)', () => {
  const N = 100000;
  for (const [name, input] of [
    ['run of "0 "', '0 '.repeat(N)],
    ['run of "x@"', 'x@'.repeat(N)],
    ['"x@" then a long dotted chain with no TLD', 'x@' + 'a.'.repeat(N)],
    ['long local part without "@"', 'a.'.repeat(N) + 'b'],
    ['long dotted host before "/"', 'aa.'.repeat(N)],
    ['one very long digit run', '09'.repeat(N)],
    ['phone-looking groups repeated', '0963 '.repeat(N)],
    ['+84 followed by many spaces', '+84' + ' '.repeat(N) + '963'],
    ['long hyphen/space separator mix', '0963' + ' - '.repeat(N)],
    ['zalo.me link with a very long path', 'https://zalo.me/' + '0'.repeat(N)],
  ]) {
    const started = Date.now();
    redact(input);
    assert.ok(Date.now() - started < 3000, `${name} took ${Date.now() - started} ms`);
  }
  // the pathological shapes still come back correct
  assert.equal(redact('x@' + 'a.'.repeat(1000)), 'x@' + 'a.'.repeat(1000));
  assert.equal(redact('0 '.repeat(1000) + '0963046382'), '0 '.repeat(1000) + PHONE);
});
