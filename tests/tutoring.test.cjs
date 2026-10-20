const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const crypto = require("node:crypto");
const harness = require("./helpers/booking-harness.cjs");
function setup() {
  const h = harness();
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../booking/Tutoring.gs"), "utf8"),
    h.c,
  );
  h.student = h.login("student@henricostudents.org");
  h.tutor = h.login("tutor@henricostudents.org");
  h.request = () => ({
    kind: "request",
    name: "Student One",
    token: h.student,
    requestId: crypto.randomUUID(),
    course: "AP Computer Science A",
    details: "Line one\r\nLine two",
    date: "2026-10-07",
    availability: ["3:0", "4:0"],
  });
  h.registration = () => ({
    kind: "tutor",
    name: "Tutor One",
    token: h.tutor,
    requestId: crypto.randomUUID(),
    courses: ["AP Computer Science A"],
    completed: true,
    availability: ["3:0", "4:0"],
  });
  h.pair = () => {
    const t = h.c.tutoringSubmit(h.registration()),
      r = h.c.tutoringSubmit(h.request());
    return {
      token: h.owner(),
      id: r.id,
      tutorId: t.id,
      date: "2026-10-07",
      period: "0",
      start: "11:55",
      end: "12:25",
      room: "SC2",
      schoolDayConfirmed: true,
    };
  };
  return h;
}

test("busy server rejects a request without side effects and permits the same retry", () => {
  const h = setup(), input = h.request(), before = h.mail.length;
  h.setLock(true);
  assert.throws(() => h.c.tutoringSubmit(input), /being processed/);
  assert.equal(h.c.tutoringRecords_().length, 0);
  assert.equal(h.mail.length, before);
  h.setLock(false);
  h.c.tutoringSubmit(input);
  assert.equal(h.c.tutoringRecords_().length, 1);
});

test("expired verification cannot replay a successful submission or read private records", () => {
  const h = setup(), input = h.request();
  h.c.tutoringSubmit(input);
  h.cache.delete("auth:" + h.c.digest_(h.student));
  const before = h.mail.length;
  assert.throws(() => h.c.tutoringSubmit(input), /expired/);
  assert.throws(() => h.c.tutoringDashboard(h.student), /expired/);
  assert.equal(h.c.tutoringRecords_().length, 1);
  assert.equal(h.mail.length, before);
});

test("revoked manager access takes effect even with an existing verified session", () => {
  const h = setup(), p = h.pair(), token = h.login("manager@henricostudents.org");
  const key = "dashboard-access:manager@henricostudents.org";
  h.props.set(key, JSON.stringify({ role: "manager" }));
  assert.equal(h.c.tutoringDashboard(token).records.length, 2);
  h.props.delete(key);
  assert.equal(h.c.tutoringDashboard(token).records.length, 0);
  assert.throws(() => h.c.tutoringClose(token, p.id, "cancel"), /permission/);
  assert.equal(h.c.tutoringRead_(p.id).status, "pending");
});

test("cancelling during a Calendar outage never sends a delayed approval or creates an invite", () => {
  const h = setup(), p = h.pair();
  h.setInviteFailure(true);
  h.c.tutoringApprove(p);
  h.c.tutoringClose(h.owner(), p.id, "cancel");
  h.setInviteFailure(false);
  h.c.runTutoringReminders_();
  h.c.runTutoringReminders_();
  assert.equal(h.inviteCalls.length, 0);
  assert.equal(h.c.tutoringRead_(p.id).status, "cancelled");
  assert.equal(h.c.tutoringRead_(p.id).mail["approval-0"].status, "skipped");
  assert(!h.mail.some(m => m[0].to === "student@henricostudents.org" && m[0].subject?.includes("session approved")));
});

