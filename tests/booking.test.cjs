const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const harness = require('./helpers/booking-harness.cjs');

// Existing delivery tests first submit a request, then approve as the verified owner.
test('organizer list reads records and delivery status in one batch', () => {
  const h = harness();
  const r = h.c.bookSlot(h.input(h.login()));
  const owner = h.owner();
  const original = h.c.PropertiesService.getScriptProperties;
  let batch = 0,
    single = 0;
  h.c.PropertiesService.getScriptProperties = () => {
    const store = original();
    return {
      ...store,
      getProperties: () => {
        batch++;
        return store.getProperties();
      },
      getProperty: (key) => {
        single++;
        return store.getProperty(key);
      }
    };
  };
  const rows = h.c.organizerBookings(owner);
  assert.equal(batch, 1);
  assert.equal(single, 0);
  assert.equal(rows.find((row) => row.id === r.id).submission, 'sent');
  assert.equal(rows.find((row) => row.id === r.id).status, 'pending');
  assert.throws(() => h.c.organizerBookings(h.login('other@henricostudents.org')), /access/);
});

function bookApproved(h, input) {
  const result = h.c.bookSlot(input);
  return h.c.organizerApproveBooking(h.owner(), result.id);
}

test('only verified owner can read or change calendar settings or run calendar updates', () => {
  const h = harness();
  const student = h.login();
  for (const role of ['', 'viewer', 'manager']) {
    if (role)
      h.props.set('dashboard-access:hcps-test@henricostudents.org', JSON.stringify({ role }));
    assert.throws(() => h.c.calendarSettings(student), /Only the dashboard owner/);
    assert.throws(
      () =>
        h.c.saveCalendarSettings(student, {
          kind: 'hours',
          start: '11:55',
          end: '12:25',
          room: 'SC2'
        }),
      /Only the dashboard owner/
    );
    assert.throws(() => h.c.updateCalendarEvents(student), /Only the dashboard owner/);
  }
  assert.throws(() => h.c.calendarSettings('expired'), /Verification expired/);
  assert.equal(h.c.calendarSettings(h.owner()).room, 'Test room');
});

test('owner closes and reopens dates; school closures, past dates and booked dates are protected', () => {
  const h = harness(),
    owner = h.owner();
  const close = {
    kind: 'date',
    date: '2026-10-07',
    mode: 'closed',
    reason: 'Assembly\nUse next week'
  };
  const mailBefore = h.mail.length;
  h.c.saveCalendarSettings(owner, close);
  assert.equal(h.c.getAvailability().slots.find((s) => s.date === close.date).status, 'closed');
  assert.equal(
    h.c.calendarSettings(owner).dates.find((d) => d.date === close.date).reason,
    close.reason
  );
  h.c.saveCalendarSettings(owner, { ...close, mode: 'open' });
  assert.equal(h.c.getAvailability().slots.find((s) => s.date === close.date).status, 'available');
  h.c.saveCalendarSettings(owner, { ...close, mode: 'default' });
  assert.equal(h.mail.length, mailBefore);
  assert.equal(JSON.parse(h.props.get('DATE_OVERRIDES'))[close.date], undefined);
  assert.throws(
    () => h.c.saveCalendarSettings(owner, { ...close, date: '2026-11-25', mode: 'open' }),
    /holiday/
  );
  for (const date of ['2026-09-23', '2026-10-06', '2027-06-09'])
    assert.throws(() => h.c.saveCalendarSettings(owner, { ...close, date }), /future Wednesday/);
  h.c.bookSlot(h.input(h.login(), close.date));
  assert.throws(() => h.c.saveCalendarSettings(owner, close), /has a reservation/);
});

test('hours enforce A lunch duration and protect upcoming reservation invitations', () => {
  const h = harness(),
    owner = h.owner();
  const input = { kind: 'hours', start: '11:55', end: '12:25', room: 'SC2' };
  for (const values of [
    { start: '25:00' },
    { end: '11:55' },
    { end: '12:26' },
    { room: 'bad\nroom' }
  ])
    assert.throws(() => h.c.saveCalendarSettings(owner, { ...input, ...values }));
  assert.equal(h.props.get('LUNCH_START'), '11:35');
  const booked = h.c.bookSlot(h.input(h.login()));
  assert.throws(() => h.c.saveCalendarSettings(owner, input), /Upcoming reservations exist/);
  h.c.organizerCancelBooking(owner, booked.id);
  const data = h.c.saveCalendarSettings(owner, input);
  assert.equal(data.start, '11:55');
  assert.equal(data.room, 'SC2');
});

test('calendar setting changes move existing events even when old and new hours do not overlap', () => {
  const h = harness(),
    owner = h.owner();
  while (h.c.updateCalendarEvents(owner).deferred) {}
  const before = h.events.length;
  h.c.saveCalendarSettings(owner, { kind: 'hours', start: '12:10', end: '12:40', room: 'SC1' });
  while (h.c.updateCalendarEvents(owner).deferred) {}
  assert.equal(h.events.length, before);
  const event = h.events.find((e) => e.description.startsWith('[CSW-SLOT:2026-10-07]'));
  assert.equal(event.location, 'SC1');
  assert.equal(event.start.toISOString().slice(11, 16), '16:10');
  assert.equal(h.c.updateCalendarEvents(owner).writes, 0);
});

test('saved calendar settings survive service failure and can finish on retry', () => {
  const h = harness(),
    owner = h.owner();
  h.c.saveCalendarSettings(owner, {
    kind: 'date',
    date: '2026-10-07',
    mode: 'closed',
    reason: 'No session'
  });
  h.setFailure(true);
  assert.throws(() => h.c.updateCalendarEvents(owner), /Calendar offline/);
  assert.equal(
    h.c.calendarSettings(owner).dates.find((d) => d.date === '2026-10-07').reason,
    'No session'
  );
  h.setFailure(false);
  while (h.c.updateCalendarEvents(owner).deferred) {}
  assert.equal(h.events.filter((e) => e.description.startsWith('[CSW-SLOT:2026-10-07]')).length, 1);
});

test('A lunch reservations use 11:55–12:25 in invites and confirmation emails', () => {
  const h = harness();
  h.props.set('LUNCH_START', '11:55');
  h.props.set('LUNCH_END', '12:25');
  bookApproved(h, h.input(h.login()));
  const event = h.events[0];
  assert.equal(+event.end - +event.start, 30 * 60000);
  const invite = [...h.invites.values()][0];
  assert.equal(Date.parse(invite.end.dateTime) - Date.parse(invite.start.dateTime), 30 * 60000);
  assert(JSON.stringify(h.mail).includes('11:55–12:25'));
});

