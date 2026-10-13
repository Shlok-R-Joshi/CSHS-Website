/** CS Wednesdays: deploy as calendar owner; private helpers end in _. */
function doGet(e) {
  var view = e && e.parameter && e.parameter.view;
  var calendarView = view === 'calendar';
  return HtmlService.createHtmlOutputFromFile(view === 'tutoring' ? 'TutoringPage' : calendarView ? 'Calendar' : 'Widget')
    .setTitle(view === 'tutoring' ? 'CS Tutoring' : calendarView ? 'CSHS Calendar' : 'CS Wednesdays')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function config_() {
  var p = PropertiesService.getScriptProperties();
  var c = {
    calendarId: p.getProperty('CALENDAR_ID'),
    inviteCalendarId: p.getProperty('INVITE_CALENDAR_ID'),
    start: p.getProperty('LUNCH_START'),
    end: p.getProperty('LUNCH_END'),
    room: p.getProperty('ROOM'),
    siteUrl: p.getProperty('SITE_URL'),
    overrides: JSON.parse(p.getProperty('DATE_OVERRIDES') || '{}'),
    contact: p.getProperty('CONTACT_EMAIL')
  };
  if (
    !c.calendarId ||
    !c.inviteCalendarId ||
    c.inviteCalendarId === c.calendarId ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.start || '') ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.end || '') ||
    c.start >= c.end ||
    !c.room ||
    !/^https:\/\//.test(c.siteUrl || '') ||
    !c.contact
  ) {
    throw new Error('Signup is not connected yet. Please contact a CSHS officer.');
  }
  return c;
}
function locked_(action) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Another signup is being processed. Please try again.');
  try {
    return action();
  } finally {
    lock.releaseLock();
  }
}
function dateKey_(date) {
  return Utilities.formatDate(date, CSW_SCHEDULE.timezone, 'yyyy-MM-dd');
}
function at_(date, time) {
  return Utilities.parseDate(date + ' ' + time, CSW_SCHEDULE.timezone, 'yyyy-MM-dd HH:mm');
}
function dates_() {
  var result = [],
    day = new Date(CSW_SCHEDULE.firstDay + 'T12:00:00Z');
  while (day.toISOString().slice(0, 10) <= CSW_SCHEDULE.lastDay) {
    if (day.getUTCDay() === 3) result.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return result;
}
function closure_(date, c) {
  // A holiday cannot be opened accidentally by an override; update the source schedule if HCPS changes it.
  if (CSW_SCHEDULE.closed[date]) return CSW_SCHEDULE.closed[date];
  if (Object.prototype.hasOwnProperty.call(c.overrides, date))
    return String(c.overrides[date] || '');
  return CSW_SCHEDULE.review[date] || '';
}
function calendar_(c) {
  var calendar = CalendarApp.getCalendarById(c.calendarId);
  if (!calendar)
    throw new Error('The signup calendar is unavailable. Please contact a CSHS officer.');
  return calendar;
}
function marker_(date) {
  return '[CSW-SLOT:' + date + ']';
}
function record_(date) {
  return JSON.parse(
    PropertiesService.getScriptProperties().getProperty('booking:' + date) || 'null'
  );
}
// Pending requests hold a slot; approval is required for invitations and reminders.
function holdsSlot_(r) {
  return !!r && (r.status === 'pending' || r.status === 'booked');
}
function save_(r) {
  var p = PropertiesService.getScriptProperties(),
    previous = record_(r.date);
  // Keep identity/history when a cancelled date is reserved by another group.
  if (previous && previous.id !== r.id)
    p.setProperty('booking-id:' + previous.id, JSON.stringify(previous));
  p.setProperty('booking:' + r.date, JSON.stringify(r));
  p.setProperty('booking-id:' + r.id, JSON.stringify(r));
}
function bookingById_(id) {
  if (typeof id !== 'string' || id.length > 100) return null;
  return (
    dates_()
      .map(record_)
      .filter(function (r) {
        return r && r.id === id;
      })[0] ||
    JSON.parse(PropertiesService.getScriptProperties().getProperty('booking-id:' + id) || 'null')
  );
}
function organizerEmail_() {
  return 'hcps-joshisr1@henricostudents.org';
}
function dashboardRole_(email) {
  if (email === organizerEmail_()) return 'owner';
  var entry = JSON.parse(
    PropertiesService.getScriptProperties().getProperty('dashboard-access:' + email) || 'null'
  );
  return entry && ['viewer', 'manager'].indexOf(entry.role) >= 0 ? entry.role : '';
}
function dashboardIdentity_(token, manage) {
  var email = identity_(token),
    role = dashboardRole_(email);
  if (!role || (manage && role === 'viewer'))
    throw new Error('Dashboard permission denied. Ask the organizer for access.');
  return email;
}
function dashboardAccess(token) {
  var email = identity_(token),
    role = dashboardRole_(email),
    members = [];
  if (role === 'owner') {
    var all = PropertiesService.getScriptProperties().getProperties();
    members = Object.keys(all)
      .filter(function (k) {
        return k.indexOf('dashboard-access:') === 0;
      })
      .map(function (k) {
        var r = JSON.parse(all[k]);
        return { email: k.slice(17), role: r.role };
      })
      .filter(function (r) {
        return ['viewer', 'manager'].indexOf(r.role) >= 0;
      })
      .sort(function (a, b) {
        return a.email.localeCompare(b.email);
      });
  }
  return { role: role, members: members };
}
function setDashboardAccess(token, email, role) {
  return locked_(function () {
    if (identity_(token) !== organizerEmail_())
      throw new Error('Only the dashboard owner can manage access.');
    email = email_(email);
    if (email === organizerEmail_()) throw new Error('Owner access cannot be changed or removed.');
    if (['viewer', 'manager', 'revoked'].indexOf(role) < 0)
      throw new Error('Choose Viewer or Manager.');
    var p = PropertiesService.getScriptProperties(),
      key = 'dashboard-access:' + email;
    // Role is checked on every protected request, so revocation affects existing sessions.
    p.setProperty(
      key,
      JSON.stringify({
        role: role,
        updatedAt: new Date().toISOString(),
        updatedBy: organizerEmail_()
      })
    );
    return dashboardAccess(token);
  });
}
function organizerIdentity_(token) {
  return dashboardIdentity_(token, true);
}
function calendarOwner_(token) {
  if (identity_(token) !== organizerEmail_())
    throw new Error('Only the dashboard owner can change calendar settings.');
}
function calendarSettings(token) {
  calendarOwner_(token);
  var c = config_();
  var bookings = PropertiesService.getScriptProperties().getProperties();
  return {
    start: c.start,
    end: c.end,
    room: c.room,
    dates: dates_()
      .filter(function (date) {
        return at_(date, c.end) > new Date();
      })
      .map(function (date) {
        var booking = JSON.parse(bookings['booking:' + date] || 'null');
        return {
          date: date,
          fixedClosure: CSW_SCHEDULE.closed[date] || '',
          reason: closure_(date, c),
          mode: Object.prototype.hasOwnProperty.call(c.overrides, date)
            ? c.overrides[date]
              ? 'closed'
              : 'open'
            : 'default',
          booked: holdsSlot_(booking)
        };
      })
  };
}
function saveCalendarSettings(token, input) {
  input = input || {};
  return locked_(function () {
    calendarOwner_(token);
    var c = config_(),
      p = PropertiesService.getScriptProperties();
    if (input.kind === 'hours') {
      var start = String(input.start || ''),
        end = String(input.end || '');
      var room = clean_(input.room, 'room', 80);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end))
        throw new Error('Enter valid start and end times.');
      var minutes = function (time) {
        return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
      };
      if (minutes(end) <= minutes(start) || minutes(end) - minutes(start) > 30)
        throw new Error('CS Wednesdays are A lunch only. Choose a duration of 1–30 minutes.');
      var changed = start !== c.start || end !== c.end || room !== c.room;
      var all = p.getProperties();
      if (
        changed &&
        dates_().some(function (date) {
          var booking = JSON.parse(all['booking:' + date] || 'null');
          return holdsSlot_(booking) && at_(date, c.end) > new Date();
        })
      )
        throw new Error(
          'Upcoming reservations exist. Resolve them in Manage signups before changing hours or room; their invitations must not become incorrect.'
        );
      p.setProperties({ LUNCH_START: start, LUNCH_END: end, ROOM: room });
    } else if (input.kind === 'date') {
      var date = String(input.date || ''),
        mode = input.mode;
      if (dates_().indexOf(date) < 0 || at_(date, c.start) <= new Date())
        throw new Error('Choose a future Wednesday in this school year.');
      if (['default', 'open', 'closed'].indexOf(mode) < 0)
        throw new Error('Choose Open, Closed, or School schedule.');
      if (mode === 'open' && CSW_SCHEDULE.closed[date])
        throw new Error('This date is a school holiday or half-day and cannot be opened here.');
      var booking = record_(date);
      if (holdsSlot_(booking))
        throw new Error('This date has a reservation. Manage or cancel the signup first.');
      if (mode === 'default') delete c.overrides[date];
      else
        c.overrides[date] =
          mode === 'open' ? '' : clean_(input.reason, 'closure reason', 200, true);
      p.setProperty('DATE_OVERRIDES', JSON.stringify(c.overrides));
    } else throw new Error('Choose which calendar setting to change.');
    return calendarSettings(token);
  });
}
function updateCalendarEvents(token) {
  calendarOwner_(token);
  // Settings are saved first. This bounded, repeatable step also repairs interrupted updates.
  return syncCalendar_();
}
function events_(date, c, calendar) {
  return calendar.getEvents(at_(date, c.start), at_(date, c.end));
}
function owned_(event, date) {
  return event.getDescription().indexOf(marker_(date)) === 0;
}
function slot_(date, c, calendar, now, knownEvents, knownBooking) {
  var reason = closure_(date, c),
    booking = knownBooking === undefined ? record_(date) : knownBooking;
  if (reason) return { date: date, status: 'closed', label: reason };
  if (at_(date, c.start).getTime() <= now) {
    var past = { date: date, status: 'past', label: 'Past session' };
    if (booking && booking.status === 'booked') {
      past.name = booking.name;
      past.topic = booking.topic;
    }
    return past;
  }
  if (booking && booking.status === 'pending')
    return { date: date, status: 'pending', label: 'Awaiting approval' };
  if (booking && booking.status === 'booked')
    return {
      date: date,
      status: 'booked',
      label: 'Presentation scheduled',
      name: booking.name,
      topic: booking.topic
    };
  if (
    (knownEvents || events_(date, c, calendar)).some(function (e) {
      return !owned_(e, date);
    })
  ) {
    return { date: date, status: 'blocked', label: 'Unavailable — calendar conflict' };
  }
  return { date: date, status: 'available', label: 'Available' };
}
function getAvailability() {
  var c = config_(),
    calendar = calendar_(c),
    now = Date.now();
  // One Calendar read for the year, instead of one slow request per Wednesday.
  var events = calendar
    .getEvents(at_(CSW_SCHEDULE.firstDay, '00:00'), at_(CSW_SCHEDULE.lastDay, '23:59'))
    .map(function (event) {
      return { event: event, start: +event.getStartTime(), end: +event.getEndTime() };
    });
  var bookings = PropertiesService.getScriptProperties().getProperties();
  return {
    schoolYear: CSW_SCHEDULE.schoolYear,
    timezone: CSW_SCHEDULE.timezone,
    start: c.start,
    end: c.end,
    room: c.room,
    contact: c.contact,
    source: CSW_SCHEDULE.source,
    calendarUrl:
      'https://calendar.google.com/calendar/embed?src=' +
      encodeURIComponent(c.calendarId) +
      '&ctz=America%2FNew_York',
    checkedAt: new Date().toISOString(),
    slots: dates_().map(function (d) {
      var start = +at_(d, c.start),
        end = +at_(d, c.end);
      var overlapping = events
        .filter(function (item) {
          return item.start < end && item.end > start;
        })
        .map(function (item) {
          return item.event;
        });
      return slot_(
        d,
        c,
        calendar,
        now,
        overlapping,
        JSON.parse(bookings['booking:' + d] || 'null')
      );
    })
  };
}