test("lost cancellation response recovers without a second Calendar deletion", () => {
  const h = setup(), p = h.pair();
  h.c.tutoringApprove(p);
  const remove = h.c.Calendar.Events.remove;
  h.c.Calendar.Events.remove = (...args) => {
    remove(...args);
    throw Error("response lost after deleting event");
  };
  h.c.tutoringClose(h.owner(), p.id, "cancel");
  h.c.runTutoringReminders_();
  assert.equal(h.invites.size, 0);
  assert.equal(h.inviteCalls.filter(c => c.type === "remove").length, 1);
  assert.equal(h.c.tutoringRead_(p.id).inviteStatus, "sent");
});

test("stale approval cannot revive a cancelled request or use a deactivated tutor", () => {
  const h = setup(), p = h.pair();
  h.c.tutoringClose(h.owner(), p.id, "cancel");
  assert.throws(() => h.c.tutoringApprove(p), /no longer pending/);
  const next = h.c.tutoringSubmit(h.request());
  h.c.tutoringClose(h.owner(), p.tutorId, "deactivate");
  assert.throws(() => h.c.tutoringApprove({ ...p, id: next.id }), /active tutor/);
  assert.equal(h.invites.size, 0);
});

test("adjacent sessions are allowed but a one-minute overlap is blocked", () => {
  const h = setup(), p = h.pair();
  h.c.tutoringApprove(p);
  const next = h.c.tutoringSubmit(h.request());
  assert.throws(() => h.c.tutoringApprove({ ...p, id: next.id, start: "12:24", end: "12:55" }), /already has/);
  h.c.tutoringApprove({ ...p, id: next.id, start: "12:25", end: "12:55" });
  assert.equal(h.invites.size, 2);
});

test("quota recovery after the session starts cannot send stale approvals or invitations", () => {
  const h = setup(), p = h.pair();
  h.c.MailApp.getRemainingDailyQuota = () => 0;
  h.setInviteFailure(true);
  h.c.tutoringApprove(p);
  h.setTime("2026-10-07T15:55:00Z");
  h.setInviteFailure(false);
  h.c.MailApp.getRemainingDailyQuota = () => 100;
  h.c.runTutoringReminders_();
  const r = h.c.tutoringRead_(p.id);
  assert.equal(r.inviteStatus, "expired");
  assert.equal(r.mail["approval-0"].status, "skipped");
  assert.equal(h.invites.size, 0);
});

test("full storage rejects new requests before sending receipts and allows retry after space is freed", () => {
  const h = setup(), input = h.request(), before = h.mail.length;
  h.props.set("existing-data", "x".repeat(150000));
  assert.throws(() => h.c.tutoringSubmit(input), /storage/);
  assert.equal(h.c.tutoringRecords_().length, 0);
  assert.equal(h.mail.length, before);
  h.props.delete("existing-data");
  h.c.tutoringSubmit(input);
  assert.equal(h.c.tutoringRecords_().length, 1);
});

test("repeated attendance clicks record hours and the organizer notification only once", () => {
  const h = setup(), p = h.pair();
  h.c.tutoringApprove(p);
  h.setTime("2026-10-07T16:25:00Z");
  const token = h.owner();
  h.c.tutoringClose(token, p.id, "complete");
  const before = h.mail.length, saved = h.props.get("tutoring:" + p.id);
  h.c.tutoringClose(token, p.id, "complete");
  assert.equal(h.c.tutoringRead_(p.id).hours, 0.5);
  assert.equal(h.props.get("tutoring:" + p.id), saved);
  assert.equal(h.mail.length, before);
});

test("winter sessions use Eastern standard time after daylight saving ends", () => {
  const h = setup(), p = h.pair();
  h.c.tutoringApprove({ ...p, date: "2026-11-04" });
  const event = [...h.invites.values()][0];
  assert.equal(event.start.dateTime, "2026-11-04T16:55:00.000Z");
  assert.equal(event.end.dateTime, "2026-11-04T17:25:00.000Z");
  h.setTime("2026-11-04T15:55:00Z");
  h.c.runTutoringReminders_();
  assert.equal(h.mail.filter(m => m[0].subject?.includes("Tutoring reminder")).length, 2);
});

