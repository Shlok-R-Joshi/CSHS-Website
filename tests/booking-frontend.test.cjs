const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const widget = fs
  .readFileSync(path.join(root, 'booking/Widget.html'), 'utf8')
  .match(/<script>([\s\S]*?)<\/script>/)[1];
const embed = fs.readFileSync(path.join(root, 'js/csw-booking-embed.js'), 'utf8');
const pause = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const noResponse = Symbol('no response');
const calendarScript = fs
  .readFileSync(path.join(root, 'booking/Calendar.html'), 'utf8')
  .match(/<script>([\s\S]*?)<\/script>/)[1];

function calendarApp(results) {
  const h = surface();
  h.context.Date = class extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-09-24T16:00:00Z']));
    }
  };
  let success, failure;
  const runner = {
    withSuccessHandler(fn) {
      success = fn;
      return runner;
    },
    withFailureHandler(fn) {
      failure = fn;
      return runner;
    },
    getClubCalendar() {
      const result = results.shift();
      if (result === noResponse) {
        h.lateSuccess = success;
        return;
      }
      if (result instanceof Error) failure(result);
      else success(result);
    }
  };
  h.context.google = {
    script: {
      run: runner,
      url: {
        getLocation(fn) {
          fn({ parameter: {} });
        }
      }
    }
  };
  vm.runInNewContext(calendarScript, h.context);
  return h;
}

const clubData = () => ({
  ...schedule(),
  meetings: [
    {
      date: '2026-09-29',
      title: 'CSHS',
      start: '2026-09-29T15:30:00Z',
      end: '2026-09-29T16:00:00Z',
      room: 'SC2',
      allDay: false
    }
  ]
});

test('calendar shows school meetings and CSW slots with their own details', () => {
  const h = calendarApp([clubData()]);
  const meeting = h
    .get('grid')
    .children.find((el) => el.attributes['aria-label']?.includes('September 29'));
  meeting.fire('click');
  assert(h.get('details').children.some((el) => el.textContent.includes('11:30 AM–12:00 PM')));
  const wednesday = h
    .get('grid')
    .children.find((el) => el.attributes['aria-label']?.includes('September 30'));
  wednesday.fire('click');
  assert(h.get('details').children.some((el) => el.textContent === 'Sign up for this Wednesday'));
  assert.equal(h.get('loading').hidden, true);
});

test('calendar refresh removes stale signup links after someone reserves a date', () => {
  const booked = clubData();
  booked.slots[0] = {
    ...booked.slots[0],
    status: 'booked',
    name: 'Student One & Student Two',
    topic: 'Robotics'
  };
  const h = calendarApp([clubData(), booked]);
  h.get('grid')
    .children.find((el) => el.attributes['aria-label']?.includes('September 30'))
    .fire('click');
  h.get('refresh').fire('click');
  assert(!h.get('details').children.some((el) => el.textContent === 'Sign up for this Wednesday'));
  assert(
    h
      .get('details')
      .children.some((el) => el.textContent.includes('Student One & Student Two\nRobotics'))
  );
});

test('calendar labels open slots and topics, leaving unused past days and closures blank', () => {
  const data = clubData();
  data.slots = [
    { date: '2026-09-02', status: 'past' },
    { date: '2026-09-09', status: 'past', name: 'Student One', topic: 'Robotics' },
    { date: '2026-09-16', status: 'closed' },
    { date: '2026-09-23', status: 'blocked' },
    { date: '2026-09-30', status: 'available' }
  ];
  const h = calendarApp([data]);
  const cells = h.get('grid').children;
  for (const day of [2, 16, 23]) {
    const cell = cells.find((el) => el.textContent === day);
    assert.equal(cell.children.length, 0);
    assert.equal(cell.events.click, undefined);
  }
  const past = cells.find((el) => el.textContent === 9);
  assert.match(past.attributes['aria-label'], /CS Wednesday · Robotics/);
  past.fire('click');
  assert(!h.get('details').children.some((el) => el.textContent.includes('Sign up')));
  assert(h.get('details').children.some((el) => el.textContent.includes('Student One\nRobotics')));
  const open = h.get('grid').children.find((el) => el.textContent === 30);
  assert.match(open.attributes['aria-label'], /CS Wednesday · Open Slot/);
});

