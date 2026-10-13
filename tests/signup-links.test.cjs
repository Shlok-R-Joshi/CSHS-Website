const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'js/signup-links.js'), 'utf8');
const endpoint = 'https://script.google.com/a/macros/henricostudents.org/s/test/exec';

function links(search = '', config = {}) {
  const elements = {
    'csw-open-form': { href: 'safe-fallback' },
    'tutoring-open': { href: 'safe-fallback' },
    'tutoring-notice': { hidden: true }
  };
  vm.runInNewContext(script, {
    window: { CSW_BOOKING: { webAppUrl: endpoint, tutoringEnabled: true, ...config } },
    document: { getElementById: id => elements[id] },
    location: { search }, URL, URLSearchParams
  });
  return elements;
}

test('signup links preserve selected dates and organizer entry without embedding or auto-opening', () => {
  const result = links('?date=2026-10-21&manage=1&embedId=old');
  const url = new URL(result['csw-open-form'].href);
  assert.equal(url.searchParams.get('date'), '2026-10-21');
  assert.equal(url.searchParams.get('manage'), '1');
  assert.equal(url.searchParams.has('embedId'), false);
  assert.match(result['csw-open-form'].textContent, /organizer/);
  assert.equal(result['tutoring-open'].href, endpoint + '?view=tutoring');
});

test('untrusted URLs and malformed date parameters cannot replace safe signup links', () => {
  assert.equal(links('', { webAppUrl: 'javascript:alert(1)' })['csw-open-form'].href, 'safe-fallback');
  assert.equal(links('?date=javascript:alert(1)')['csw-open-form'].href, endpoint);
  assert.equal(links('', { webAppUrl: 'https://evil.example/exec' })['tutoring-open'].href, 'safe-fallback');
});

test('disabled tutoring hides its signup link with a help message', () => {
  const result = links('', { tutoringEnabled: false });
  assert.equal(result['tutoring-open'].hidden, true);
  assert.equal(result['tutoring-notice'].hidden, false);
  assert.match(result['tutoring-notice'].textContent, /being set up/);
});

test('signup links work without JavaScript; CS Wednesday opens directly in the same tab', () => {
  for (const name of ['CSW', 'tutoring']) {
    const html = fs.readFileSync(path.join(root, 'html', name + '.html'), 'utf8');
    assert.match(html, /href="https:\/\/script\.google\.com[^" ]*"/);
    if (name === 'CSW') assert.doesNotMatch(html.match(/<a[^>]+id="csw-open-form"[^>]*>/)[0], /target=/);
    else assert.match(html, /target="_blank" rel="noopener"/);
    assert.doesNotMatch(html, /<iframe[^>]*(?:csw-booking|tutoring-frame)/s);
    assert.match(html, /signup-links\.js/);
  }
});

test('calendar fallback hides a blocked frame but recovers when the calendar answers', () => {
  const frame = { dataset: { view: 'calendar' }, style: {}, hidden: false };
  const notice = { hidden: false };
  const fallback = {};
  let onTimeout, onMessage;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'js/csw-booking-embed.js'), 'utf8'), {
    window: { CSW_BOOKING: { webAppUrl: endpoint }, addEventListener: (_, fn) => { onMessage = fn; } },
    document: { getElementById: id => ({ 'csw-booking': frame, 'csw-setup-notice': notice, 'csw-open-form': fallback })[id] },
    location: { search: '', origin: 'http://localhost' },
    crypto: { randomUUID: () => 'nonce' }, URLSearchParams,
    setTimeout: fn => { onTimeout = fn; }, clearTimeout() {}
  });
  onTimeout();
  assert.equal(frame.hidden, true);
  assert.match(notice.textContent, /sign in/);
  assert.equal(fallback.href, endpoint + '?view=calendar');
  onMessage({ origin: 'https://evil.example', data: { type: 'csw:resize', embedId: 'nonce', height: 800 } });
  assert.equal(frame.hidden, true);
  onMessage({ origin: 'https://test.googleusercontent.com', data: { type: 'csw:resize', embedId: 'nonce', height: 800 } });
  assert.equal(frame.hidden, false);
  assert.equal(notice.hidden, true);
});