test("approval exactly at session start is rejected without creating an invitation", () => {
  const h = setup(), p = h.pair();
  h.setTime("2026-10-07T15:55:00Z");
  assert.throws(() => h.c.tutoringApprove({ ...p, token: h.owner() }), /future session/);
  assert.equal(h.c.tutoringRead_(p.id).status, "pending");
  assert.equal(h.invites.size, 0);
});

test("approval less than an hour before a session does not send retroactive reminders", () => {
  const h = setup(), p = h.pair();
  h.setTime("2026-10-07T15:10:00Z");
  h.c.tutoringApprove({ ...p, token: h.owner() });
  h.c.runTutoringReminders_();
  assert.equal(h.invites.size, 1);
  assert.equal(h.mail.filter(m => m[0].subject?.includes("Tutoring reminder")).length, 0);
});
test("new request sends receipt and organizer notice, never invites; retries do not duplicate", () => {
  const h = setup(),
    input = h.request(),
    before = h.mail.length;
  const r = h.c.tutoringSubmit(input);
  h.c.tutoringSubmit(input);
  assert.equal(h.c.tutoringRead_(r.id).details, "Line one\nLine two");
  assert.equal(h.mail.length - before, 2);
  assert.equal(h.invites.size, 0);
  assert.equal(h.mail.at(-1)[0].to, h.c.organizerEmail_());
});
test("students only read their own requests; owners and viewers can read the dashboard", () => {
  const h = setup();
  h.pair();
  assert.equal(h.c.tutoringDashboard(h.student).records.length, 1);
  assert.equal(h.c.tutoringDashboard(h.tutor).records.length, 1);
  assert.equal(h.c.tutoringDashboard(h.owner()).records.length, 2);
  assert.throws(() => h.c.tutoringDashboard("invalid"), /expired/);
});
test("verified identity overrides forged emails and users cannot approve or cancel", () => {
  const h = setup(),
    p = h.pair();
  assert.throws(() => h.c.tutoringApprove({ ...p, token: h.student }), /owner/);
  assert.throws(
    () => h.c.tutoringClose(h.student, p.id, "cancel"),
    /permission/,
  );
  h.props.set(
    "dashboard-access:student@henricostudents.org",
    JSON.stringify({ role: "viewer" }),
  );
  assert.throws(
    () => h.c.tutoringClose(h.student, p.id, "cancel"),
    /permission/,
  );
  h.props.set(
    "dashboard-access:student@henricostudents.org",
    JSON.stringify({ role: "manager" }),
  );
  assert.throws(() => h.c.tutoringApprove({ ...p, token: h.student }), /owner/);
  const r = h.c.tutoringSubmit({
    ...h.request(),
    email: "spoof@henricostudents.org",
  });
  assert.equal(h.c.tutoringRead_(r.id).email, "student@henricostudents.org");
});
test("validation rejects invalid dates, weekdays, missing availability, unfinished courses and header injection", () => {
  const h = setup();
  for (const date of [
    "2026-01-01",
    "2026-10-10",
    "2026-11-25",
    "2027-02-30",
    "2028-10-07",
  ])
    assert.throws(() => h.c.tutoringSubmit({ ...h.request(), date }));
  for (const availability of [[], ["9:1"], ["3:7"], ["4:0"]])
    assert.throws(() => h.c.tutoringSubmit({ ...h.request(), availability }));
  assert.throws(
    () => h.c.tutoringSubmit({ ...h.registration(), completed: false }),
    /already taken/,
  );
  assert.throws(
    () => h.c.tutoringSubmit({ ...h.request(), name: "Name\nBcc: attacker" }),
    /valid/,
  );
  assert.throws(
    () => h.c.tutoringSubmit({ ...h.request(), details: "<script>x</script>" }),
    /valid/,
  );
});
test("only one active tutor registration and two open student requests", () => {
  const h = setup();
  h.c.tutoringSubmit(h.registration());
  assert.throws(
    () => h.c.tutoringSubmit(h.registration()),
    /already registered/,
  );
  h.c.tutoringSubmit(h.request());
  h.c.tutoringSubmit(h.request());
  assert.throws(() => h.c.tutoringSubmit(h.request()), /two open/);
});
test("matching needs course eligibility, availability, school-day confirmation and a future valid time", () => {
  const h = setup(),
    p = h.pair();
  for (const update of [
    { period: "1" },
    { date: "2026-10-09" },
    { schoolDayConfirmed: false },
    { start: "25:00" },
    { end: "11:00" },
    { end: "15:00" },
  ])
    assert.throws(() => h.c.tutoringApprove({ ...p, ...update }));
  const tutor = h.c.tutoringRead_(p.tutorId);
  tutor.courses = ["Application Development"];
  h.c.tutoringSave_(tutor);
  assert.throws(() => h.c.tutoringApprove(p), /course/);
  tutor.courses = ["AP Computer Science A"];
  tutor.email = "student@henricostudents.org";
  h.c.tutoringSave_(tutor);
  assert.throws(() => h.c.tutoringApprove(p), /requesting student/);
});
test("approval sends one private two-person invitation and approval emails with calendar links", () => {
  const h = setup(),
    p = h.pair();
  h.c.tutoringApprove(p);
  h.c.tutoringApprove(p);
  assert.equal(h.invites.size, 1);
  assert.equal(h.inviteCalls.filter((c) => c.type === "insert").length, 1);
  const event = [...h.invites.values()][0];
  assert.equal(event.visibility, "private");
  assert.equal(event.attendees.length, 2);
  assert.equal(event.guestsCanModify, false);
  const approvals = h.mail
    .map((m) => m[0])
    .filter(
      (m) =>
        m.subject?.includes("session approved") &&
        m.to !== h.c.organizerEmail_(),
    );
  assert.equal(approvals.length, 2);
  assert(
    approvals.every((m) => m.body.includes("Calendar invitation: https:")),
  );
  assert.equal(h.c.tutoringDashboard(h.tutor).records.length, 2);
});
test("overlapping tutoring and CS Wednesday bookings are blocked for either participant", () => {
  const h = setup(),
    p = h.pair();
  h.c.tutoringApprove(p);
  const r = h.c.tutoringSubmit(h.request());
  assert.throws(() => h.c.tutoringApprove({ ...p, id: r.id }), /already has/);
  h.c.tutoringClose(h.owner(), p.id, "cancel");
  const b = h.c.bookSlot({ ...h.input(h.tutor, "2026-10-07") });
  h.c.organizerApproveBooking(h.owner(), b.id);
  assert.throws(() => h.c.tutoringApprove({ ...p, id: r.id }), /already has/);
});
test("CS Wednesday approval also checks existing tutoring sessions", () => {
  const h = setup(), p = h.pair();
  h.c.tutoringApprove(p);
  const b = h.c.bookSlot(h.input(h.tutor, "2026-10-07"));
  assert.throws(() => h.c.organizerApproveBooking(h.owner(), b.id), /tutoring/i);
});