test('calendar handles timeouts, ignores late replies, and recovers on refresh', () => {
  const h = calendarApp([noResponse, clubData()]);
  assert.equal(h.get('loading').hidden, false);
  h.fireTimers(60000);
  assert.match(h.get('status').textContent, /timed out/);
  h.lateSuccess(clubData());
  assert.equal(h.get('grid').children.length, 0);
  h.get('refresh').fire('click');
  assert(h.get('grid').children.length > 28);
  assert.equal(h.get('refresh').disabled, false);
});

test('calendar clears old availability during a failed refresh', () => {
  const h = calendarApp([clubData(), new Error('School calendar unavailable')]);
  h.get('refresh').fire('click');
  assert.match(h.get('status').textContent, /School calendar unavailable/);
  assert.equal(h.get('grid').children.length, 0);
  assert.equal(h.get('next').disabled, true);
});

test('calendar links use the local signup page only for trusted messages', () => {
  const h = surface(),
    events = {};
  h.get('csw-booking').dataset.view = 'calendar';
  h.context.CSW_BOOKING = { webAppUrl: 'https://script.google.com/macros/s/abc/exec' };
  h.context.addEventListener = (type, fn) => {
    events[type] = fn;
  };
  vm.runInNewContext(embed, h.context);
  const url = new URL(h.get('csw-booking').src);
  assert.equal(url.searchParams.get('view'), 'calendar');
  const data = { type: 'csw:date', embedId: url.searchParams.get('embedId'), date: '2026-10-07' };
  events.message({ origin: 'https://evil.example', data });
  assert.equal(h.context.location.href, undefined);
  events.message({
    origin: 'https://test.googleusercontent.com',
    data: { ...data, date: 'javascript:alert(1)' }
  });
  assert.equal(h.context.location.href, undefined);
  events.message({ origin: 'https://test.googleusercontent.com', data });
  assert.equal(h.context.location.href, 'CSW.html?date=2026-10-07#signup');
  const manage = { type: 'csw:manage', embedId: url.searchParams.get('embedId') };
  events.message({ origin: 'https://evil.example', data: manage });
  assert.equal(h.context.location.href, 'CSW.html?date=2026-10-07#signup');
  events.message({
    origin: 'https://test.googleusercontent.com',
    data: { ...manage, embedId: 'wrong' }
  });
  assert.equal(h.context.location.href, 'CSW.html?date=2026-10-07#signup');
  events.message({ origin: 'https://test.googleusercontent.com', data: manage });
  assert.equal(h.context.location.href, 'CSW.html?manage=1#signup');
});

class Element {
  constructor() {
    this.children = [];
    this.events = {};
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.value = '';
    this.textContent = '';
    this.hidden = false;
  }
  addEventListener(type, fn) {
    (this.events[type] ||= []).push(fn);
  }
  fire(type, extra = {}) {
    for (const fn of this.events[type] || []) fn({ preventDefault() {}, ...extra });
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  reportValidity() {
    return true;
  }
  focus() {}
  scrollIntoView() {}
}

function surface() {
  const elements = new Map(),
    timers = new Map();
  let timerId = 0;
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const context = {
    console,
    URL,
    URLSearchParams,
    crypto,
    Intl,
    Date,
    document: { getElementById: get, createElement: () => new Element(), hidden: false },
    setTimeout(fn, ms) {
      const id = ++timerId;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {},
    location: { search: '', origin: 'http://localhost' }
  };
  context.window = context;
  const fireTimers = (ms) => {
    for (const [id, t] of [...timers])
      if (t.ms === ms) {
        timers.delete(id);
        t.fn();
      }
  };
  return { get, context, fireTimers };
}

const schedule = () => ({
  schoolYear: '2026–27',
  source: 'https://example.org/calendar',
  start: '11:55',
  end: '12:55',
  room: 'SC2',
  contact: 'school@example.org',
  calendarUrl: 'https://calendar.google.com/',
  slots: [
    { date: '2026-09-30', status: 'available', label: 'Available' },
    { date: '2026-10-07', status: 'available', label: 'Available' }
  ]
});

function app(responses = {}, parameters = {}) {
  const h = surface(),
    calls = [];
  // Keep upcoming/past dashboard tests independent of the day they are run.
  h.context.Date = class extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-09-24T16:00:00Z']));
    }
  };
  const defaults = {
    getAvailability: schedule(),
    myBookings: [],
    dashboardAccess: { role: 'owner', members: [] },
    verifyCode: { token: 'verified' },
    requestCode: { message: 'Code sent.' }
  };
  function runner(success, failure) {
    return new Proxy(
      {},
      {
        get(_, key) {
          if (key === 'withSuccessHandler') return (fn) => runner(fn, failure);
          if (key === 'withFailureHandler') return (fn) => runner(success, fn);
          return (...args) => {
            calls.push({ name: key, args });
            const queue = responses[key],
              result = queue && queue.length ? queue.shift() : defaults[key];
            if (result === noResponse) {
              h.finishRead = success;
              return;
            }
            if (result instanceof Error) failure(result);
            else success(result);
          };
        }
      }
    );
  }
  h.context.google = {
    script: {
      run: runner(),
      url: {
        getLocation(fn) {
          fn({ parameter: parameters });
        }
      }
    }
  };
  vm.runInNewContext(widget, h.context);
  h.calls = calls;
  h.click = async (id) => {
    h.get(id).fire('click');
    await pause();
  };
  h.submit = async (id) => {
    h.get(id).fire('submit');
    await pause();
  };
  return h;
}