test('shortening lunch updates the same calendar event once', () => {
  const h = harness();
  h.props.set('LUNCH_START', '11:55');
  h.props.set('LUNCH_END', '12:55');
  const input = h.input(h.login());
  h.c.bookSlot(input);
  const event = h.events[0];
  h.props.set('LUNCH_END', '12:25');
  assert.equal(h.c.syncOneSafe_(input.date, h.c.config_()), true);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0], event);
  assert.equal(+event.end - +event.start, 30 * 60000);
  h.c.syncOneSafe_(input.date, h.c.config_());
  assert.equal(h.calendarCalls.filter((call) => call.type === 'time').length, 1);
});

test('multiline plans survive booking, confirmation, invitation, and organizer edits', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const h = harness();
    const input = h.input(h.login());
    input.activity = 'First activity' + newline + '\tSecond activity';
    input.details = 'Introduction' + newline + newline + 'Practice';
    const result = bookApproved(h, input);
    const saved = h.c.myBookings(input.token)[0];
    assert.equal(saved.activity, 'First activity\n\tSecond activity');
    assert.equal(saved.details, 'Introduction\n\nPractice');
    assert(JSON.stringify(h.mail).includes('Introduction\\n\\nPractice'));
    assert.equal(result.invited, true);
    assert.equal(h.invites.size, 1);
    h.c.organizerEditBooking({
      ...input,
      token: h.owner(),
      id: result.id,
      details: 'Changed\n\nStill two paragraphs'
    });
    assert.equal(h.c.myBookings(input.token)[0].details, 'Changed\n\nStill two paragraphs');
    h.c.organizerCancelBooking(h.owner(), result.id);
    assert.equal(
      h.c.getAvailability().slots.find((s) => s.date === input.date).status,
      'available'
    );
  }
});

test('paragraph support retains length limits, header checks, and unsafe-character checks', () => {
  const h = harness();
  const input = h.input(h.login());
  for (const value of ['', '\n\t\n', 'x'.repeat(601), 'text\u0000bad', '<script>bad</script>']) {
    assert.throws(() => h.c.bookSlot({ ...input, activity: value }), /valid activity/);
  }
  for (const field of ['name', 'topic']) {
    assert.throws(
      () => h.c.bookSlot({ ...input, [field]: 'Hello\nBcc: someone@example.org' }),
      /valid/
    );
  }
  assert.doesNotThrow(() => h.c.bookSlot({ ...input, details: 'x'.repeat(600) }));
});

function schoolMeeting(title, start = '2026-10-20T15:30:00Z') {
  return {
    getTitle: () => title,
    getStartTime: () => new Date(start),
    getEndTime: () => new Date(Date.parse(start) + 1800000),
    isAllDayEvent: () => false,
    getLocation: () => 'SC2'
  };
}

test('club calendar reads school meetings and current bookings without exposing other events', () => {
  const h = harness();
  const original = h.c.CalendarApp.getCalendarById;
  let meetings = [
    schoolMeeting('CSHS'),
    schoolMeeting('Private appointment'),
    schoolMeeting('CSHS Officer Meeting')
  ];
  h.c.CalendarApp.getCalendarById = (id) =>
    id === h.c.organizerEmail_() ? { getEvents: () => meetings } : original(id);
  const input = h.input(h.login());
  const booked = bookApproved(h, input);
  const calendarWrites = h.calendarCalls.filter((c) => c.type !== 'read').length;
  const data = h.c.getClubCalendar();
  assert.equal(data.meetings.length, 1);
  assert.equal(data.meetings[0].date, '2026-10-20');
  assert.equal(data.meetings[0].title, 'CSHS Club Meeting');
  assert.equal(data.meetings[0].room, 'Auditorium');
  assert.equal(data.slots.find((s) => s.date === input.date).topic, input.topic);
  assert(!JSON.stringify(data).includes(input.details));
  assert(!JSON.stringify(data).includes('hcps-test@'));
  assert.equal(h.calendarCalls.filter((c) => c.type !== 'read').length, calendarWrites);
  meetings = [schoolMeeting('CSHS meeting', '2026-10-21T15:30:00Z')];
  assert.equal(h.c.getClubCalendar().meetings[0].date, '2026-10-21');
  meetings = [];
  assert.equal(h.c.getClubCalendar().meetings.length, 0);
  h.c.organizerCancelBooking(h.owner(), booked.id);
  assert.equal(h.c.getClubCalendar().slots.find((s) => s.date === input.date).status, 'available');
});

test('club calendar reports a school-calendar outage instead of pretending there are no meetings', () => {
  const h = harness();
  const original = h.c.CalendarApp.getCalendarById;
  h.c.CalendarApp.getCalendarById = (id) => (id === h.c.organizerEmail_() ? null : original(id));
  assert.throws(() => h.c.getClubCalendar(), /School calendar unavailable/);
});

test('availability uses one calendar read and still blocks overlapping outside events', () => {
  const h = harness();
  h.events.push({
    start: new Date('2026-10-07T15:30Z'),
    end: new Date('2026-10-07T16:30Z'),
    getStartTime() {
      return this.start;
    },
    getEndTime() {
      return this.end;
    },
    getDescription: () => ''
  });
  const data = h.c.getAvailability();
  assert.equal(h.calendarCalls.filter((call) => call.type === 'read').length, 1);
  assert.equal(data.slots.find((s) => s.date === '2026-10-07').status, 'blocked');
  assert.equal(data.slots.find((s) => s.date === '2026-10-14').status, 'available');
  assert.throws(() => h.c.bookSlot(h.input(h.login(), '2026-10-07')), /no longer available/);
});

test('past presentations retain their public topic but cancelled and unused dates do not', () => {
  const h = harness();
  const input = h.input(h.login());
  bookApproved(h, input);
  const second = bookApproved(h, h.input(input.token, '2026-10-07'));
  h.c.organizerCancelBooking(h.owner(), second.id);
  h.setTime('2026-10-15T20:00:00Z');
  const data = h.c.getAvailability();
  const past = data.slots.find((s) => s.date === input.date);
  assert.equal(past.status, 'past');
  assert.equal(past.topic, input.topic);
  assert.equal(past.name, input.name);
  for (const date of ['2026-10-07', '2026-10-14']) {
    const empty = data.slots.find((s) => s.date === date);
    assert.equal(empty.status, 'past');
    assert.equal(empty.topic, undefined);
  }
  assert(!JSON.stringify(data).includes(input.details));
  assert(!JSON.stringify(data).includes('hcps-test@'));
});