test("a public invitation calendar prevents approval", () => {
  const h = setup(),
    p = h.pair();
  h.c.Calendar.Acl.list = () => ({
    items: [{ role: "reader", scope: { type: "domain" } }],
  });
  assert.throws(() => h.c.tutoringApprove(p), /must not be/);
  assert.equal(h.c.tutoringRead_(p.id).status, "pending");
});
test("calendar outage preserves approval; retry recovers without duplicate invites", () => {
  const h = setup(),
    p = h.pair();
  h.setInviteFailure(true);
  h.c.tutoringApprove(p);
  assert.equal(h.c.tutoringRead_(p.id).inviteStatus, "pending");
  assert(
    !h.mail.some(
      (m) =>
        m[0].subject?.includes("session approved") &&
        m[0].to === "student@henricostudents.org",
    ),
  );
  h.setInviteFailure(false);
  h.c.runTutoringReminders_();
  h.c.runTutoringReminders_();
  assert.equal(h.invites.size, 1);
});
test("lost Calendar insert response is recovered by the stable event ID", () => {
  const h = setup(),
    p = h.pair(),
    insert = h.c.Calendar.Events.insert;
  h.c.Calendar.Events.insert = (...args) => {
    insert(...args);
    throw Error("response lost");
  };
  h.c.tutoringApprove(p);
  h.c.runTutoringReminders_();
  assert.equal(h.inviteCalls.filter((c) => c.type === "insert").length, 1);
  assert.equal(h.c.tutoringRead_(p.id).inviteStatus, "sent");
});
test("uncertain email sends are not retried; quota shortages retry later", () => {
  const h = setup();
  h.c.MailApp.getRemainingDailyQuota = () => 0;
  const r = h.c.tutoringSubmit(h.request());
  assert.equal(h.c.tutoringRead_(r.id).mail.receipt.status, "pending");
  let attempts = 0;
  h.c.MailApp.getRemainingDailyQuota = () => 100;
  h.c.MailApp.sendEmail = () => {
    attempts++;
    throw Error("response lost");
  };
  h.c.runTutoringReminders_();
  h.c.runTutoringReminders_();
  assert.equal(attempts, 2);
  assert.equal(h.c.tutoringRead_(r.id).mail.receipt.status, "unknown");
});
test("cancellation removes invitation once; decline before matching never creates one", () => {
  const h = setup(),
    p = h.pair();
  h.c.tutoringApprove(p);
  h.c.tutoringClose(h.owner(), p.id, "cancel");
  h.c.tutoringClose(h.owner(), p.id, "cancel");
  assert.equal(h.invites.size, 0);
  assert.equal(h.inviteCalls.filter((c) => c.type === "remove").length, 1);
  const r = h.c.tutoringSubmit(h.request());
  h.c.tutoringClose(h.owner(), r.id, "cancel");
  assert.equal(h.invites.size, 0);
});
test("attendance is only recorded after session ends; deactivation preserves assigned sessions", () => {
  const h = setup(),
    p = h.pair();
  h.c.tutoringApprove(p);
  assert.throws(() => h.c.tutoringClose(h.owner(), p.id, "complete"), /after/);
  h.c.tutoringClose(h.owner(), p.tutorId, "deactivate");
  assert.equal(h.c.tutoringRead_(p.id).status, "approved");
  h.setTime("2026-10-07T17:00:00Z");
  h.c.tutoringClose(h.owner(), p.id, "complete");
  assert.equal(h.c.tutoringRead_(p.id).hours, 0.5);
});
test("day-before and hour-before reminders send once and stop on cancellation", () => {
  const h = setup(),
    p = h.pair();
  h.c.tutoringApprove(p);
  h.setTime("2026-10-06T15:55:00Z");
  h.c.runTutoringReminders_();
  h.c.runTutoringReminders_();
  assert.equal(
    h.mail.filter((m) => m[0].subject?.includes("Tutoring reminder")).length,
    2,
  );
  h.setTime("2026-10-07T14:55:00Z");
  h.c.runTutoringReminders_();
  assert.equal(
    h.mail.filter((m) => m[0].subject?.includes("Tutoring reminder")).length,
    4,
  );
  h.c.tutoringClose(h.owner(), p.id, "cancel");
  h.c.runTutoringReminders_();
  assert.equal(
    h.mail.filter((m) => m[0].subject?.includes("Tutoring reminder")).length,
    4,
  );
});
test("maximum-length plans fit a Script Property even with all notifications queued", () => {
  const h = setup();
  h.owner();
  h.c.MailApp.getRemainingDailyQuota = () => 0;
  const t = h.c.tutoringSubmit(h.registration()),
    r = h.c.tutoringSubmit({ ...h.request(), details: "é".repeat(1000) });
  h.c.tutoringApprove({
    token: h.owner(),
    id: r.id,
    tutorId: t.id,
    date: "2026-10-07",
    period: "0",
    start: "11:55",
    end: "12:25",
    room: "SC2",
    schoolDayConfirmed: true,
  });
  h.setTime("2026-10-06T15:55Z");
  h.c.runTutoringReminders_();
  h.setTime("2026-10-07T14:55Z");
  h.c.runTutoringReminders_();
  assert(Buffer.byteLength(h.props.get("tutoring:" + r.id), "utf8") < 9000);
});