test('dashboard filters use the loaded list; plans and history start collapsed', async () => {
  const h = app({
    verifyCode: [{ token: 'owner', organizer: true }],
    organizerBookings: [
      [
        { ...reservation, id: 'pending', topic: 'Pending robotics', status: 'pending' },
        { ...reservation, id: 'approved', date: '2026-10-07', topic: 'Approved games' },
        { ...reservation, id: 'cancelled', status: 'cancelled', topic: 'Old cancelled test' }
      ]
    ]
  });
  await pause();
  await h.click('verify');
  assert(!h.calls.some((c) => c.name === 'myBookings'));
  assert.equal(h.get('filter-pending').textContent, 'Needs approval (1)');
  assert.equal(h.get('filter-booked').textContent, 'Approved (1)');
  const all = descendants(h.get('organizer-bookings'));
  const plans = all.filter((el) => el.children.some((child) => child.textContent === 'View plans'));
  assert.equal(plans.length, 2);
  assert(plans.every((el) => !el.open));
  assert(!all.some((el) => el.textContent === 'Old cancelled test'));
  const calls = h.calls.length;
  await h.click('filter-pending');
  assert.equal(h.calls.length, calls);
  assert(rowButton(h, 'organizer-bookings', 'Approve request'));
  assert(
    !descendants(h.get('organizer-bookings')).some((el) => el.textContent === 'Approved games')
  );
  await h.click('filter-booked');
  assert.equal(h.calls.length, calls);
  assert.equal(rowButton(h, 'organizer-bookings', 'Approve request'), undefined);
  const history = h
    .get('organizer-bookings')
    .children.find((el) => el.className === 'organizer-history');
  history.open = true;
  history.fire('toggle');
  assert(descendants(history).some((el) => el.textContent === 'Old cancelled test'));
  const children = history.children.length;
  history.fire('toggle');
  assert.equal(history.children.length, children);
});

test('stalled availability request releases loading controls and shows a retry path', async () => {
  const h = app({ getAvailability: [noResponse] });
  assert.equal(h.get('refresh').disabled, true);
  h.fireTimers(60000);
  await pause();
  assert.equal(h.get('refresh').disabled, false);
  assert.match(h.get('load-status').textContent, /took too long.*Refresh to retry/);
  assert.equal(h.get('prev').disabled, true);
  await h.click('refresh');
  assert.ok(h.get('calendar').children.length > 7);
});

test('refresh during an older read waits and then fetches fresh availability', async () => {
  const updated = schedule();
  updated.slots = updated.slots.map((slot) => ({
    ...slot,
    status: 'booked',
    label: 'Presentation scheduled',
    name: 'Student One',
    topic: 'Robotics'
  }));
  const h = app({ getAvailability: [noResponse, updated] });
  // Simulate another refresh requested while the first read is still in flight.
  await h.click('refresh');
  assert.equal(h.calls.filter((c) => c.name === 'getAvailability').length, 1);
  h.finishRead(schedule());
  await pause();
  assert.equal(h.calls.filter((c) => c.name === 'getAvailability').length, 2);
  assert(
    h
      .get('calendar')
      .children.some((el) => el.attributes['aria-label']?.includes('CS Wednesday · Robotics'))
  );
  assert.equal(h.get('refresh').disabled, false);
});

