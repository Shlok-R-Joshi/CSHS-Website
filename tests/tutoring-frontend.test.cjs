const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const script = fs.readFileSync(
  path.join(__dirname, "../booking/TutoringPage.html"), "utf8",
).match(/<script>([\s\S]*?)<\/script>/)[1];
const noResponse = Symbol("no response");
const pause = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

// Execute the actual page handlers with a small DOM and controlled Google replies.
function app() {
  const elements = new Map(), all = [], timers = new Map(), calls = [];
  const replies = {}, late = [];
  let timerId = 0;
  class Element {
    constructor(tag = "div") {
      this.tag = tag;
      this.children = [];
      this.style = {};
      this.dataset = {};
      this.elements = {};
      this.value = "";
      this.textContent = "";
      this.hidden = false;
      this.resetCount = 0;
      all.push(this);
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    reset() { this.resetCount++; }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap((child) =>
        typeof child === "string" ? [] : [child, ...child.querySelectorAll("*")],
      );
      return selector === "input:checked"
        ? descendants.filter((e) => e.tag === "input" && e.checked)
        : descendants;
    }
  }
  const get = (id) => {
    if (!elements.has(id)) {
      const e = new Element();
      e.id = id;
      elements.set(id, e);
    }
    return elements.get(id);
  };
  const course = new Element("select");
  course.value = "AP Computer Science A";
  get("help-form").elements.date = new Element("input");
  get("help-form").elements.other = new Element("input");
  get("help-form").data = {
    name: "Student One", course: course.value, other: "",
    details: "Loops\nArrays", date: "2026-10-15",
  };
  get("tutor-form").data = { name: "Tutor One", other: "" };
  let success, failure;
  const runner = new Proxy({}, {
    get(target, method) {
      if (method === "withSuccessHandler") return (fn) => { success = fn; return runner; };
      if (method === "withFailureHandler") return (fn) => { failure = fn; return runner; };
      return (...args) => {
        calls.push({ method, args });
        const result = (replies[method] || []).shift();
        if (result === noResponse) late.push({ success, failure });
        else if (result instanceof Error) failure(result);
        else success(result);
      };
    },
  });
  const context = {
    console, crypto, URLSearchParams, Date, Intl,
    location: { search: "" },
    FormData: class { constructor(form) { return Object.entries(form.data); } },
    document: {
      getElementById: get,
      createElement: (tag) => new Element(tag),
      createTextNode: (text) => text,
      querySelector: (selector) => selector === "select.course" ? course : get("other-course"),
      querySelectorAll: (selector) => selector === ".page"
        ? ["help", "tutor", "mine", "admin"].map(get)
        : selector === "button" ? all.filter((e) => e.tag === "button") : [],
    },
    google: { script: { run: runner, url: { getLocation: (fn) => fn({ parameter: {} }) } } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(script, context);
  for (const id of ["student-times", "tutor-times", "tutor-courses"])
    get(id).querySelectorAll("*").find((e) => e.tag === "input").checked = true;
  return {
    get, replies, calls, late, course,
    async submit(id) {
      const target = get(id);
      target.onsubmit({ preventDefault() {}, target });
      await pause();
    },
    async timeout() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((t) => t.fn());
      await pause();
    },
  };
}

for (const [form, successText] of [
  ["help-form", /Request submitted/],
  ["tutor-form", /Tutor registration received/],
]) {
  test(`${form}: successful submission stays acknowledged when dashboard refresh fails`, async () => {
    const h = app();
    h.replies.tutoringSubmit = [{ id: "saved", status: "pending" }];
    h.replies.tutoringDashboard = [new Error("Network unavailable")];
    await h.submit(form);
    assert.match(h.get("message").textContent, successText);
    assert.match(h.get("message").textContent, /saved; do not submit it again/);
    assert.equal(h.get("mine").hidden, false);
    assert.equal(h.get(form).resetCount, 1);
    assert.equal(h.calls.filter((c) => c.method === "tutoringSubmit").length, 1);
  });

  test(`${form}: ambiguous submission timeout keeps the same retry ID and form contents`, async () => {
    const h = app();
    h.replies.tutoringSubmit = [noResponse, { id: "saved", status: "pending" }];
    h.replies.tutoringDashboard = [{ email: "student@henricostudents.org", role: "", records: [] }];
    await h.submit(form);
    await h.timeout();
    assert.equal(h.get(form).resetCount, 0);
    assert.doesNotMatch(h.get("message").textContent, successText);
    // A late response must not erase the form or silently mark an expired call complete.
    h.late[0].success({ id: "saved", status: "pending" });
    await pause();
    assert.equal(h.get(form).resetCount, 0);
    await h.submit(form);
    const submissions = h.calls.filter((c) => c.method === "tutoringSubmit");
    assert.equal(submissions[0].args[0].requestId, submissions[1].args[0].requestId);
    assert.equal(h.get(form).resetCount, 1);
    assert.match(h.get("message").textContent, successText);
  });
}

test("expired verification after saving preserves acknowledgement while hiding private sessions", async () => {
  const h = app();
  h.get("workspace").hidden = false;
  h.get("verification").hidden = true;
  h.get("my-list").append({ textContent: "private session" });
  h.replies.tutoringSubmit = [{ id: "saved", status: "pending" }];
  h.replies.tutoringDashboard = [new Error("Verification expired")];
  await h.submit("help-form");
  assert.match(h.get("message").textContent, /Request submitted/);
  assert.match(h.get("message").textContent, /Verify your school email again/);
  assert.equal(h.get("workspace").hidden, true);
  assert.equal(h.get("verification").hidden, false);
  assert.equal(h.get("my-list").children.length, 0);
});

test("course starts unselected and an empty choice cannot submit", async () => {
  const h = app();
  assert.equal(h.course.value, "");
  assert.equal(h.course.children[0].textContent, "Select a course");
  h.get("help-form").data.course = "";
  await h.submit("help-form");
  assert.match(h.get("message").textContent, /Select a course/);
  assert.equal(h.calls.length, 0);
});

test("active signups offer a change-request email without editing the reservation", async () => {
  const h = app();
  h.replies.tutoringSubmit = [{ id: "saved", status: "pending" }];
  h.replies.tutoringDashboard = [{
    email: "student@henricostudents.org", role: "", records: [{
      id: "saved", kind: "request", status: "pending", name: "Student One",
      email: "student@henricostudents.org", course: "AP Computer Science A",
      requestedDate: "2026-10-15", availability: ["Thursday|A lunch"], details: "Arrays"
    }]
  }];
  await h.submit("help-form");
  const link = h.get("my-list").querySelectorAll("*").find(e => e.textContent === "Request changes");
  assert.match(link.href, /^mailto:hcps-joshisr1@henricostudents.org\?/);
  assert.match(decodeURIComponent(link.href), /Signup: saved[\s\S]*Requested changes:/);
  assert.deepEqual(h.calls.map(c => c.method), ["tutoringSubmit", "tutoringDashboard"]);
});