// Read both sources each time. No copied events or duplicate calendars to maintain.
function getClubCalendar() {
  var result = getAvailability();
  var school = CalendarApp.getCalendarById(organizerEmail_());
  if (!school) throw new Error('School calendar unavailable. Please try again.');
  var start = at_(CSW_SCHEDULE.firstDay, '00:00');
  var end = at_(CSW_SCHEDULE.lastDay, '23:59');
  result.meetings = school
    .getEvents(start, end)
    .filter(function (event) {
      // Only general club meetings. Officer meetings and other school events stay private.
      return /^(CSHS|Computer Science Honou?r Society)(\s+(general\s+)?meeting)?$/i.test(
        event.getTitle().trim()
      );
    })
    .map(function (event) {
      return {
        date: dateKey_(event.getStartTime()),
        title: 'CSHS Club Meeting',
        start: event.getStartTime().toISOString(),
        end: event.getEndTime().toISOString(),
        allDay: event.isAllDayEvent(),
        room: 'Auditorium'
      };
    })
    .sort(function (a, b) {
      return a.start.localeCompare(b.start);
    });
  return result;
}
function digest_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value)
    .map(function (b) {
      return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
    })
    .join('');
}
function email_(value) {
  var email = String(value || '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9._+-]+@henricostudents\.org$/.test(email) || email.length > 120) {
    throw new Error('Use your @henricostudents.org school email.');
  }
  return email;
}
function requestCode(email) {
  config_();
  email = email_(email);
  return locked_(function () {
    var cache = CacheService.getScriptCache(),
      key = 'otp:' + digest_(email),
      old = cache.get(key);
    if (old && Date.now() - JSON.parse(old).sent < 60000)
      throw new Error('Wait one minute before requesting another code.');
    var props = PropertiesService.getScriptProperties(),
      today = dateKey_(new Date());
    var budget = JSON.parse(props.getProperty('mailBudget') || '{}');
    if (budget.date !== today) budget = { date: today, count: 0 };
    var perEmail = 'mail:' + digest_(email),
      attempts = JSON.parse(cache.get(perEmail) || '{"count":0}');
    // Organizer destination is exempt from app count caps, never from OTP authentication or Google's quota.
    var ownerDestination = email === organizerEmail_();
    if (!ownerDestination && attempts.count >= 10)
      throw new Error(
        'This email has requested 10 codes. Wait six hours after your last request, or contact the organizer.'
      );
    if (!ownerDestination && budget.count >= 40)
      throw new Error(
        "Today's verification-email allowance is used. Contact the organizer or try tomorrow."
      );
    if (MailApp.getRemainingDailyQuota() < 1)
      throw new Error(
        "Google's email sending quota is temporarily exhausted. Contact the organizer or try later."
      );
    var salt = Utilities.getUuid();
    var code = String(parseInt(digest_(Utilities.getUuid()).slice(0, 12), 16) % 1000000).padStart(
      6,
      '0'
    );
    cache.put(
      key,
      JSON.stringify({ hash: digest_(salt + code), salt: salt, tries: 0, sent: Date.now() }),
      600
    );
    if (!ownerDestination) {
      cache.put(perEmail, JSON.stringify({ count: attempts.count + 1 }), 21600);
      budget.count++;
      props.setProperty('mailBudget', JSON.stringify(budget));
    }
    MailApp.sendEmail(
      email,
      'Your CSHS verification code',
      'Your code is ' +
        code +
        '. It expires in 10 minutes.\n\nEnter it only on the CSHS signup page. If you did not request this, ignore this email.'
    );
    return { message: 'Code sent. Check your school email (including spam).' };
  });
}
function verifyCode(email, code) {
  email = email_(email);
  return locked_(function () {
    var cache = CacheService.getScriptCache(),
      key = 'otp:' + digest_(email),
      raw = cache.get(key);
    if (!raw) throw new Error('Code expired. Request a new code.');
    var r = JSON.parse(raw);
    if (Date.now() - r.sent >= 600000 || r.tries >= 5) {
      cache.remove(key);
      throw new Error('Code expired. Request a new code.');
    }
    r.tries++;
    cache.put(
      key,
      JSON.stringify(r),
      Math.max(1, Math.floor((600000 - (Date.now() - r.sent)) / 1000))
    );
    if (digest_(r.salt + String(code).trim()) !== r.hash)
      throw new Error('Incorrect code. Try again.');
    cache.remove(key);
    var token = Utilities.getUuid() + Utilities.getUuid();
    cache.put('auth:' + digest_(token), email, 1800);
    return { token: token, organizer: !!dashboardRole_(email), role: dashboardRole_(email) };
  });
}
function identity_(token) {
  if (typeof token !== 'string' || token.length > 100)
    throw new Error('Verify your school email first.');
  var email = CacheService.getScriptCache().get('auth:' + digest_(token));
  if (!email) throw new Error('Verification expired. Verify your school email again.');
  return email;
}
function clean_(value, label, max, multiline) {
  var s = String(value || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  // Plans can contain paragraphs and tabs. Names and titles stay on one line.
  var invalid = multiline ? /[\x00-\x08\x0b-\x1f\x7f<>]/ : /[\x00-\x1f\x7f<>]/;
  if (!s || s.length > max || invalid.test(s))
    throw new Error('Enter a valid ' + label + ' (up to ' + max + ' characters).');
  return s;
}
function bookSlot(input) {
  input = input || {};
  var email = identity_(input.token),
    c = config_();
  var date = String(input.date || '');
  if (dates_().indexOf(date) < 0) throw new Error('Choose a Wednesday in the current school year.');
  var name = clean_(input.name, 'name or group', 100),
    topic = clean_(input.topic, 'topic', 120);
  var details = clean_(input.details, 'meeting outline/plan', 600, true);
  var activity = clean_(input.activity, 'activity plan', 600, true);
  if (!/^[a-zA-Z0-9-]{20,80}$/.test(String(input.requestId || '')))
    throw new Error('Refresh the page and try again.');
  if (input.agree !== true) throw new Error('Please confirm you can host this session.');
  return locked_(function () {
    var calendar = calendar_(c),
      previous = record_(date);
    // A retry after a lost network response returns the same reservation, without applying it again.
    if (previous && previous.requestId === input.requestId && previous.email === email) {
      if (!holdsSlot_(previous))
        throw new Error('This reservation was cancelled. Choose a date again.');
      deliverOrganizerNotices_(c);
      deliverSubmissionReceipts_(c);
      deliverConfirmations_(c);
      return {
        status: previous.status,
        date: date,
        id: previous.id,
        submission: submissionStatus_(previous.id),
        confirmation: confirmationStatus_(previous.id),
        synced: syncOneSafe_(date, c, calendar),
        invited: inviteSafe_(previous, c)
      };
    }
    if (slot_(date, c, calendar, Date.now()).status !== 'available')
      throw new Error('That date is no longer available. Choose another Wednesday.');
    var active = dates_().filter(function (d) {
      var r = record_(d);
      return holdsSlot_(r) && r.email === email && at_(d, c.start) > new Date();
    });
    if (active.length >= 2)
      throw new Error(
        'You can hold two upcoming sessions. Email ' +
          organizerEmail_() +
          ' to request a cancellation before reserving another.'
      );
    var r = {
      id: Utilities.getUuid(),
      date: date,
      email: email,
      name: name,
      topic: topic,
      activity: activity,
      details: details,
      requestId: input.requestId,
      status: 'pending',
      createdAt: new Date().toISOString(),
      syncPending: true
    };
    r.revision = 1;
    queueOrganizerNotice_(r, 'New request — approval needed', c);
    queueSubmissionReceipt_(r);
    save_(r); // Durable reservation before any Calendar write: fail closed on calendar errors.
    deliverOrganizerNotices_(c);
    deliverSubmissionReceipts_(c);
    deliverConfirmations_(c);
    return {
      date: date,
      id: r.id,
      status: r.status,
      submission: submissionStatus_(r.id),
      confirmation: confirmationStatus_(r.id),
      synced: syncOneSafe_(date, c, calendar),
      invited: inviteSafe_(r, c)
    };
  });
}
// Only the school owner can approve; manager/viewer access does not grant approval.
function organizerApproveBooking(token, id) {
  return locked_(function () {
    if (identity_(token) !== organizerEmail_())
      throw new Error('Only the dashboard owner can approve requests.');
    var c = config_(),
      r = bookingById_(id),
      calendar = calendar_(c);
    if (!r || !holdsSlot_(r) || !record_(r.date) || record_(r.date).id !== r.id)
      throw new Error('This request is no longer active.');
    if (at_(r.date, c.start).getTime() <= Date.now())
      throw new Error('This session has already started.');
    if (
      closure_(r.date, c) ||
      events_(r.date, c, calendar).some(function (event) {
        return !owned_(event, r.date);
      })
    )
      throw new Error('This date is unavailable. Resolve the calendar conflict before approving.');
    if (typeof tutoringRecords_ === 'function' && tutoringRecords_().some(function (session) {
      return session.kind === 'request' && session.status === 'approved' &&
        [session.email, session.tutorEmail].indexOf(r.email) >= 0 &&
        at_(session.date, session.start) < at_(r.date, c.end) &&
        at_(session.date, session.end) > at_(r.date, c.start);
    })) throw new Error('This presenter already has a tutoring session at this time.');
    if (r.status === 'pending') {
      r.status = 'booked';
      r.approvedAt = new Date().toISOString();
      r.approvedBy = organizerEmail_();
      r.syncPending = true;
      queueConfirmation_(r);
      save_(r); // Approval must be durable before any student notification.
    }
    deliverConfirmations_(c);
    return {
      id: r.id,
      date: r.date,
      status: r.status,
      submission: submissionStatus_(r.id),
      confirmation: confirmationStatus_(r.id),
      synced: syncOneSafe_(r.date, c, calendar),
      invited: inviteSafe_(r, c)
    };
  });
}
function myBookings(token) {
  var email = identity_(token),
    c = config_();
  return dates_()
    .map(record_)
    .filter(function (r) {
      return holdsSlot_(r) && r.email === email && at_(r.date, c.start) > new Date();
    })
    .map(function (r) {
      return {
        id: r.id,
        date: r.date,
        name: r.name,
        topic: r.topic,
        activity: r.activity || '',
        details: r.details,
        status: r.status,
        syncPending: r.syncPending
      };
    });
}
function editBooking(input) {
  throw new Error(
    'Students cannot edit reservations. Email ' + organizerEmail_() + ' to request a change.'
  );
}
function organizerEditBooking(input) {
  return editBookingAs_(input, true);
}
function editBookingAs_(input, organizer) {
  input = input || {};
  var email = organizerIdentity_(input.token),
    c = config_();
  var name = clean_(input.name, 'name or group', 100),
    topic = clean_(input.topic, 'topic', 120);
  var details = clean_(input.details, 'meeting outline/plan', 600, true);
  var activity = clean_(input.activity, 'activity plan', 600, true);
  return locked_(function () {
    organizerIdentity_(input.token);
    var r = dates_()
      .map(record_)
      .filter(function (r) {
        return r && r.id === input.id && (organizer || r.email === email) && holdsSlot_(r);
      })[0];
    if (!r) throw new Error('Reservation not found for this account.');
    if (!organizer && at_(r.date, c.start) <= new Date())
      throw new Error('Contact an officer to change a past session.');
    if (r.name === name && r.topic === topic && r.activity === activity && r.details === details)
      return { id: r.id, date: r.date, status: r.status, invited: inviteSafe_(r, c) };
    r.name = name;
    r.topic = topic;
    r.activity = activity;
    r.details = details;
    r.updatedAt = new Date().toISOString();
    r.updatedBy = email;
    r.revision = (r.revision || 1) + 1;
    queueOrganizerNotice_(r, 'Signup updated', c);
    save_(r);
    deliverOrganizerNotices_(c);
    return { id: r.id, date: r.date, status: r.status, invited: inviteSafe_(r, c) };
  });
}
function cancelBooking(token, id) {
  throw new Error(
    'Students cannot cancel reservations online. Email ' +
      organizerEmail_() +
      ' to request cancellation. Your date remains reserved until the organizer cancels it.'
  );
}
function organizerCancelBooking(token, id) {
  return cancelBookingAs_(token, id, true);
}
function cancelBookingAs_(token, id, organizer) {
  var email = organizerIdentity_(token),
    c = config_();
  return locked_(function () {
    organizerIdentity_(token);
    var r = bookingById_(id);
    if (!r || (!organizer && r.email !== email))
      throw new Error('Reservation not found for this account.');
    if (r.status !== 'cancelled') {
      if (!organizer && at_(r.date, c.start) <= new Date())
        throw new Error('This session has started. Contact the organizer to cancel it.');
      r.status = 'cancelled';
      r.syncPending = true;
      r.cancelledAt = new Date().toISOString();
      r.updatedBy = email;
      r.revision = (r.revision || 1) + 1;
      queueOrganizerNotice_(r, 'Signup cancelled', c);
      save_(r);
      deliverOrganizerNotices_(c);
    }
    // Calendar lookup itself may fail. The durable cancellation still succeeded.
    return { cancelled: true, synced: syncOneSafe_(r.date, c), invited: inviteSafe_(r, c) };
  });
}
function organizerBookings(token) {
  dashboardIdentity_(token, false);
  var p = PropertiesService.getScriptProperties(),
    all = p.getProperties(),
    byId = {};
  Object.keys(all)
    .filter(function (k) {
      return k.indexOf('booking-id:') === 0;
    })
    .forEach(function (k) {
      var r = JSON.parse(all[k]);
      byId[r.id] = r;
    });
  dates_()
    .map(function (date) {
      return JSON.parse(all['booking:' + date] || 'null');
    })
    .filter(Boolean)
    .forEach(function (r) {
      byId[r.id] = r;
    });
  return Object.keys(byId)
    .map(function (id) {
      var r = byId[id],
        notice = JSON.parse(all['organizer-notice:' + id + ':' + (r.revision || 1)] || 'null');
      return {
        id: r.id,
        date: r.date,
        email: r.email,
        name: r.name,
        topic: r.topic,
        activity: r.activity || '',
        details: r.details,
        status: r.status,
        syncPending: !!r.syncPending,
        submission:
          JSON.parse(all['submission:' + id] || 'null')?.status || 'Not recorded (older signup)',
        confirmation:
          JSON.parse(all['confirmation:' + id] || 'null')?.status || 'Not recorded (older signup)',
        notification: notice ? notice.status : 'Not recorded (older signup)'
      };
    })
    .sort(function (a, b) {
      return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
    });
}
function syncOneSafe_(date, c, calendar) {
  try {
    syncOne_(date, c, calendar || calendar_(c));
    return true;
  } catch (e) {
    console.error('Calendar sync failed for ' + date);
    return false;
  }
}
function syncOne_(date, c, calendar, budget) {
  // Search the whole date so moving lunch never creates a second managed event.
  var dayEvents = calendar.getEvents(at_(date, '00:00'), at_(date, '23:59')),
    own = dayEvents.filter(function (e) {
      return owned_(e, date);
    });
  var events = dayEvents.filter(function (e) {
    return e.getStartTime() < at_(date, c.end) && e.getEndTime() > at_(date, c.start);
  });
  var state = slot_(date, c, calendar, Date.now(), events),
    r = record_(date);
  if (state.status === 'past') {
    if (r && r.status === 'cancelled' && r.syncPending) {
      r.syncPending = false;
      save_(r);
    }
    return { writes: 0, deferred: false };
  }
  if (own.length > 1)
    throw new Error('Duplicate managed calendar events; officer review required.');
  var title =
    state.status === 'available'
      ? 'Available · CS Wednesday A lunch'
      : state.status === 'pending'
        ? 'Pending approval · CS Wednesday A lunch'
        : state.status === 'booked'
          ? 'Booked · CS Wednesday A lunch'
          : 'Unavailable · CS Wednesday A lunch';
  var description = marker_(date) + '\n' + state.label + '\n';
  if (state.status === 'available')
    description += 'Reserve this date: ' + c.siteUrl + '?date=' + date + '#signup\n';
  description +=
    'School year ' +
    CSW_SCHEDULE.schoolYear +
    '. All times America/New_York.\nQuestions or changes: ' +
    c.contact;
  // No student names, email addresses, topics or private notes on the public calendar.
  // getColor() returns the numeric color ID, not the EventColor enum name.
  var color = state.status === 'available' ? '10' : state.status === 'booked' ? '9' : '8';
  var event = own[0],
    changes = [];
  if (event) {
    // Update the existing event when lunch times change; do not create a duplicate.
    if (+event.getStartTime() !== +at_(date, c.start) || +event.getEndTime() !== +at_(date, c.end))
      changes.push(function () {
        event.setTime(at_(date, c.start), at_(date, c.end));
      });
    if (event.getTitle() !== title)
      changes.push(function () {
        event.setTitle(title);
      });
    if (event.getDescription() !== description)
      changes.push(function () {
        event.setDescription(description);
      });
    if (event.getLocation() !== c.room)
      changes.push(function () {
        event.setLocation(c.room);
      });
    if (String(event.getColor()) !== color)
      changes.push(function () {
        event.setColor(color);
      });
  }
  var writes = event ? changes.length : 2; // One create plus its color; no unconditional updates.
  if (budget && writes > budget.remaining) return { writes: 0, deferred: true };
  if (budget) budget.remaining -= writes;
  if (!event) {
    event = calendar.createEvent(title, at_(date, c.start), at_(date, c.end), {
      description: description,
      location: c.room
    });
    event.setColor(color);
  } else
    changes.forEach(function (change) {
      change();
    });
  if (r && r.syncPending) {
    r.syncPending = false;
    save_(r);
  }
  return { writes: writes, deferred: false };
}
// Run only in the Apps Script editor. The underscore keeps these off the public RPC interface.
function syncCalendar_() {
  return locked_(function () {
    var c = config_(),
      calendar = calendar_(c),
      budget = { remaining: 20 };
    var report = { checkedAt: new Date().toISOString(), checked: 0, writes: 0, deferred: 0 };
    try {
      dates_()
        .filter(function (d) {
          return at_(d, c.end) > new Date();
        })
        .forEach(function (d) {
          var result = syncOne_(d, c, calendar, budget);
          report.checked++;
          report.writes += result.writes;
          if (result.deferred) report.deferred++;
        });
    } catch (e) {
      // Stop on service/quota failure; never repeatedly hammer the remaining dates.
      report.failed = true;
      PropertiesService.getScriptProperties().setProperty(
        'calendarSyncStatus',
        JSON.stringify(report)
      );
      throw e;
    }
    // Large initial setup/reconfiguration continues on the next hourly run.
    // An unchanged calendar uses zero Calendar writes.
    PropertiesService.getScriptProperties().setProperty(
      'calendarSyncStatus',
      JSON.stringify(report)
    );
    return report;
  });
}
function exportBookings_() {
  // Private editor-only export; do not publish or log this data.
  return dates_().map(record_).filter(Boolean);
}