test('stalled verification email resets busy state without resending automatically', async () => {
  const h = app({ requestCode: [noResponse] });
  await pause();
  h.get('email').value = 'hcps-test@henricostudents.org';
  await h.click('send-code');
  assert.equal(h.get('send-code').disabled, true);
  h.fireTimers(60000);
  await pause();
  assert.equal(h.get('send-code').disabled, false);
  assert.match(h.get('message').textContent, /Check your school inbox/);
  assert.equal(h.calls.filter((c) => c.name === 'requestCode').length, 1);
});

test('date deep link survives initial availability failure and applies after retry', async () => {
  const h = app(
    { getAvailability: [new Error('Temporary outage'), schedule()] },
    { date: '2026-10-07' }
  );
  await pause();
  assert.equal(h.get('date').value, '');
  assert.doesNotMatch(h.get('message').textContent, /outside this school year/);
  await h.click('refresh');
  assert.match(h.get('date').value, /October 7/);
  assert.equal(h.get('month').textContent, 'October 2026');
});

test('submitted request stays acknowledged when reservation-list read fails', async () => {
  const h = app(
    {
      myBookings: [[], new Error('Temporary read outage')],
      bookSlot: [
        {
          date: '2026-09-30',
          id: 'saved-reference',
          status: 'pending',
          synced: true,
          invited: false
        }
      ]
    },
    { date: '2026-09-30' }
  );
  await pause();
  await h.click('verify');
  await h.submit('signup');
  assert.match(h.get('message').textContent, /Request submitted for/);
  assert.match(h.get('message').textContent, /Request submitted for/);
  assert.doesNotMatch(h.get('message').textContent, /saved-reference/);
  assert.match(h.get('message').textContent, /Could not refresh your reservation list/);
});

test('manual refresh reconciles bookings and clears stale private UI on expired verification', async () => {
  const h = app({
    myBookings: [
      [{ id: 'r1', date: '2026-09-30', topic: 'Sample' }],
      new Error('Verification expired. Verify your school email again.')
    ]
  });
  await pause();
  await h.click('verify');
  assert.equal(h.get('email').readOnly, true);
  h.get('edit-form').hidden = false;
  await h.click('refresh');
  assert.equal(h.calls.filter((c) => c.name === 'myBookings').length, 2);
  assert.equal(h.get('email').readOnly, false);
  assert.equal(h.get('my-section').hidden, true);
  assert.equal(h.get('edit-form').hidden, true);
  assert.equal(h.get('my-bookings').children.length, 0);
  assert.equal(h.get('save-edit').disabled, true);
});

test('ambiguous booking timeout preserves request ID for an explicit retry', async () => {
  const h = app(
    {
      bookSlot: [
        noResponse,
        { date: '2026-09-30', id: 'same-booking', status: 'pending', synced: true, invited: false }
      ]
    },
    { date: '2026-09-30' }
  );
  await pause();
  await h.click('verify');
  await h.submit('signup');
  h.fireTimers(60000);
  await pause();
  assert.match(h.get('message').textContent, /may already be saved/);
  assert.equal(h.calls.filter((c) => c.name === 'bookSlot').length, 1);
  await h.submit('signup');
  const writes = h.calls.filter((c) => c.name === 'bookSlot');
  assert.equal(writes[0].args[0].requestId, writes[1].args[0].requestId);
  assert.match(h.get('message').textContent, /Request submitted for/);
  assert.doesNotMatch(h.get('message').textContent, /same-booking/);
});

test('empty availability response is recoverable, not an uncaught calendar-render error', async () => {
  const h = app({ getAvailability: [{ slots: [] }] });
  await pause();
  assert.match(h.get('load-status').textContent, /No school dates/);
  assert.equal(h.get('refresh').disabled, false);
});