test('different students receive only their own confirmations across cancellation and rebooking', () => {
  const h = harness();
  for (const email of [
    'first@henricostudents.org',
    'second@henricostudents.org',
    'third@henricostudents.org'
  ]) {
    const token = h.login(email);
    const input = h.input(token);
    input.details = 'Demo\nQuestions';
    const result = bookApproved(h, input);
    const confirmation = h.mail
      .filter((args) => args[0] && args[0].subject && args[0].subject.includes('Request approved'))
      .at(-1)[0];
    assert.equal(confirmation.to, email);
    assert.equal(h.c.myBookings(token).length, 1);
    assert.equal([...h.invites.values()].at(-1).attendees[0].email, email);
    h.c.organizerCancelBooking(h.owner(), result.id);
    assert.equal(h.c.myBookings(token).length, 0);
  }
});

test('schedule covers all Wednesdays, with verified holidays and half-day excluded', () => {
  const { c } = harness(),
    days = c.dates_();
  assert.equal(days[0], '2026-08-26');
  assert.equal(days.at(-1), '2027-06-02');
  assert.equal(days.length, 41);
  assert(days.every((d) => new Date(d + 'T12:00:00Z').getUTCDay() === 3));
  for (const d of [
    '2026-11-25',
    '2026-12-23',
    '2026-12-30',
    '2027-03-10',
    '2027-03-31',
    '2026-10-28'
  ])
    assert.equal(c.getAvailability().slots.find((s) => s.date === d).status, 'closed');
});
test('reject non-school emails and wrong/expired codes; verification is one use', () => {
  const h = harness();
  assert.throws(() => h.c.requestCode('bad@example.org'), /school email/);
  h.c.requestCode('test@henricostudents.org');
  for (let n = 0; n < 5; n++)
    assert.throws(() => h.c.verifyCode('test@henricostudents.org', 'xxxxxx'), /Incorrect/);
  assert.throws(() => h.c.verifyCode('test@henricostudents.org', '123456'), /expired/);
  const token = h.login();
  assert(token);
  assert.throws(() => h.c.verifyCode('hcps-test@henricostudents.org', '123456'), /expired/);
});
test('reservation updates public event without PII; retry is idempotent', () => {
  const h = harness(),
    token = h.login(),
    input = h.input(token);
  const r = bookApproved(h, input);
  assert.equal(r.synced, true);
  const retry = bookApproved(h, input);
  assert.equal(retry.id, r.id);
  assert.equal(h.events.length, 1);
  assert.match(h.events[0].title, /Booked/);
  const pub = JSON.stringify(h.c.getAvailability()) + JSON.stringify(h.events);
  for (const secret of [input.details, input.activity, 'hcps-test@henricostudents.org'])
    assert(!pub.includes(secret));
  const slot = h.c.getAvailability().slots.find((s) => s.date === r.date);
  assert.equal(slot.name, input.name);
  assert.equal(slot.topic, input.topic);
  assert(!JSON.stringify(h.events).includes(input.name));
});
test('duplicate, invalid, holiday, past, and calendar-conflicting dates are refused', () => {
  const h = harness(),
    t = h.login();
  h.c.bookSlot(h.input(t));
  for (const d of [
    '2026-09-30',
    '2026-11-25',
    '2026-10-28',
    '2026-09-23',
    '2026-09-29',
    '2027-06-09'
  ])
    assert.throws(() => h.c.bookSlot(h.input(t, d)));
  h.events.push({
    start: new Date('2026-10-07T15:30Z'),
    end: new Date('2026-10-07T16:30Z'),
    getStartTime() {
      return this.start;
    },
    getEndTime() {
      return this.end;
    },
    getDescription: () => ''
  });
  assert.throws(() => h.c.bookSlot(h.input(t, '2026-10-07')), /no longer available/);
});
test('cancellation requires verified owner and reopens same event', () => {
  const h = harness(),
    t = h.login(),
    r = h.c.bookSlot(h.input(t));
  const other = h.login('other@henricostudents.org');
  assert.throws(() => h.c.organizerCancelBooking(other, r.id), /organizer/);
  assert.equal(h.c.myBookings(other).length, 0);
  h.c.organizerCancelBooking(h.owner(), r.id);
  assert.equal(h.c.myBookings(t).length, 0);
  assert.match(h.events[0].description, /\?date=2026-09-30#signup/);
  h.c.bookSlot(h.input(other));
  assert.equal(h.events.length, 1);
});
test('calendar failure retains booking, blocks duplicates, and repairs on sync', () => {
  const h = harness(),
    t = h.login();
  h.setFailure(true);
  const input = h.input(t),
    r = h.c.bookSlot(input);
  assert.equal(r.synced, false);
  assert.equal(h.c.getAvailability().slots.find((s) => s.date === input.date).status, 'pending');
  assert.throws(() => h.c.bookSlot(h.input(t)), /no longer available/);
  h.setFailure(false);
  const retry = h.c.bookSlot(input);
  assert.equal(retry.id, r.id);
  assert.equal(retry.synced, true);
});
test('lock contention refuses writes and future booking limit is enforced', () => {
  const h = harness(),
    t = h.login();
  h.setLock(true);
  assert.throws(() => h.c.bookSlot(h.input(t)), /Another signup/);
  h.setLock(false);
  h.c.bookSlot(h.input(t));
  h.c.bookSlot(h.input(t, '2026-10-07'));
  assert.throws(() => h.c.bookSlot(h.input(t, '2026-10-14')), /two upcoming/);
});
test('calendar sync is idempotent, keeps other events, and handles DST', () => {
  const h = harness();
  while (h.c.syncCalendar_().deferred) {}
  const n = h.events.length;
  h.events.push({
    start: new Date('2026-10-07T12:00Z'),
    end: new Date('2026-10-07T13:00Z'),
    getStartTime() {
      return this.start;
    },
    getEndTime() {
      return this.end;
    },
    getDescription: () => ''
  });
  h.calendarCalls.length = 0;
  const report = h.c.syncCalendar_();
  assert.equal(h.events.length, n + 1);
  assert.equal(report.writes, 0);
  assert.equal(h.calendarCalls.filter((call) => call.type !== 'read').length, 0);
  assert.equal(h.c.at_('2026-10-07', '11:35').toISOString(), '2026-10-07T15:35:00.000Z');
  assert.equal(h.c.at_('2026-11-04', '11:35').toISOString(), '2026-11-04T16:35:00.000Z');
});

test('initial calendar sync is bounded and resumes without rewriting unchanged events', () => {
  const h = harness();
  let report,
    previous = 0,
    runs = 0;
  do {
    h.calendarCalls.length = 0;
    report = h.c.syncCalendar_();
    runs++;
    const writes = h.calendarCalls.filter((call) => call.type !== 'read');
    assert(writes.length <= 20);
    assert.equal(writes.length, report.writes);
    assert.equal(
      writes.filter((call) => call.type === 'create').length,
      h.events.length - previous
    );
    assert(writes.every((call) => ['create', 'color'].includes(call.type)));
    previous = h.events.length;
  } while (report.deferred && runs < 10);
  assert(runs > 1);
  assert.equal(report.deferred, 0);
  assert.equal(
    h.events.length,
    h.c.dates_().filter((d) => h.c.at_(d, '12:05') > new h.c.Date()).length
  );
  assert.equal(JSON.parse(h.props.get('calendarSyncStatus')).deferred, 0);
});

test('changed status writes only changed fields; a retry performs no writes', () => {
  const h = harness(),
    t = h.login(),
    input = h.input(t);
  h.c.syncOne_(input.date, h.c.config_(), h.c.calendar_(h.c.config_()));
  h.calendarCalls.length = 0;
  h.c.bookSlot(input);
  assert.deepEqual(
    h.calendarCalls.filter((call) => call.type !== 'read').map((call) => call.type),
    ['title', 'description', 'color']
  );
  h.calendarCalls.length = 0;
  h.c.bookSlot(input);
  assert.equal(h.calendarCalls.filter((call) => call.type !== 'read').length, 0);
});

test('lost creation response repairs the same event and retains sync pending until complete', () => {
  const h = harness(),
    t = h.login(),
    input = h.input(t);
  h.setFailAfterCreate(true);
  assert.equal(h.c.bookSlot(input).synced, false);
  assert.equal(h.events.length, 1);
  assert.equal(h.c.myBookings(t)[0].syncPending, true);
  h.setFailAfterCreate(false);
  h.calendarCalls.length = 0;
  assert.equal(h.c.bookSlot(input).synced, true);
  assert.equal(h.events.length, 1);
  assert.deepEqual(
    h.calendarCalls.filter((call) => call.type !== 'read').map((call) => call.type),
    ['color']
  );
  assert.equal(h.c.myBookings(t)[0].syncPending, false);
});

test('calendar service failure stops the sweep and records failure without losing reservations', () => {
  const h = harness(),
    t = h.login(),
    r = h.c.bookSlot(h.input(t));
  h.setFailure(true);
  h.calendarCalls.length = 0;
  assert.throws(() => h.c.syncCalendar_(), /offline/);
  assert.equal(h.calendarCalls.filter((call) => call.type !== 'read').length, 1);
  assert.equal(JSON.parse(h.props.get('calendarSyncStatus')).failed, true);
  assert.equal(h.c.myBookings(t)[0].id, r.id);
});

test('notification tick retries a failed invitation only once and skips irrelevant calendar reads', () => {
  const h = harness(),
    t = h.login();
  h.setInviteFailure(true);
  bookApproved(h, h.input(t));
  let attempts = 0;
  h.c.Calendar.Events.get = () => {
    attempts++;
    throw Error('Service offline');
  };
  h.calendarCalls.length = 0;
  h.c.notificationsTick_();
  assert.equal(attempts, 1);
  assert.equal(h.calendarCalls.length, 0); // No reminder is due five days before the session.
});
test('server-side validation, expired auth and unavailable config fail closed', () => {
  const h = harness(),
    t = h.login();
  assert.throws(
    () => h.c.bookSlot({ ...h.input(t), topic: '<script>alert(1)</script>' }),
    /valid topic/
  );
  assert.throws(() => h.c.bookSlot({ ...h.input(t), agree: false }), /confirm/);
  assert.throws(() => h.c.bookSlot(h.input('invalid')), /expired/);
  h.props.delete('ROOM');
  assert.throws(() => h.c.getAvailability(), /not connected/);
});
test('private invitation sent once, cancellation notifies, rebooking creates a new invitation', () => {
  const h = harness(),
    t = h.login(),
    input = h.input(t),
    r = bookApproved(h, input);
  assert.equal(r.invited, true);
  bookApproved(h, input);
  assert.equal(h.inviteCalls.length, 1);
  const invite = h.inviteCalls[0];
  assert.equal(invite.cal, 'private-test');
  assert.equal(invite.options.sendUpdates, 'all');
  assert.equal(invite.event.attendees[0].email, 'hcps-test@henricostudents.org');
  assert.equal(invite.event.visibility, 'private');
  assert.equal(invite.event.guestsCanSeeOtherGuests, false);
  h.c.organizerCancelBooking(h.owner(), r.id);
  assert.equal(h.inviteCalls[1].type, 'remove');
  assert.equal(h.inviteCalls[1].options.sendUpdates, 'all');
  bookApproved(h, h.input(t));
  assert.equal(h.invites.size, 1);
  assert.notEqual(h.inviteCalls[2].event.id, invite.event.id);
});
test('reminders send once in each window and stop after cancellation', () => {
  const h = harness(),
    t = h.login(),
    r = bookApproved(h, h.input(t));
  const initial = h.mail.length;
  h.setTime('2026-09-29T15:40:00Z');
  h.c.notificationsTick_();
  h.c.notificationsTick_();
  assert.equal(h.mail.length, initial + 1);
  assert.match(h.mail.at(-1)[0].subject, /tomorrow/);
  h.setTime('2026-09-30T14:40:00Z');
  h.c.notificationsTick_();
  h.c.notificationsTick_();
  assert.equal(h.mail.length, initial + 2);
  assert.match(h.mail.at(-1)[0].subject, /about an hour/);
  const fresh = h.owner();
  h.c.organizerCancelBooking(fresh, r.id);
  h.c.notificationsTick_();
  assert.equal(h.mail.length, initial + 4); // new OTP and organizer cancellation notice; no extra reminder
});
test('pending invitation repairs without losing a reservation', () => {
  const h = harness(),
    t = h.login();
  h.setInviteFailure(true);
  const r = bookApproved(h, h.input(t));
  assert.equal(r.invited, false);
  assert.equal(r.confirmation, 'pending');
  assert(!h.mail.some((x) => x[0].subject?.includes('Request approved')));
  assert.equal(h.c.myBookings(t).length, 1);
  h.setInviteFailure(false);
  h.c.notificationsTick_();
  assert.equal(h.invites.size, 1);
  assert.equal(h.c.confirmationStatus_(r.id), 'sent');
  h.c.notificationsTick_();
  assert.equal(h.inviteCalls.length, 1);
});
test('no reminder for short-notice bookings, closures, or cancelled bookings', () => {
  const h = harness(),
    c = h.c.config_();
  const r = { date: '2026-09-30', createdAt: '2026-09-30T15:00:00Z', status: 'booked' };
  assert.equal(h.c.reminderDue_(r, 1, Date.parse('2026-09-30T15:10Z'), c), false);
  r.createdAt = '2026-09-24T15:00Z';
  r.status = 'cancelled';
  assert.equal(h.c.reminderDue_(r, 1, Date.parse('2026-09-30T15:10Z'), c), false);
  r.status = 'booked';
  c.overrides[r.date] = 'Closure';
  assert.equal(h.c.reminderDue_(r, 1, Date.parse('2026-09-30T15:10Z'), c), false);
});
test('public or domain-shared invitation calendar fails closed', () => {
  const h = harness(),
    t = h.login();
  h.c.Calendar.Acl.list = () => ({ items: [{ role: 'reader', scope: { type: 'default' } }] });
  assert.equal(bookApproved(h, h.input(t)).invited, false);
  assert.equal(h.invites.size, 0);
});

test('only verified organizer edits an active booking; invitation updates once and retries safely', () => {
  const h = harness(),
    token = h.login(),
    r = bookApproved(h, h.input(token));
  const other = h.login('other@henricostudents.org');
  const edit = {
    token,
    id: r.id,
    name: 'Updated group',
    topic: 'New topic',
    activity: 'Updated activity',
    details: 'Updated outline'
  };
  assert.throws(() => h.c.organizerEditBooking({ ...edit, token: other }), /organizer/);
  h.setInviteFailure(true);
  assert.equal(h.c.organizerEditBooking({ ...edit, token: h.owner() }).invited, false);
  assert.equal(h.c.myBookings(token)[0].details, 'Updated outline');
  h.setInviteFailure(false);
  h.c.notificationsTick_();
  assert.equal(h.invites.get(h.c.invitationId_(r.id)).summary, 'CS Wednesday: New topic');
  h.c.organizerEditBooking({ ...edit, token: h.owner() });
  assert.equal(h.inviteCalls.filter((c) => c.type === 'patch').length, 1);
  assert.equal(h.c.getAvailability().slots.find((s) => s.date === r.date).status, 'booked');
  assert(!JSON.stringify(h.events).includes('New topic'));
  h.c.organizerCancelBooking(h.owner(), r.id);
  assert.throws(() => h.c.organizerEditBooking({ ...edit, token: h.owner() }), /not found/);
});

test('activity plan is required and stored privately', () => {
  const h = harness(),
    token = h.login();
  const input = h.input(token);
  assert.throws(() => h.c.bookSlot({ ...input, activity: '' }), /activity plan/);
  h.c.bookSlot(input);
  assert.equal(h.c.myBookings(token)[0].activity, input.activity);
  assert(!JSON.stringify(h.c.getAvailability()).includes(input.activity));
});

test('cancellation succeeds even when calendar lookup fails, and can be safely retried', () => {
  const h = harness(),
    t = h.login(),
    r = bookApproved(h, h.input(t));
  h.c.CalendarApp.getCalendarById = () => {
    throw Error('Calendar unavailable');
  };
  h.setInviteFailure(true);
  const result = h.c.organizerCancelBooking(h.owner(), r.id);
  assert.equal(result.cancelled, true);
  assert.equal(result.synced, false);
  assert.equal(result.invited, false);
  assert.equal(h.c.myBookings(t).length, 0);
  assert.equal(h.c.record_(r.date).status, 'cancelled');
  const mailCount = h.mail.length;
  h.c.organizerCancelBooking(h.owner(), r.id);
  assert.equal(h.mail.length, mailCount);
});

test('retrying old cancellation after another group rebooks never cancels the new group', () => {
  const h = harness(),
    t = h.login(),
    old = bookApproved(h, h.input(t));
  h.c.organizerCancelBooking(h.owner(), old.id);
  const other = h.login('other@henricostudents.org'),
    fresh = bookApproved(h, h.input(other));
  assert.equal(h.c.organizerCancelBooking(h.owner(), old.id).cancelled, true);
  assert.equal(h.c.record_(old.date).id, fresh.id);
  assert.equal(h.c.record_(old.date).status, 'booked');
  assert.equal(h.invites.size, 1);
});

test('organizer endpoints reject other verified students and expired tokens', () => {
  const h = harness(),
    student = h.login(),
    r = h.c.bookSlot(h.input(student));
  for (const token of [student, 'bad-token']) {
    assert.throws(() => h.c.organizerBookings(token), /organizer|expired/);
    assert.throws(() => h.c.organizerCancelBooking(token, r.id), /organizer|expired/);
    assert.throws(
      () => h.c.organizerEditBooking({ ...h.input(token), id: r.id }),
      /organizer|expired/
    );
  }
  assert.equal(h.c.record_(r.date).status, 'pending');
});

test('verified school organizer sees history, edits another student, and cancels started sessions', () => {
  const h = harness(),
    student = h.login(),
    r = h.c.bookSlot(h.input(student));
  const owner = h.login('hcps-joshisr1@henricostudents.org');
  assert.equal(h.c.organizerBookings(owner)[0].email, 'hcps-test@henricostudents.org');
  h.c.organizerEditBooking({ ...h.input(owner), id: r.id, topic: 'Organizer corrected topic' });
  assert.equal(h.c.myBookings(student)[0].topic, 'Organizer corrected topic');
  h.setTime('2026-09-30T16:00Z');
  const fresh = h.login('hcps-joshisr1@henricostudents.org');
  h.c.organizerCancelBooking(fresh, r.id);
  const row = h.c.organizerBookings(fresh)[0];
  assert.equal(row.status, 'cancelled');
  assert.equal(row.syncPending, false);
});

test('organizer email goes only to the school owner and retries do not duplicate notices', () => {
  const h = harness(),
    t = h.login(),
    input = h.input(t),
    r = h.c.bookSlot(input);
  const notices = () => h.mail.filter((args) => args[0] && args[0].to === h.c.organizerEmail_());
  assert.equal(notices().length, 1);
  const notice = notices()[0][0];
  assert.match(notice.subject, /New request — approval needed/);
  assert.match(notice.body, /Test Presenter/);
  assert.match(notice.body, /Build a small program/);
  assert.match(notice.body, /\?manage=1#organizer/);
  assert(!notice.body.includes(t));
  h.c.bookSlot(input);
  h.c.notificationsTick_();
  assert.equal(notices().length, 1);
  const edit = { ...input, id: r.id, topic: 'New topic' };
  h.c.organizerEditBooking({ ...edit, token: h.owner() });
  h.c.organizerEditBooking({ ...edit, token: h.owner() });
  assert.equal(notices().length, 2);
  h.c.organizerCancelBooking(h.owner(), r.id);
  h.c.organizerCancelBooking(h.owner(), r.id);
  assert.equal(notices().length, 3);
});

test('quota exhaustion queues notices; ambiguous send errors do not rollback or repeatedly email', () => {
  const h = harness(),
    t = h.login();
  h.c.MailApp.getRemainingDailyQuota = () => 0;
  const r = h.c.bookSlot(h.input(t)),
    key = 'organizer-notice:' + r.id + ':1';
  assert.equal(JSON.parse(h.props.get(key)).status, 'pending');
  h.c.MailApp.getRemainingDailyQuota = () => 100;
  let sends = 0;
  h.c.MailApp.sendEmail = () => {
    sends++;
    throw Error('Lost mail response');
  };
  h.c.notificationsTick_();
  h.c.notificationsTick_();
  assert.equal(sends, 2);
  assert.equal(JSON.parse(h.props.get(key)).status, 'unknown');
  assert.equal(h.props.has('confirmation:' + r.id), false);
  assert.equal(h.c.myBookings(t).length, 1);
});

test('outbox never sends a notice for an uncommitted reservation', () => {
  const h = harness();
  h.c.queueOrganizerNotice_(
    { id: 'uncommitted', revision: 1, date: '2026-10-07' },
    'New signup',
    h.c.config_()
  );
  h.c.deliverOrganizerNotices_(h.c.config_());
  assert.equal(h.mail.length, 0);
});

test('student mutation endpoints are disabled even for the booking owner or a stale client', () => {
  const h = harness(),
    t = h.login(),
    r = h.c.bookSlot(h.input(t));
  const before = JSON.stringify(h.c.record_(r.date)),
    count = h.mail.length;
  for (const token of [t, 'invalid', h.owner()]) {
    assert.throws(
      () => h.c.editBooking({ ...h.input(token), id: r.id, topic: 'Not allowed' }),
      /Students cannot edit.*hcps-joshisr1/
    );
    assert.throws(() => h.c.cancelBooking(token, r.id), /Students cannot cancel.*hcps-joshisr1/);
  }
  assert.equal(JSON.stringify(h.c.record_(r.date)), before);
  assert.equal(h.c.myBookings(t).length, 1);
});

test('reservation detail confirmation goes once to verified student with school reply-to', () => {
  const h = harness(),
    t = h.login(),
    input = h.input(t),
    r = bookApproved(h, input);
  const confirmations = () => h.mail.filter((x) => x[0].subject?.includes('Request approved'));
  assert.equal(r.confirmation, 'sent');
  assert.equal(confirmations().length, 1);
  const m = confirmations()[0][0];
  assert.equal(m.to, 'hcps-test@henricostudents.org');
  assert.equal(m.replyTo, h.c.organizerEmail_());
  assert.match(m.body, /Open your calendar invitation: https:\/\/www.google.com\/calendar\/event/);
  assert.doesNotMatch(m.body, /Reference:|View your reservation:|date and reference/);
  for (const value of [
    r.date,
    '11:35',
    '12:05',
    'Test room',
    input.name,
    input.topic,
    input.activity,
    input.details
  ])
    assert(m.body.includes(value));
  assert(m.body.startsWith('Dear ' + input.name + ',\n\n'));
  assert(m.body.endsWith('Best regards,\nShlok Joshi'));
  assert.doesNotMatch(m.body, /Sign in with the school email|Please respond to the invitation|Students cannot edit or cancel online|Declining the calendar invitation|with your date and presentation topic/);
  assert.match(m.body, /request is approved/);
  assert(!m.body.includes(t));
  bookApproved(h, input);
  h.c.notificationsTick_();
  assert.equal(confirmations().length, 1);
  assert.match(
    h.invites.get(h.c.invitationId_(r.id)).description,
    /Changes or cancellation: email/
  );
});

test('queued confirmation uses current details, retries quota shortage, never confirms cancelled slots', () => {
  const h = harness(),
    t = h.login(),
    owner = h.owner();
  h.c.MailApp.getRemainingDailyQuota = () => 0;
  const r = bookApproved(h, h.input(t));
  assert.equal(r.confirmation, 'pending');
  h.c.organizerEditBooking({ ...h.input(owner), id: r.id, topic: 'Corrected before delivery' });
  h.c.MailApp.getRemainingDailyQuota = () => 100;
  h.c.notificationsTick_();
  assert.match(
    h.mail.find((x) => x[0].subject?.includes('Request approved'))[0].body,
    /Corrected before delivery/
  );
  h.c.MailApp.getRemainingDailyQuota = () => 0;
  const second = bookApproved(h, h.input(t, '2026-10-07'));
  h.c.organizerCancelBooking(owner, second.id);
  h.c.MailApp.getRemainingDailyQuota = () => 100;
  h.c.notificationsTick_();
  assert.equal(h.c.confirmationStatus_(second.id), 'skipped');
  assert.equal(h.mail.filter((x) => x[0].subject?.includes('Request approved')).length, 1);
});

test('confirmation jobs never email uncommitted bookings or retroactively email older bookings', () => {
  const h = harness();
  h.c.queueConfirmation_({ id: 'not-saved' });
  h.c.deliverConfirmations_(h.c.config_());
  assert.equal(h.mail.length, 0);
  h.c.save_({
    id: 'legacy',
    date: '2026-10-07',
    status: 'booked',
    email: 'legacy@henricostudents.org',
    createdAt: '2026-09-24T10:00:00Z'
  });
  h.c.deliverConfirmations_(h.c.config_());
  assert.equal(h.mail.length, 0);
});

test('verification permits ten spaced codes per address while retaining cooldown and daily cap', () => {
  const h = harness(),
    email = 'limit-test@henricostudents.org';
  for (let i = 0; i < 10; i++) {
    h.setTime('2026-09-24T16:' + String(i).padStart(2, '0') + ':00Z');
    h.c.requestCode(email);
    assert.throws(() => h.c.requestCode(email), /Wait one minute/);
  }
  h.setTime('2026-09-24T16:10:00Z');
  assert.throws(() => h.c.requestCode(email), /10 codes/);
  h.setTime('2026-09-24T22:10:00Z');
  h.c.requestCode(email);
  h.props.set('mailBudget', JSON.stringify({ date: '2026-09-24', count: 40 }));
  assert.throws(
    () => h.c.requestCode('another@henricostudents.org'),
    /Today.s verification-email allowance/
  );
});

test('only organizer destination bypasses count caps, without bypassing OTP, cooldown or Google quota', () => {
  const h = harness(),
    email = 'hcps-joshisr1@henricostudents.org';
  h.props.set('mailBudget', JSON.stringify({ date: '2026-09-24', count: 40 }));
  for (let i = 0; i < 12; i++) {
    h.setTime('2026-09-24T16:' + String(i).padStart(2, '0') + ':00Z');
    h.c.requestCode(email);
    assert.throws(() => h.c.requestCode(email), /Wait one minute/);
  }
  assert.equal(JSON.parse(h.props.get('mailBudget')).count, 40);
  assert.throws(
    () => h.c.requestCode('hcps-joshisr1+other@henricostudents.org'),
    /Today.s verification-email allowance/
  );
  assert.throws(() => h.c.verifyCode(email, 'wrong'), /Incorrect code/);
  h.setTime('2026-09-24T16:12:00Z');
  h.c.MailApp.getRemainingDailyQuota = () => 0;
  assert.throws(() => h.c.requestCode(email), /Google.s email sending quota/);
  assert.equal(h.mail.length, 12);
});

test('owner grants roles; managers cannot delegate; revocation and downgrade affect existing tokens', () => {
  const h = harness(),
    owner = h.owner(),
    student = h.login('officer@henricostudents.org');
  assert.throws(
    () => h.c.setDashboardAccess(student, 'other@henricostudents.org', 'manager'),
    /Only the dashboard owner/
  );
  assert.throws(
    () => h.c.setDashboardAccess(owner, h.c.organizerEmail_(), 'revoked'),
    /Owner access/
  );
  assert.throws(
    () => h.c.setDashboardAccess(owner, 'outside@example.com', 'viewer'),
    /school email/
  );
  assert.throws(
    () => h.c.setDashboardAccess(owner, 'officer@henricostudents.org', 'owner'),
    /Choose Viewer/
  );
  h.c.setDashboardAccess(owner, 'officer@henricostudents.org', 'viewer');
  assert.equal(h.c.dashboardAccess(student).role, 'viewer');
  assert.equal(h.c.dashboardAccess(student).members.length, 0);
  h.c.organizerBookings(student);
  assert.throws(() => h.c.organizerCancelBooking(student, 'any'), /permission denied/);
  const booking = h.c.bookSlot(h.input(owner));
  h.c.setDashboardAccess(owner, 'officer@henricostudents.org', 'manager');
  h.c.organizerEditBooking({ ...h.input(student), id: booking.id, topic: 'Manager edited' });
  assert.throws(
    () => h.c.setDashboardAccess(student, 'other@henricostudents.org', 'viewer'),
    /Only the dashboard owner/
  );
  h.c.setDashboardAccess(owner, 'officer@henricostudents.org', 'viewer');
  assert.throws(
    () => h.c.organizerEditBooking({ ...h.input(student), id: booking.id }),
    /permission denied/
  );
  h.c.setDashboardAccess(owner, 'officer@henricostudents.org', 'revoked');
  assert.throws(() => h.c.organizerBookings(student), /permission denied/);
  assert.equal(h.c.dashboardAccess(owner).members.length, 0);
});

test('new requests send organizer notice and submission receipt, but no approval email or invitation', () => {
  const h = harness(),
    input = h.input(h.login()),
    before = h.mail.length;
  const r = h.c.bookSlot(input);
  assert.equal(r.status, 'pending');
  assert.equal(h.mail.length, before + 2);
  assert.equal(h.mail[before][0].to, h.c.organizerEmail_());
  assert.equal(h.mail[before + 1][0].to, 'hcps-test@henricostudents.org');
  assert.match(h.mail[before][0].subject, /approval needed/);
  assert.match(h.mail[before + 1][0].subject, /Request submitted/);
  assert.equal(h.invites.size, 0);
  h.c.bookSlot(input);
  h.c.notificationsTick_();
  h.setTime('2026-09-29T15:40:00Z');
  h.c.notificationsTick_();
  h.setTime('2026-09-30T14:40:00Z');
  h.c.notificationsTick_();
  assert.equal(h.mail.length, before + 2);
  assert.equal(h.inviteCalls.length, 0);
  const slot = h.c.getAvailability().slots.find((s) => s.date === input.date);
  assert.equal(slot.status, 'pending');
  for (const key of ['name', 'topic', 'email', 'activity', 'details'])
    assert.equal(slot[key], undefined);
});

test('pending requests hold dates and count toward limit; edit and decline send no student notification', () => {
  const h = harness(),
    input = h.input(h.login()),
    r = h.c.bookSlot(input),
    owner = h.owner();
  assert.throws(
    () => h.c.bookSlot({ ...input, requestId: crypto.randomUUID() }),
    /no longer available/
  );
  h.c.bookSlot(h.input(input.token, '2026-10-07'));
  assert.throws(() => h.c.bookSlot(h.input(input.token, '2026-10-14')), /two upcoming/);
  h.c.organizerEditBooking({ ...input, token: owner, id: r.id, topic: 'Corrected pending topic' });
  assert.equal(h.c.record_(r.date).status, 'pending');
  assert.equal(h.c.myBookings(input.token)[0].status, 'pending');
  h.c.organizerCancelBooking(owner, r.id);
  h.c.notificationsTick_();
  assert.equal(h.c.getAvailability().slots.find((s) => s.date === r.date).status, 'available');
  assert.equal(h.inviteCalls.length, 0);
  assert(!h.mail.some((x) => x[0]?.subject?.includes('Request approved')));
  assert.throws(() => h.c.organizerApproveBooking(owner, r.id), /no longer active/);
});

test('only owner approves once; latest plan delivered and repeated approval never duplicates notifications', () => {
  const h = harness(),
    input = h.input(h.login()),
    r = h.c.bookSlot(input);
  for (const role of ['', 'viewer', 'manager']) {
    if (role)
      h.props.set('dashboard-access:hcps-test@henricostudents.org', JSON.stringify({ role }));
    assert.throws(() => h.c.organizerApproveBooking(input.token, r.id), /Only the dashboard owner/);
  }
  assert.throws(() => h.c.organizerApproveBooking('expired', r.id), /expired/);
  const owner = h.owner();
  h.c.organizerEditBooking({
    ...input,
    token: owner,
    id: r.id,
    topic: 'Updated before approval',
    details: 'First line\nSecond line'
  });
  const approved = h.c.organizerApproveBooking(owner, r.id);
  assert.equal(approved.status, 'booked');
  assert.equal(approved.confirmation, 'sent');
  assert.equal(h.invites.size, 1);
  const messages = () => h.mail.filter((x) => x[0]?.subject?.includes('Request approved'));
  assert.equal(messages().length, 1);
  assert.match(messages()[0][0].body, /Updated before approval/);
  assert.match(messages()[0][0].body, /First line\nSecond line/);
  assert.match(messages()[0][0].body, /request is approved/);
  const count = h.mail.length;
  h.c.organizerApproveBooking(owner, r.id);
  h.c.bookSlot(input);
  h.c.notificationsTick_();
  assert.equal(h.mail.length, count);
  assert.equal(h.inviteCalls.filter((x) => x.type === 'insert').length, 1);
  assert.equal(
    h.c.getAvailability().slots.find((s) => s.date === r.date).topic,
    'Updated before approval'
  );
});

test('approval refuses closures, calendar conflicts and past sessions without sending student mail', () => {
  const h = harness(),
    r = h.c.bookSlot(h.input(h.login())),
    owner = h.owner();
  h.props.set('DATE_OVERRIDES', JSON.stringify({ [r.date]: 'Closed' }));
  assert.throws(() => h.c.organizerApproveBooking(owner, r.id), /unavailable/);
  h.props.set('DATE_OVERRIDES', '{}');
  const external = h.c
    .calendar_(h.c.config_())
    .createEvent('Other event', h.c.at_(r.date, '11:35'), h.c.at_(r.date, '12:05'), {
      description: ''
    });
  assert.throws(() => h.c.organizerApproveBooking(owner, r.id), /conflict/);
  h.events.splice(h.events.indexOf(external), 1);
  h.setTime('2026-09-30T16:00Z');
  assert.throws(() => h.c.organizerApproveBooking(h.owner(), r.id), /already started/);
  assert.equal(h.invites.size, 0);
  assert.equal(h.c.record_(r.date).status, 'pending');
});

test('pending request cannot leak through a stale confirmation or invitation job', () => {
  const h = harness(),
    r = h.c.bookSlot(h.input(h.login())),
    c = h.c.config_();
  h.props.set('confirmation:' + r.id, JSON.stringify({ id: r.id, status: 'pending' }));
  h.props.set(
    'invite:' + r.id,
    JSON.stringify({
      ...h.c.record_(r.date),
      status: 'booked',
      calendarId: c.inviteCalendarId,
      pending: true
    })
  );
  const before = h.mail.length;
  h.c.notificationsTick_();
  assert.equal(h.invites.size, 0);
  assert.equal(h.mail.length, before);
});

test('approval survives delivery outage and resumes after approval only; late approval skips past reminder windows', () => {
  const h = harness(),
    r = h.c.bookSlot(h.input(h.login()));
  h.setTime('2026-09-30T15:00Z');
  const owner = h.owner();
  h.setInviteFailure(true);
  const result = h.c.organizerApproveBooking(owner, r.id);
  assert.equal(result.status, 'booked');
  assert.equal(result.confirmation, 'pending');
  assert.equal(h.invites.size, 0);
  h.setInviteFailure(false);
  h.c.notificationsTick_();
  assert.equal(h.c.confirmationStatus_(r.id), 'sent');
  assert.equal(h.invites.size, 1);
  assert(!h.mail.some((x) => x[0]?.subject?.startsWith('Reminder:')));
});

test('submission receipt contains submitted details, no invitation link, and sends once across retries', () => {
  const h = harness(),
    input = h.input(h.login());
  input.details = 'First line\nSecond line';
  const r = h.c.bookSlot(input);
  const receipts = () => h.mail.filter((x) => x[0]?.subject?.includes('Request submitted'));
  assert.equal(r.submission, 'sent');
  assert.equal(receipts().length, 1);
  const m = receipts()[0][0];
  assert.equal(m.to, 'hcps-test@henricostudents.org');
  assert.equal(m.replyTo, h.c.organizerEmail_());
  assert.match(m.body, /awaiting organizer approval/);
  assert.match(m.body, /not an approval/);
  for (const value of [input.date, input.name, input.topic, input.activity, input.details])
    assert(m.body.includes(value));
  assert.doesNotMatch(m.body, /https?:|Reference:|View your reservation/);
  assert.equal(h.invites.size, 0);
  h.c.bookSlot(input);
  h.c.notificationsTick_();
  assert.equal(receipts().length, 1);
  h.c.organizerApproveBooking(h.owner(), r.id);
  assert.equal(receipts().length, 1);
  assert.equal(h.mail.filter((x) => x[0]?.subject?.includes('Request approved')).length, 1);
  assert.equal(h.invites.size, 1);
});

test('queued submission receipts retry quota shortage but skip requests already approved, cancelled or past', () => {
  for (const outcome of ['pending', 'approved', 'cancelled', 'past']) {
    const h = harness(),
      token = h.login(),
      owner = h.owner();
    h.c.MailApp.getRemainingDailyQuota = () => 0;
    const r = h.c.bookSlot(h.input(token));
    assert.equal(r.submission, 'pending');
    if (outcome === 'approved') h.c.organizerApproveBooking(owner, r.id);
    if (outcome === 'cancelled') h.c.organizerCancelBooking(owner, r.id);
    if (outcome === 'past') h.setTime('2026-09-30T16:00Z');
    h.c.MailApp.getRemainingDailyQuota = () => 100;
    h.c.notificationsTick_();
    h.c.notificationsTick_();
    assert.equal(
      h.mail.filter((x) => x[0]?.subject?.includes('Request submitted')).length,
      outcome === 'pending' ? 1 : 0
    );
    assert.equal(h.c.submissionStatus_(r.id), outcome === 'pending' ? 'sent' : 'skipped');
  }
});

test('uncommitted and ambiguous submission receipt jobs never produce repeated email', () => {
  const h = harness();
  h.c.queueSubmissionReceipt_({ id: 'unsaved' });
  h.c.deliverSubmissionReceipts_(h.c.config_());
  assert.equal(h.mail.length, 0);
  const token = h.login();
  const original = h.c.MailApp.sendEmail;
  let attempts = 0;
  h.c.MailApp.sendEmail = (...args) => {
    if (args[0]?.subject?.includes('Request submitted')) {
      attempts++;
      throw Error('Ambiguous send');
    }
    return original(...args);
  };
  const r = h.c.bookSlot(h.input(token));
  assert.equal(r.submission, 'unknown');
  h.c.notificationsTick_();
  h.c.notificationsTick_();
  assert.equal(attempts, 1);
  assert.equal(h.c.record_(r.date).status, 'pending');
  assert.equal(h.invites.size, 0);
});
