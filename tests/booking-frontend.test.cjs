const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const widget = fs.readFileSync(path.join(root, 'booking/Widget.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const embed = fs.readFileSync(path.join(root, 'js/csw-booking-embed.js'), 'utf8');
const pause = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const noResponse = Symbol('no response');

class Element {
  constructor() { this.children = []; this.events = {}; this.dataset = {}; this.attributes = {}; this.style = {}; this.value = ''; this.textContent = ''; this.hidden = false; }
  addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
  fire(type, extra = {}) { for (const fn of this.events[type] || []) fn({preventDefault() {}, ...extra}); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  reportValidity() { return true; }
  focus() {}
  scrollIntoView() {}
}

function surface() {
  const elements = new Map(), timers = new Map();
  let timerId = 0;
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = {console, URL, URLSearchParams, crypto, Intl, Date,
    document: {getElementById: get, createElement: () => new Element(), hidden: false},
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, {fn, ms}); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() {},
    location: {search: '', origin: 'http://localhost'},
  };
  context.window = context;
  const fireTimers = ms => { for (const [id, t] of [...timers]) if (t.ms === ms) {timers.delete(id); t.fn();} };
  return {get, context, fireTimers};
}

const schedule = () => ({schoolYear: '2026–27', source: 'https://example.org/calendar', start: '11:55', end: '12:55', room: 'SC2', contact: 'school@example.org', calendarUrl: 'https://calendar.google.com/', slots: [
  {date: '2026-09-30', status: 'available', label: 'Available'},
  {date: '2026-10-07', status: 'available', label: 'Available'}
]});

function app(responses = {}, parameters = {}) {
  const h = surface(), calls = [];
  const defaults = {getAvailability: schedule(), myBookings: [], dashboardAccess:{role:'owner',members:[]}, verifyCode: {token: 'verified'}, requestCode: {message: 'Code sent.'}};
  function runner(success, failure) {
    return new Proxy({}, {get(_, key) {
      if (key === 'withSuccessHandler') return fn => runner(fn, failure);
      if (key === 'withFailureHandler') return fn => runner(success, fn);
      return (...args) => {
        calls.push({name: key, args});
        const queue = responses[key], result = queue && queue.length ? queue.shift() : defaults[key];
        if (result === noResponse) return;
        if (result instanceof Error) failure(result); else success(result);
      };
    }});
  }
  h.context.google = {script: {run: runner(), url: {getLocation(fn) {fn({parameter: parameters});}}}};
  vm.runInNewContext(widget, h.context);
  h.calls = calls;
  h.click = async id => { h.get(id).fire('click'); await pause(); };
  h.submit = async id => { h.get(id).fire('submit'); await pause(); };
  return h;
}

test('stalled availability request releases loading controls and shows a retry path', async () => {
  const h = app({getAvailability: [noResponse]});
  assert.equal(h.get('refresh').disabled, true);
  h.fireTimers(60000); await pause();
  assert.equal(h.get('refresh').disabled, false);
  assert.match(h.get('load-status').textContent, /took too long.*Refresh to retry/);
  assert.equal(h.get('prev').disabled, true);
  await h.click('refresh');
  assert.ok(h.get('calendar').children.length > 7);
});

test('stalled verification email resets busy state without resending automatically', async () => {
  const h = app({requestCode: [noResponse]}); await pause();
  h.get('email').value = 'hcps-test@henricostudents.org';
  await h.click('send-code');
  assert.equal(h.get('send-code').disabled, true);
  h.fireTimers(60000); await pause();
  assert.equal(h.get('send-code').disabled, false);
  assert.match(h.get('message').textContent, /Check your school inbox/);
  assert.equal(h.calls.filter(c => c.name === 'requestCode').length, 1);
});

test('date deep link survives initial availability failure and applies after retry', async () => {
  const h = app({getAvailability: [new Error('Temporary outage'), schedule()]}, {date: '2026-10-07'}); await pause();
  assert.equal(h.get('date').value, '');
  assert.doesNotMatch(h.get('message').textContent, /outside this school year/);
  await h.click('refresh');
  assert.match(h.get('date').value, /October 7/);
  assert.equal(h.get('month').textContent, 'October 2026');
});

test('confirmed reservation remains confirmed when reservation-list read fails', async () => {
  const h = app({myBookings: [[], new Error('Temporary read outage')], bookSlot: [{date: '2026-09-30', id: 'saved-reference', synced: true, invited: true}]}, {date: '2026-09-30'}); await pause();
  await h.click('verify');
  await h.submit('signup');
  assert.match(h.get('message').textContent, /Reserved for/);
  assert.match(h.get('message').textContent, /Reserved for/);assert.doesNotMatch(h.get('message').textContent,/saved-reference/);
  assert.match(h.get('message').textContent, /Could not refresh your reservation list/);
});

test('manual refresh reconciles bookings and clears stale private UI on expired verification', async () => {
  const h = app({myBookings: [[{id: 'r1', date: '2026-09-30', topic: 'Sample'}], new Error('Verification expired. Verify your school email again.')]}); await pause();
  await h.click('verify');
  assert.equal(h.get('email').readOnly, true);
  h.get('edit-form').hidden = false;
  await h.click('refresh');
  assert.equal(h.calls.filter(c => c.name === 'myBookings').length, 2);
  assert.equal(h.get('email').readOnly, false);
  assert.equal(h.get('my-section').hidden, true);
  assert.equal(h.get('edit-form').hidden, true);
  assert.equal(h.get('my-bookings').children.length, 0);
  assert.equal(h.get('save-edit').disabled, true);
});

test('ambiguous booking timeout preserves request ID for an explicit retry', async () => {
  const h = app({bookSlot: [noResponse, {date: '2026-09-30', id: 'same-booking', synced: true, invited: true}]}, {date: '2026-09-30'}); await pause();
  await h.click('verify'); await h.submit('signup');
  h.fireTimers(60000); await pause();
  assert.match(h.get('message').textContent, /may already be saved/);
  assert.equal(h.calls.filter(c => c.name === 'bookSlot').length, 1);
  await h.submit('signup');
  const writes = h.calls.filter(c => c.name === 'bookSlot');
  assert.equal(writes[0].args[0].requestId, writes[1].args[0].requestId);
  assert.match(h.get('message').textContent, /Reserved for/);assert.doesNotMatch(h.get('message').textContent,/same-booking/);
});

test('empty availability response is recoverable, not an uncaught calendar-render error', async () => {
  const h = app({getAvailability: [{slots: []}]}); await pause();
  assert.match(h.get('load-status').textContent, /No school dates/);
  assert.equal(h.get('refresh').disabled, false);
});

test('Google iframe load is not treated as connected until actual widget handshake', () => {
  const h = surface(); const events = {};
  h.context.CSW_BOOKING = {webAppUrl: 'https://script.google.com/a/macros/henricostudents.org/s/abc/exec'};
  h.context.addEventListener = (type, fn) => {events[type] = fn;};
  vm.runInNewContext(embed, h.context);
  h.get('csw-booking').fire('load');
  assert.equal(h.get('csw-setup-notice').hidden, false);
  h.fireTimers(20000);
  assert.match(h.get('csw-setup-notice').textContent, /HCPS school account/);
  const embedId = new URL(h.get('csw-booking').src).searchParams.get('embedId');
  events.message({origin: 'https://evil.example', data: {type: 'csw:resize', embedId, height: 1200}});
  assert.equal(h.get('csw-setup-notice').hidden, false);
  events.message({origin: 'https://test.googleusercontent.com', data: {type: 'csw:resize', embedId: 'wrong', height: 1200}});
  assert.equal(h.get('csw-setup-notice').hidden, false);
  events.message({origin: 'https://test.googleusercontent.com', data: {type: 'csw:resize', embedId, height: 1200}});
  assert.equal(h.get('csw-setup-notice').hidden, true);
  assert.equal(h.get('csw-booking').style.height, '1200px');
});

const descendants=el=>[el,...el.children.flatMap(descendants)];
const rowButton=(h,id,text)=>descendants(h.get(id)).find(el=>el.textContent===text);
const reservation={id:'r1',date:'2026-09-30',name:'Test Student',topic:'Python workshop',activity:'Build a game',details:'Demo and practice',email:'student@henricostudents.org',status:'booked',notification:'sent'};

test('cancellation requires explicit confirmation and shows durable feedback beside the list',async()=>{
  const h=app({verifyCode:[{token:'owner',organizer:true}],organizerBookings:[[reservation],[]],organizerCancelBooking:[{cancelled:true,synced:false,invited:false}]});await pause();await h.click('verify');
  rowButton(h,'organizer-bookings','Cancel signup').fire('click');await pause();
  assert.equal(h.calls.filter(c=>c.name==='organizerCancelBooking').length,0);
  assert.equal(rowButton(h,'organizer-bookings','Confirm cancellation').hidden,false);
  rowButton(h,'organizer-bookings','Keep signup').fire('click');
  assert.equal(rowButton(h,'organizer-bookings','Confirm cancellation').hidden,true);
  rowButton(h,'organizer-bookings','Cancel signup').fire('click');
  rowButton(h,'organizer-bookings','Confirm cancellation').fire('click');await pause();
  assert.equal(h.calls.filter(c=>c.name==='organizerCancelBooking').length,1);
  assert.match(h.get('organizer-status').textContent,/signup itself is cancelled/);
  assert.equal(h.get('organizer-bookings').textContent,'No signups yet.');
});

test('cancellation timeout releases controls and tells the user to check, without retrying a write',async()=>{
  const h=app({verifyCode:[{token:'owner',organizer:true}],organizerBookings:[[reservation]],organizerCancelBooking:[noResponse]});await pause();await h.click('verify');
  rowButton(h,'organizer-bookings','Cancel signup').fire('click');
  rowButton(h,'organizer-bookings','Confirm cancellation').fire('click');await pause();
  h.fireTimers(60000);await pause();
  assert.equal(rowButton(h,'organizer-bookings','Confirm cancellation').disabled,false);
  assert(descendants(h.get('organizer-bookings')).some(el=>/may already be saved/.test(el.textContent)));
  assert.equal(h.calls.filter(c=>c.name==='organizerCancelBooking').length,1);
});

test('only organizer verification loads management; management edits use the protected endpoint',async()=>{
  const h=app({verifyCode:[{token:'owner-token',organizer:true}],organizerBookings:[[reservation],[reservation]],organizerEditBooking:[{invited:true}]});
  await pause();await h.click('verify');assert.equal(h.get('organizer-section').hidden,false);
  rowButton(h,'organizer-bookings','Edit').fire('click');await pause();
  h.get('edit-topic').value='Edited plan';await h.submit('edit-form');
  const call=h.calls.find(c=>c.name==='organizerEditBooking');assert.equal(call.args[0].id,'r1');assert.equal(call.args[0].topic,'Edited plan');
  const student=app();await pause();await student.click('verify');assert(!student.calls.some(c=>c.name==='organizerBookings'));
});

test('organizer cancellation uses protected endpoint and expired auth clears private management UI',async()=>{
  const h=app({verifyCode:[{token:'owner-token',organizer:true}],organizerBookings:[[reservation]],organizerCancelBooking:[new Error('Verification expired. Verify your school email again.')]});
  await pause();await h.click('verify');rowButton(h,'organizer-bookings','Cancel signup').fire('click');
  rowButton(h,'organizer-bookings','Confirm cancellation').fire('click');await pause();
  assert.equal(h.calls.filter(c=>c.name==='organizerCancelBooking').length,1);
  assert.equal(h.get('organizer-section').hidden,true);assert.equal(h.get('organizer-bookings').children.length,0);
  assert.equal(h.get('email').readOnly,false);
});


test('student reservations are read-only and email link carries reservation reference',async()=>{
  const h=app({myBookings:[[reservation]]});await pause();await h.click('verify');
  assert.equal(rowButton(h,'my-bookings','Edit'),undefined);assert.equal(rowButton(h,'my-bookings','Cancel signup'),undefined);
  const link=rowButton(h,'my-bookings','Email organizer about this reservation');
  assert.match(link.href,/^mailto:hcps-joshisr1@henricostudents.org/);
  assert(decodeURIComponent(link.href).includes('Reference: r1'));
  assert(descendants(h.get('my-bookings')).some(el=>el.textContent.includes('remains reserved until')));
  h.get('edit-form').hidden=false;await h.submit('edit-form');
  assert(!h.calls.some(c=>['editBooking','organizerEditBooking','cancelBooking','organizerCancelBooking'].includes(c.name)));
});

test('viewer has read-only cards and owner access changes require review',async()=>{
 const v=app({verifyCode:[{token:'viewer',organizer:true,role:'viewer'}],dashboardAccess:[{role:'viewer',members:[]}],organizerBookings:[[reservation]]});await pause();await v.click('verify');
 assert.equal(v.get('access-panel').hidden,true);assert.equal(rowButton(v,'organizer-bookings','Edit'),undefined);assert.equal(rowButton(v,'organizer-bookings','Cancel signup'),undefined);
 const o=app({verifyCode:[{token:'owner',organizer:true}],organizerBookings:[[]],setDashboardAccess:[{role:'owner',members:[{email:'officer@henricostudents.org',role:'viewer'}]}]});await pause();await o.click('verify');
 o.get('access-email').value='officer@henricostudents.org';o.get('access-role').value='viewer';await o.submit('access-form');
 assert(!o.calls.some(c=>c.name==='setDashboardAccess'));assert.equal(o.get('access-confirm').hidden,false);
 await o.click('access-save');assert.equal(o.calls.filter(c=>c.name==='setDashboardAccess').length,1);
});