test('Google iframe load is not treated as connected until actual widget handshake', () => {
  const h = surface();
  const events = {};
  h.context.CSW_BOOKING = {
    webAppUrl: 'https://script.google.com/a/macros/henricostudents.org/s/abc/exec'
  };
  h.context.addEventListener = (type, fn) => {
    events[type] = fn;
  };
  vm.runInNewContext(embed, h.context);
  h.get('csw-booking').fire('load');
  assert.equal(h.get('csw-setup-notice').hidden, false);
  h.fireTimers(10000);
  assert.match(h.get('csw-setup-notice').textContent, /HCPS school account/);
  const embedId = new URL(h.get('csw-booking').src).searchParams.get('embedId');
  events.message({
    origin: 'https://evil.example',
    data: { type: 'csw:resize', embedId, height: 1200 }
  });
  assert.equal(h.get('csw-setup-notice').hidden, false);
  events.message({
    origin: 'https://test.googleusercontent.com',
    data: { type: 'csw:resize', embedId: 'wrong', height: 1200 }
  });
  assert.equal(h.get('csw-setup-notice').hidden, false);
  events.message({
    origin: 'https://test.googleusercontent.com',
    data: { type: 'csw:resize', embedId, height: 1200 }
  });
  assert.equal(h.get('csw-setup-notice').hidden, true);
  assert.equal(h.get('csw-booking').style.height, '1200px');
});

const descendants = (el) => [el, ...el.children.flatMap(descendants)];
const rowButton = (h, id, text) => descendants(h.get(id)).find((el) => el.textContent === text);
const reservation = {
  id: 'r1',
  date: '2026-09-30',
  name: 'Test Student',
  topic: 'Python workshop',
  activity: 'Build a game',
  details: 'Demo and practice',
  email: 'student@henricostudents.org',
  status: 'booked',
  notification: 'sent'
};

test('cancellation requires explicit confirmation and shows durable feedback beside the list', async () => {
  const h = app({
    verifyCode: [{ token: 'owner', organizer: true }],
    organizerBookings: [[reservation], []],
    organizerCancelBooking: [{ cancelled: true, synced: false, invited: false }]
  });
  await pause();
  await h.click('verify');
  rowButton(h, 'organizer-bookings', 'Cancel signup').fire('click');
  await pause();
  assert.equal(h.calls.filter((c) => c.name === 'organizerCancelBooking').length, 0);
  assert.equal(rowButton(h, 'organizer-bookings', 'Confirm cancellation').hidden, false);
  rowButton(h, 'organizer-bookings', 'Keep signup').fire('click');
  assert.equal(rowButton(h, 'organizer-bookings', 'Confirm cancellation').hidden, true);
  rowButton(h, 'organizer-bookings', 'Cancel signup').fire('click');
  rowButton(h, 'organizer-bookings', 'Confirm cancellation').fire('click');
  await pause();
  assert.equal(h.calls.filter((c) => c.name === 'organizerCancelBooking').length, 1);
  assert.match(h.get('organizer-status').textContent, /signup itself is cancelled/);
  assert.equal(h.get('organizer-bookings').textContent, 'No signups yet.');
});

test('cancellation timeout releases controls and tells the user to check, without retrying a write', async () => {
  const h = app({
    verifyCode: [{ token: 'owner', organizer: true }],
    organizerBookings: [[reservation]],
    organizerCancelBooking: [noResponse]
  });
  await pause();
  await h.click('verify');
  rowButton(h, 'organizer-bookings', 'Cancel signup').fire('click');
  rowButton(h, 'organizer-bookings', 'Confirm cancellation').fire('click');
  await pause();
  h.fireTimers(60000);
  await pause();
  assert.equal(rowButton(h, 'organizer-bookings', 'Confirm cancellation').disabled, false);
  assert(
    descendants(h.get('organizer-bookings')).some((el) =>
      /may already be saved/.test(el.textContent)
    )
  );
  assert.equal(h.calls.filter((c) => c.name === 'organizerCancelBooking').length, 1);
});

test('only organizer verification loads management; management edits use the protected endpoint', async () => {
  const h = app({
    verifyCode: [{ token: 'owner-token', organizer: true }],
    organizerBookings: [[reservation], [reservation]],
    organizerEditBooking: [{ invited: true }]
  });
  await pause();
  await h.click('verify');
  assert.equal(h.get('organizer-section').hidden, false);
  rowButton(h, 'organizer-bookings', 'Edit').fire('click');
  await pause();
  h.get('edit-topic').value = 'Edited plan';
  await h.submit('edit-form');
  const call = h.calls.find((c) => c.name === 'organizerEditBooking');
  assert.equal(call.args[0].id, 'r1');
  assert.equal(call.args[0].topic, 'Edited plan');
  const student = app();
  await pause();
  await student.click('verify');
  assert(!student.calls.some((c) => c.name === 'organizerBookings'));
});

