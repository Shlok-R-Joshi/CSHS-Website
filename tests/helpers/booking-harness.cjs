const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.join(__dirname, "../..");
function harness() {
  const props = new Map(
    Object.entries({
      CALENDAR_ID: "test",
      INVITE_CALENDAR_ID: "private-test",
      LUNCH_START: "11:35",
      LUNCH_END: "12:05",
      ROOM: "Test room",
      SITE_URL: "https://example.org/html/CSW.html",
      CONTACT_EMAIL: "officer@example.org",
    }),
  );
  const cache = new Map(),
    events = [],
    mail = [],
    calendarCalls = [];
  let locked = false,
    fail = false,
    inviteFail = false,
    failAfterCreate = false;
  const invites = new Map(),
    inviteCalls = [];
  let now = Date.parse("2026-09-24T16:00:00Z");
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  function calendarWrite(type) {
    calendarCalls.push({ type });
    if (fail) throw Error("Calendar offline");
  }
  const calendar = {
    getEvents(start, end) {
      calendarCalls.push({ type: "read" });
      return events.filter((e) => e.start < end && e.end > start);
    },
    createEvent(title, start, end, opts) {
      calendarWrite("create");
      const e = {
        title,
        start,
        end,
        description: opts.description,
        location: opts.location,
        getDescription() {
          return this.description;
        },
        getTitle() {
          return this.title;
        },
        getLocation() {
          return this.location;
        },
        getStartTime() {
          return this.start;
        },
        getEndTime() {
          return this.end;
        },
        setTime(start, end) {
          calendarWrite("time");
          this.start = start;
          this.end = end;
        },
        getColor() {
          return this.color || "";
        },
        setTitle(t) {
          calendarWrite("title");
          this.title = t;
        },
        setDescription(d) {
          calendarWrite("description");
          this.description = d;
        },
        setLocation(l) {
          calendarWrite("location");
          this.location = l;
        },
        setColor(c) {
          calendarWrite("color");
          this.color = c;
        },
      };
      events.push(e);
      if (failAfterCreate) throw Error("Response lost after event creation");
      return e;
    },
  };
  const context = vm.createContext({
    Date: Clock,
    console: { error() {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => props.get(k) || null,
        getProperties: () => Object.fromEntries(props),
        setProperty(k, v) {
          props.set(k, v);
        },
        setProperties(values) {
          for (const [k, v] of Object.entries(values)) props.set(k, v);
        },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => {
          const v = cache.get(k);
          return v && v.expires > now ? v.value : null;
        },
        put: (k, v, seconds) =>
          cache.set(k, { value: v, expires: now + seconds * 1000 }),
        remove: (k) => cache.delete(k),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock() {
          if (locked) return false;
          locked = true;
          return true;
        },
        releaseLock() {
          locked = false;
        },
      }),
    },
    Calendar: {
      Acl: { list: () => ({ items: [] }) },
      Events: {
        get: (cal, id) => {
          if (inviteFail) throw Error("Service offline");
          if (!invites.has(id)) throw Error("404 Not Found");
          return invites.get(id);
        },
        insert: (event, cal, options) => {
          if (inviteFail) throw Error("Service offline");
          event.htmlLink =
            "https://www.google.com/calendar/event?eid=test-event";
          invites.set(event.id, event);
          inviteCalls.push({ type: "insert", cal, options, event });
          return event;
        },
        patch: (patch, cal, id, options) => {
          if (inviteFail) throw Error("Service offline");
          Object.assign(invites.get(id), patch);
          inviteCalls.push({ type: "patch", cal, options });
          return invites.get(id);
        },
        remove: (cal, id, options) => {
          invites.delete(id);
          inviteCalls.push({ type: "remove", cal, options });
        },
      },
    },
    CalendarApp: {
      getCalendarById: () => calendar,
      EventColor: { GREEN: "green", BLUE: "blue", GRAY: "gray" },
    },
    MailApp: {
      getRemainingDailyQuota: () => 100,
      sendEmail: (...args) => mail.push(args),
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: "sha256" },
      computeDigest: (_, s) =>
        Array.from(crypto.createHash("sha256").update(s).digest()),
      formatDate: (d, tz) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d),
      parseDate: (s, tz) => {
        const naive = new Date(s.replace(" ", "T") + ":00Z");
        const offset = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          timeZoneName: "shortOffset",
        })
          .formatToParts(naive)
          .find((p) => p.type === "timeZoneName").value;
        return new Date(
          naive.getTime() - Number(offset.replace("GMT", "")) * 3600000,
        );
      },
    },
  });
  for (const file of ["Schedule.gs", "Code.gs", "Notifications.gs"])
    vm.runInContext(
      fs.readFileSync(path.join(root, "booking", file), "utf8"),
      context,
    );
  function login(email = "hcps-test@henricostudents.org") {
    context.requestCode(email);
    const code = mail.at(-1)[2].match(/code is (\d{6})/)[1];
    return context.verifyCode(email, code).token;
  }
  function input(token, date = "2026-09-30") {
    return {
      token,
      date,
      name: "Test Presenter",
      topic: "Safe test topic",
      activity: "Build a small program together.",
      details: "A coding workshop.",
      agree: true,
      requestId: crypto.randomUUID(),
    };
  }
  let ownerToken;
  function owner() {
    if (
      !ownerToken ||
      !cache.get("auth:" + context.digest_(ownerToken)) ||
      cache.get("auth:" + context.digest_(ownerToken)).expires <= now
    )
      ownerToken = login("hcps-joshisr1@henricostudents.org");
    return ownerToken;
  }
  return {
    c: context,
    props,
    cache,
    events,
    mail,
    login,
    owner,
    input,
    invites,
    inviteCalls,
    calendarCalls,
    setTime: (v) => (now = Date.parse(v)),
    setInviteFailure: (v) => (inviteFail = v),
    setFailure: (v) => (fail = v),
    setFailAfterCreate: (v) => (failAfterCreate = v),
    setLock: (v) => (locked = v),
  };
}
module.exports = harness;