test('organizer cancellation uses protected endpoint and expired auth clears private management UI', async () => {
  const h = app({
    verifyCode: [{ token: 'owner-token', organizer: true }],
    organizerBookings: [[reservation]],
    organizerCancelBooking: [new Error('Verification expired. Verify your school email again.')]
  });
  await pause();
  await h.click('verify');
  rowButton(h, 'organizer-bookings', 'Cancel signup').fire('click');
  rowButton(h, 'organizer-bookings', 'Confirm cancellation').fire('click');
  await pause();
  assert.equal(h.calls.filter((c) => c.name === 'organizerCancelBooking').length, 1);
  assert.equal(h.get('organizer-section').hidden, true);
  assert.equal(h.get('organizer-bookings').children.length, 0);
  assert.equal(h.get('email').readOnly, false);
});

test('student reservations are read-only and email link carries reservation reference', async () => {
  const h = app({ myBookings: [[reservation]] });
  await pause();
  await h.click('verify');
  assert.equal(rowButton(h, 'my-bookings', 'Edit'), undefined);
  assert.equal(rowButton(h, 'my-bookings', 'Cancel signup'), undefined);
  const link = rowButton(h, 'my-bookings', 'Request changes by email');
  assert.match(link.href, /^mailto:hcps-joshisr1@henricostudents.org/);
  assert(decodeURIComponent(link.href).includes('Reference: r1'));
  assert(
    descendants(h.get('my-bookings')).some((el) =>
      el.textContent.includes('remains reserved until')
    )
  );
  h.get('edit-form').hidden = false;
  await h.submit('edit-form');
  assert(
    !h.calls.some((c) =>
      ['editBooking', 'organizerEditBooking', 'cancelBooking', 'organizerCancelBooking'].includes(
        c.name
      )
    )
  );
});

test('viewer has read-only cards and owner access changes require review', async () => {
  const v = app({
    verifyCode: [{ token: 'viewer', organizer: true, role: 'viewer' }],
    dashboardAccess: [{ role: 'viewer', members: [] }],
    organizerBookings: [[reservation]]
  });
  await pause();
  await v.click('verify');
  assert.equal(v.get('access-panel').hidden, true);
  assert.equal(v.get('calendar-panel').hidden, true);
  assert.equal(rowButton(v, 'organizer-bookings', 'Edit'), undefined);
  assert.equal(rowButton(v, 'organizer-bookings', 'Cancel signup'), undefined);
  const o = app({
    verifyCode: [{ token: 'owner', organizer: true }],
    organizerBookings: [[]],
    setDashboardAccess: [
      { role: 'owner', members: [{ email: 'officer@henricostudents.org', role: 'viewer' }] }
    ]
  });
  await pause();
  await o.click('verify');
  o.get('access-email').value = 'officer@henricostudents.org';
  o.get('access-role').value = 'viewer';
  await o.submit('access-form');
  assert(!o.calls.some((c) => c.name === 'setDashboardAccess'));
  assert.equal(o.get('access-confirm').hidden, false);
  await o.click('access-save');
  assert.equal(o.calls.filter((c) => c.name === 'setDashboardAccess').length, 1);
});

test('owner loads calendar settings, saves once, and finishes bounded calendar batches', async () => {
  const settings = {
    start: '11:55',
    end: '12:25',
    room: 'SC2',
    dates: [{ date: '2026-10-07', mode: 'default', reason: '', fixedClosure: '', booked: false }]
  };
  const h = app({
    verifyCode: [{ token: 'owner', organizer: true }],
    organizerBookings: [[]],
    calendarSettings: [settings],
    saveCalendarSettings: [settings],
    updateCalendarEvents: [{ deferred: 2 }, { deferred: 0 }]
  });
  await pause();
  await h.click('verify');
  assert.equal(h.get('calendar-panel').hidden, false);
  assert(!h.calls.some((c) => c.name === 'calendarSettings'));
  await h.click('calendar-load');
  assert.equal(h.get('calendar-fields').hidden, false);
  assert.equal(h.get('calendar-room').value, 'SC2');
  h.get('calendar-mode').value = 'closed';
  h.get('calendar-reason').value = 'Assembly\nNo session';
  await h.submit('calendar-date-form');
  const saves = h.calls.filter((c) => c.name === 'saveCalendarSettings');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].args[1].reason, 'Assembly\nNo session');
  assert.equal(h.calls.filter((c) => c.name === 'updateCalendarEvents').length, 2);
  assert.match(h.get('calendar-status').textContent, /up to date/);
});

test('calendar save failure does not start sync or erase the owner input', async () => {
  const h = app({
    verifyCode: [{ token: 'owner', organizer: true }],
    organizerBookings: [[]],
    saveCalendarSettings: [new Error('Upcoming reservations exist.')]
  });
  await pause();
  await h.click('verify');
  h.get('calendar-start').value = '11:55';
  h.get('calendar-end').value = '12:25';
  h.get('calendar-room').value = 'SC1';
  await h.submit('calendar-hours-form');
  assert.match(h.get('calendar-status').textContent, /Upcoming reservations/);
  assert.equal(h.get('calendar-room').value, 'SC1');
  assert(!h.calls.some((c) => c.name === 'updateCalendarEvents'));
});

test('calendar update retry clears a stale error without resaving settings', async () => {
  const h = app({
    verifyCode: [{ token: 'owner', organizer: true }],
    organizerBookings: [[]],
    updateCalendarEvents: [new Error('Another signup is being processed.'), { deferred: 0 }]
  });
  await pause();
  await h.click('verify');
  await h.click('calendar-sync');
  assert.match(h.get('calendar-status').textContent, /settings are saved.*unfinished/);
  await h.click('calendar-sync');
  assert.match(h.get('calendar-status').textContent, /up to date/);
  assert.equal(h.get('message').textContent, '');
  assert(!h.calls.some((c) => c.name === 'saveCalendarSettings'));
});

test('pending requests show owner approval controls only; approval sends protected RPC once', async () => {
  for (const role of ['owner', 'manager', 'viewer']) {
    const pending = { ...reservation, status: 'pending' };
    const h = app({
      verifyCode: [{ token: 'verified', organizer: true }],
      dashboardAccess: [
        { role, members: [] },
        { role, members: [] }
      ],
      organizerBookings: [[pending], [reservation]],
      organizerApproveBooking: [{ status: 'booked', confirmation: 'sent', invited: true }]
    });
    await pause();
    await h.click('verify');
    const button = rowButton(h, 'organizer-bookings', 'Approve request');
    if (role !== 'owner') {
      assert.equal(button, undefined);
      continue;
    }
    assert(button);
    button.fire('click');
    await pause();
    const calls = h.calls.filter((c) => c.name === 'organizerApproveBooking');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['verified', 'r1']);
    assert.match(h.get('organizer-status').textContent, /Approved.*sent/);
    assert.equal(rowButton(h, 'organizer-bookings', 'Approve request'), undefined);
  }
});

test('pending request approval timeout preserves retry controls and does not autoapprove', async () => {
  const h = app({
    verifyCode: [{ token: 'verified', organizer: true }],
    organizerBookings: [[{ ...reservation, status: 'pending' }]],
    organizerApproveBooking: [noResponse]
  });
  await pause();
  await h.click('verify');
  rowButton(h, 'organizer-bookings', 'Approve request').fire('click');
  await pause();
  h.fireTimers(60000);
  await pause();
  assert.match(h.get('message').textContent, /may already be saved/);
  assert.equal(h.calls.filter((c) => c.name === 'organizerApproveBooking').length, 1);
  assert.equal(rowButton(h, 'organizer-bookings', 'Approve request').disabled, false);
});

test('submission response distinguishes receipt email from approval email and invitation', async () => {
  const h = app(
    { bookSlot: [{ date: '2026-09-30', status: 'pending', submission: 'sent' }] },
    { date: '2026-09-30' }
  );
  await pause();
  await h.click('verify');
  await h.submit('signup');
  assert.match(h.get('message').textContent, /Submission email sent/);
  assert.match(
    h.get('message').textContent,
    /approval email and calendar invitation will be sent after approval/
  );
  assert.doesNotMatch(h.get('message').textContent, /has already been approved/);
});
