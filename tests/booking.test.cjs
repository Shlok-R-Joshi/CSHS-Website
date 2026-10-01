const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.join(__dirname,'..');
function harness(){
  const props=new Map(Object.entries({CALENDAR_ID:'test',INVITE_CALENDAR_ID:'private-test',LUNCH_START:'11:35',LUNCH_END:'12:05',ROOM:'Test room',SITE_URL:'https://example.org/html/CSW.html',CONTACT_EMAIL:'officer@example.org'}));
  const cache=new Map(),events=[],mail=[],calendarCalls=[];let locked=false,fail=false,inviteFail=false,failAfterCreate=false;const invites=new Map(),inviteCalls=[];
  let now=Date.parse('2026-09-24T16:00:00Z');
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));} static now(){return now;}}
  function calendarWrite(type){calendarCalls.push({type});if(fail)throw Error('Calendar offline');}
  const calendar={getEvents(start,end){calendarCalls.push({type:'read'});return events.filter(e=>e.start<end&&e.end>start);},createEvent(title,start,end,opts){
    calendarWrite('create');
    const e={title,start,end,description:opts.description,location:opts.location,
      getDescription(){return this.description;},getTitle(){return this.title;},getLocation(){return this.location;},getColor(){return this.color||'';},
      setTitle(t){calendarWrite('title');this.title=t;},setDescription(d){calendarWrite('description');this.description=d;},setLocation(l){calendarWrite('location');this.location=l;},setColor(c){calendarWrite('color');this.color=c;}};
    events.push(e);if(failAfterCreate)throw Error('Response lost after event creation');return e;
  }};
  const context=vm.createContext({Date:Clock,console:{error(){}},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,getProperties:()=>Object.fromEntries(props),setProperty(k,v){props.set(k,v);}})},
    CacheService:{getScriptCache:()=>({get:k=>{const v=cache.get(k);return v&&v.expires>now?v.value:null;},put:(k,v,seconds)=>cache.set(k,{value:v,expires:now+seconds*1000}),remove:k=>cache.delete(k)})},
    LockService:{getScriptLock:()=>({tryLock(){if(locked)return false;locked=true;return true;},releaseLock(){locked=false;}})},
    Calendar:{Acl:{list:()=>({items:[]})},Events:{get:(cal,id)=>{if(inviteFail)throw Error('Service offline');if(!invites.has(id))throw Error('404 Not Found');return invites.get(id);},insert:(event,cal,options)=>{if(inviteFail)throw Error('Service offline');event.htmlLink='https://www.google.com/calendar/event?eid=test-event';invites.set(event.id,event);inviteCalls.push({type:'insert',cal,options,event});return event;},patch:(patch,cal,id,options)=>{if(inviteFail)throw Error('Service offline');Object.assign(invites.get(id),patch);inviteCalls.push({type:'patch',cal,options});return invites.get(id);},remove:(cal,id,options)=>{invites.delete(id);inviteCalls.push({type:'remove',cal,options});}}},
    CalendarApp:{getCalendarById:()=>calendar,EventColor:{GREEN:'green',BLUE:'blue',GRAY:'gray'}},
    MailApp:{getRemainingDailyQuota:()=>100,sendEmail:(...args)=>mail.push(args)},
    Utilities:{getUuid:()=>crypto.randomUUID(),DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,s)=>Array.from(crypto.createHash('sha256').update(s).digest()),
      formatDate:(d,tz)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz}).format(d),
      parseDate:(s,tz)=>{const naive=new Date(s.replace(' ','T')+':00Z');const offset=new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'shortOffset'}).formatToParts(naive).find(p=>p.type==='timeZoneName').value;return new Date(naive.getTime()-Number(offset.replace('GMT',''))*3600000);}}
  });
  for(const file of ['Schedule.gs','Code.gs','Notifications.gs'])vm.runInContext(fs.readFileSync(path.join(root,'booking',file),'utf8'),context);
  function login(email='hcps-test@henricostudents.org'){context.requestCode(email);const code=mail.at(-1)[2].match(/code is (\d{6})/)[1];return context.verifyCode(email,code).token;}
  function input(token,date='2026-09-30'){return {token,date,name:'Test Presenter',topic:'Safe test topic',activity:'Build a small program together.',details:'A coding workshop.',agree:true,requestId:crypto.randomUUID()};}
  let ownerToken;
  function owner(){if(!ownerToken || !cache.get('auth:'+context.digest_(ownerToken)) || cache.get('auth:'+context.digest_(ownerToken)).expires<=now)ownerToken=login('hcps-joshisr1@henricostudents.org');return ownerToken;}
  return {c:context,props,cache,events,mail,login,owner,input,invites,inviteCalls,calendarCalls,setTime:v=>now=Date.parse(v),setInviteFailure:v=>inviteFail=v,setFailure:v=>fail=v,setFailAfterCreate:v=>failAfterCreate=v,setLock:v=>locked=v};
}
test('schedule covers all Wednesdays, with verified holidays and half-day excluded',()=>{
  const {c}=harness(),days=c.dates_();assert.equal(days[0],'2026-08-26');assert.equal(days.at(-1),'2027-06-02');
  assert.equal(days.length,41);assert(days.every(d=>new Date(d+'T12:00:00Z').getUTCDay()===3));
  for(const d of ['2026-11-25','2026-12-23','2026-12-30','2027-03-10','2027-03-31','2026-10-28'])assert.equal(c.getAvailability().slots.find(s=>s.date===d).status,'closed');
});
test('reject non-school emails and wrong/expired codes; verification is one use',()=>{
  const h=harness();assert.throws(()=>h.c.requestCode('bad@example.org'),/school email/);h.c.requestCode('test@henricostudents.org');
  for(let n=0;n<5;n++)assert.throws(()=>h.c.verifyCode('test@henricostudents.org','xxxxxx'),/Incorrect/);
  assert.throws(()=>h.c.verifyCode('test@henricostudents.org','123456'),/expired/);
  const token=h.login();assert(token);assert.throws(()=>h.c.verifyCode('hcps-test@henricostudents.org','123456'),/expired/);
});
test('reservation updates public event without PII; retry is idempotent',()=>{
  const h=harness(),token=h.login(),input=h.input(token);const r=h.c.bookSlot(input);assert.equal(r.synced,true);
  const retry=h.c.bookSlot(input);assert.equal(retry.id,r.id);assert.equal(h.events.length,1);
  assert.match(h.events[0].title,/Booked/);const pub=JSON.stringify(h.c.getAvailability())+JSON.stringify(h.events);
  for(const secret of [input.details,input.activity,'hcps-test@henricostudents.org'])assert(!pub.includes(secret));
  const slot=h.c.getAvailability().slots.find(s=>s.date===r.date);assert.equal(slot.name,input.name);assert.equal(slot.topic,input.topic);
  assert(!JSON.stringify(h.events).includes(input.name));
});
test('duplicate, invalid, holiday, past, and calendar-conflicting dates are refused',()=>{
  const h=harness(),t=h.login();h.c.bookSlot(h.input(t));
  for(const d of ['2026-09-30','2026-11-25','2026-10-28','2026-09-23','2026-09-29','2027-06-09'])assert.throws(()=>h.c.bookSlot(h.input(t,d)));
  h.events.push({start:new Date('2026-10-07T15:30Z'),end:new Date('2026-10-07T16:30Z'),getDescription:()=>''});
  assert.throws(()=>h.c.bookSlot(h.input(t,'2026-10-07')),/no longer available/);
});
test('cancellation requires verified owner and reopens same event',()=>{
  const h=harness(),t=h.login(),r=h.c.bookSlot(h.input(t));const other=h.login('other@henricostudents.org');
  assert.throws(()=>h.c.organizerCancelBooking(other,r.id),/organizer/);assert.equal(h.c.myBookings(other).length,0);
  h.c.organizerCancelBooking(h.owner(),r.id);assert.equal(h.c.myBookings(t).length,0);assert.match(h.events[0].description,/\?date=2026-09-30#signup/);
  h.c.bookSlot(h.input(other));assert.equal(h.events.length,1);
});
test('calendar failure retains booking, blocks duplicates, and repairs on sync',()=>{
  const h=harness(),t=h.login();h.setFailure(true);const input=h.input(t),r=h.c.bookSlot(input);assert.equal(r.synced,false);
  assert.equal(h.c.getAvailability().slots.find(s=>s.date===input.date).status,'booked');
  assert.throws(()=>h.c.bookSlot(h.input(t)),/no longer available/);
  h.setFailure(false);const retry=h.c.bookSlot(input);assert.equal(retry.id,r.id);assert.equal(retry.synced,true);
});
test('lock contention refuses writes and future booking limit is enforced',()=>{
  const h=harness(),t=h.login();h.setLock(true);assert.throws(()=>h.c.bookSlot(h.input(t)),/Another signup/);h.setLock(false);
  h.c.bookSlot(h.input(t));h.c.bookSlot(h.input(t,'2026-10-07'));assert.throws(()=>h.c.bookSlot(h.input(t,'2026-10-14')),/two upcoming/);
});
test('calendar sync is idempotent, keeps other events, and handles DST',()=>{
  const h=harness();while(h.c.syncCalendar_().deferred){}const n=h.events.length;
  h.events.push({start:new Date('2026-10-07T12:00Z'),end:new Date('2026-10-07T13:00Z'),getDescription:()=>''});
  h.calendarCalls.length=0;const report=h.c.syncCalendar_();assert.equal(h.events.length,n+1);
  assert.equal(report.writes,0);assert.equal(h.calendarCalls.filter(call=>call.type!=='read').length,0);
  assert.equal(h.c.at_('2026-10-07','11:35').toISOString(),'2026-10-07T15:35:00.000Z');
  assert.equal(h.c.at_('2026-11-04','11:35').toISOString(),'2026-11-04T16:35:00.000Z');
});

test('initial calendar sync is bounded and resumes without rewriting unchanged events',()=>{
  const h=harness();let report,previous=0,runs=0;
  do {
    h.calendarCalls.length=0;report=h.c.syncCalendar_();runs++;
    const writes=h.calendarCalls.filter(call=>call.type!=='read');
    assert(writes.length<=20);assert.equal(writes.length,report.writes);
    assert.equal(writes.filter(call=>call.type==='create').length,h.events.length-previous);
    assert(writes.every(call=>['create','color'].includes(call.type)));previous=h.events.length;
  }while(report.deferred && runs<10);
  assert(runs>1);assert.equal(report.deferred,0);
  assert.equal(h.events.length,h.c.dates_().filter(d=>h.c.at_(d,'12:05')>new h.c.Date()).length);
  assert.equal(JSON.parse(h.props.get('calendarSyncStatus')).deferred,0);
});

test('changed status writes only changed fields; a retry performs no writes',()=>{
  const h=harness(),t=h.login(),input=h.input(t);h.c.syncOne_(input.date,h.c.config_(),h.c.calendar_(h.c.config_()));
  h.calendarCalls.length=0;h.c.bookSlot(input);
  assert.deepEqual(h.calendarCalls.filter(call=>call.type!=='read').map(call=>call.type),['title','description','color']);
  h.calendarCalls.length=0;h.c.bookSlot(input);
  assert.equal(h.calendarCalls.filter(call=>call.type!=='read').length,0);
});

test('lost creation response repairs the same event and retains sync pending until complete',()=>{
  const h=harness(),t=h.login(),input=h.input(t);h.setFailAfterCreate(true);
  assert.equal(h.c.bookSlot(input).synced,false);assert.equal(h.events.length,1);
  assert.equal(h.c.myBookings(t)[0].syncPending,true);
  h.setFailAfterCreate(false);h.calendarCalls.length=0;assert.equal(h.c.bookSlot(input).synced,true);
  assert.equal(h.events.length,1);assert.deepEqual(h.calendarCalls.filter(call=>call.type!=='read').map(call=>call.type),['color']);
  assert.equal(h.c.myBookings(t)[0].syncPending,false);
});

test('calendar service failure stops the sweep and records failure without losing reservations',()=>{
  const h=harness(),t=h.login(),r=h.c.bookSlot(h.input(t));h.setFailure(true);h.calendarCalls.length=0;
  assert.throws(()=>h.c.syncCalendar_(),/offline/);
  assert.equal(h.calendarCalls.filter(call=>call.type!=='read').length,1);
  assert.equal(JSON.parse(h.props.get('calendarSyncStatus')).failed,true);
  assert.equal(h.c.myBookings(t)[0].id,r.id);
});

test('notification tick retries a failed invitation only once and skips irrelevant calendar reads',()=>{
  const h=harness(),t=h.login();h.setInviteFailure(true);h.c.bookSlot(h.input(t));let attempts=0;
  h.c.Calendar.Events.get=()=>{attempts++;throw Error('Service offline');};
  h.calendarCalls.length=0;h.c.notificationsTick_();assert.equal(attempts,1);
  assert.equal(h.calendarCalls.length,0); // No reminder is due five days before the session.
});
test('server-side validation, expired auth and unavailable config fail closed',()=>{
  const h=harness(),t=h.login();assert.throws(()=>h.c.bookSlot({...h.input(t),topic:'<script>alert(1)</script>'}),/valid topic/);
  assert.throws(()=>h.c.bookSlot({...h.input(t),agree:false}),/confirm/);assert.throws(()=>h.c.bookSlot(h.input('invalid')),/expired/);
  h.props.delete('ROOM');assert.throws(()=>h.c.getAvailability(),/not connected/);
});
test('private invitation sent once, cancellation notifies, rebooking creates a new invitation',()=>{
  const h=harness(),t=h.login(),input=h.input(t),r=h.c.bookSlot(input);assert.equal(r.invited,true);
  h.c.bookSlot(input);assert.equal(h.inviteCalls.length,1);
  const invite=h.inviteCalls[0];assert.equal(invite.cal,'private-test');assert.equal(invite.options.sendUpdates,'all');
  assert.equal(invite.event.attendees[0].email,'hcps-test@henricostudents.org');assert.equal(invite.event.visibility,'private');
  assert.equal(invite.event.guestsCanSeeOtherGuests,false);
  h.c.organizerCancelBooking(h.owner(),r.id);assert.equal(h.inviteCalls[1].type,'remove');assert.equal(h.inviteCalls[1].options.sendUpdates,'all');
  h.c.bookSlot(h.input(t));assert.equal(h.invites.size,1);assert.notEqual(h.inviteCalls[2].event.id,invite.event.id);
});
test('reminders send once in each window and stop after cancellation',()=>{
  const h=harness(),t=h.login(),r=h.c.bookSlot(h.input(t));const initial=h.mail.length;
  h.setTime('2026-09-29T15:40:00Z');h.c.notificationsTick_();h.c.notificationsTick_();assert.equal(h.mail.length,initial+1);
  assert.match(h.mail.at(-1)[0].subject,/tomorrow/);
  h.setTime('2026-09-30T14:40:00Z');h.c.notificationsTick_();h.c.notificationsTick_();assert.equal(h.mail.length,initial+2);
  assert.match(h.mail.at(-1)[0].subject,/about an hour/);
  const fresh=h.owner();h.c.organizerCancelBooking(fresh,r.id);h.c.notificationsTick_();assert.equal(h.mail.length,initial+4); // new OTP and organizer cancellation notice; no extra reminder
});
test('pending invitation repairs without losing a reservation',()=>{
  const h=harness(),t=h.login();h.setInviteFailure(true);const r=h.c.bookSlot(h.input(t));assert.equal(r.invited,false);
  assert.equal(r.confirmation,'pending');assert(!h.mail.some(x=>x[0].subject?.includes('Reservation confirmation')));
  assert.equal(h.c.myBookings(t).length,1);h.setInviteFailure(false);h.c.notificationsTick_();assert.equal(h.invites.size,1);
  assert.equal(h.c.confirmationStatus_(r.id),'sent');
  h.c.notificationsTick_();assert.equal(h.inviteCalls.length,1);
});
test('no reminder for short-notice bookings, closures, or cancelled bookings',()=>{
  const h=harness(),c=h.c.config_();const r={date:'2026-09-30',createdAt:'2026-09-30T15:00:00Z',status:'booked'};
  assert.equal(h.c.reminderDue_(r,1,Date.parse('2026-09-30T15:10Z'),c),false);
  r.createdAt='2026-09-24T15:00Z';r.status='cancelled';assert.equal(h.c.reminderDue_(r,1,Date.parse('2026-09-30T15:10Z'),c),false);
  r.status='booked';c.overrides[r.date]='Closure';assert.equal(h.c.reminderDue_(r,1,Date.parse('2026-09-30T15:10Z'),c),false);
});
test('public or domain-shared invitation calendar fails closed',()=>{
  const h=harness(),t=h.login();h.c.Calendar.Acl.list=()=>({items:[{role:'reader',scope:{type:'default'}}]});
  assert.equal(h.c.bookSlot(h.input(t)).invited,false);assert.equal(h.invites.size,0);
});


test('only verified organizer edits an active booking; invitation updates once and retries safely',()=>{
  const h=harness(),token=h.login(),r=h.c.bookSlot(h.input(token));
  const other=h.login('other@henricostudents.org');
  const edit={token,id:r.id,name:'Updated group',topic:'New topic',activity:'Updated activity',details:'Updated outline'};
  assert.throws(()=>h.c.organizerEditBooking({...edit,token:other}),/organizer/);
  h.setInviteFailure(true);assert.equal(h.c.organizerEditBooking({...edit,token:h.owner()}).invited,false);
  assert.equal(h.c.myBookings(token)[0].details,'Updated outline');
  h.setInviteFailure(false);h.c.notificationsTick_();
  assert.equal(h.invites.get(h.c.invitationId_(r.id)).summary,'CS Wednesday: New topic');
  h.c.organizerEditBooking({...edit,token:h.owner()});assert.equal(h.inviteCalls.filter(c=>c.type==='patch').length,1);
  assert.equal(h.c.getAvailability().slots.find(s=>s.date===r.date).status,'booked');
  assert(!JSON.stringify(h.events).includes('New topic'));
  h.c.organizerCancelBooking(h.owner(),r.id);assert.throws(()=>h.c.organizerEditBooking({...edit,token:h.owner()}),/not found/);
});

test('activity plan is required and stored privately',()=>{const h=harness(),token=h.login();const input=h.input(token);assert.throws(()=>h.c.bookSlot({...input,activity:''}),/activity plan/);h.c.bookSlot(input);assert.equal(h.c.myBookings(token)[0].activity,input.activity);assert(!JSON.stringify(h.c.getAvailability()).includes(input.activity));});

test('cancellation succeeds even when calendar lookup fails, and can be safely retried',()=>{
  const h=harness(),t=h.login(),r=h.c.bookSlot(h.input(t));
  h.c.CalendarApp.getCalendarById=()=>{throw Error('Calendar unavailable');};
  h.setInviteFailure(true);
  const result=h.c.organizerCancelBooking(h.owner(),r.id);
  assert.equal(result.cancelled,true);assert.equal(result.synced,false);assert.equal(result.invited,false);
  assert.equal(h.c.myBookings(t).length,0);assert.equal(h.c.record_(r.date).status,'cancelled');
  const mailCount=h.mail.length;h.c.organizerCancelBooking(h.owner(),r.id);assert.equal(h.mail.length,mailCount);
});

test('retrying old cancellation after another group rebooks never cancels the new group',()=>{
  const h=harness(),t=h.login(),old=h.c.bookSlot(h.input(t));h.c.organizerCancelBooking(h.owner(),old.id);
  const other=h.login('other@henricostudents.org'),fresh=h.c.bookSlot(h.input(other));
  assert.equal(h.c.organizerCancelBooking(h.owner(),old.id).cancelled,true);
  assert.equal(h.c.record_(old.date).id,fresh.id);assert.equal(h.c.record_(old.date).status,'booked');
  assert.equal(h.invites.size,1);
});

test('organizer endpoints reject other verified students and expired tokens',()=>{
  const h=harness(),student=h.login(),r=h.c.bookSlot(h.input(student));
  for(const token of [student,'bad-token']) {
    assert.throws(()=>h.c.organizerBookings(token),/organizer|expired/);
    assert.throws(()=>h.c.organizerCancelBooking(token,r.id),/organizer|expired/);
    assert.throws(()=>h.c.organizerEditBooking({...h.input(token),id:r.id}),/organizer|expired/);
  }
  assert.equal(h.c.record_(r.date).status,'booked');
});

test('verified school organizer sees history, edits another student, and cancels started sessions',()=>{
  const h=harness(),student=h.login(),r=h.c.bookSlot(h.input(student));
  const owner=h.login('hcps-joshisr1@henricostudents.org');
  assert.equal(h.c.organizerBookings(owner)[0].email,'hcps-test@henricostudents.org');
  h.c.organizerEditBooking({...h.input(owner),id:r.id,topic:'Organizer corrected topic'});
  assert.equal(h.c.myBookings(student)[0].topic,'Organizer corrected topic');
  h.setTime('2026-09-30T16:00Z');const fresh=h.login('hcps-joshisr1@henricostudents.org');
  h.c.organizerCancelBooking(fresh,r.id);
  const row=h.c.organizerBookings(fresh)[0];assert.equal(row.status,'cancelled');assert.equal(row.syncPending,false);
});

test('organizer email goes only to the school owner and retries do not duplicate notices',()=>{
  const h=harness(),t=h.login(),input=h.input(t),r=h.c.bookSlot(input);
  const notices=()=>h.mail.filter(args=>args[0] && args[0].to===h.c.organizerEmail_());
  assert.equal(notices().length,1);const notice=notices()[0][0];
  assert.match(notice.subject,/New signup/);assert.match(notice.body,/Test Presenter/);
  assert.match(notice.body,/Build a small program/);assert.match(notice.body,/\?manage=1#organizer/);
  assert(!notice.body.includes(t));h.c.bookSlot(input);h.c.notificationsTick_();assert.equal(notices().length,1);
  const edit={...input,id:r.id,topic:'New topic'};h.c.organizerEditBooking({...edit,token:h.owner()});h.c.organizerEditBooking({...edit,token:h.owner()});
  assert.equal(notices().length,2);h.c.organizerCancelBooking(h.owner(),r.id);h.c.organizerCancelBooking(h.owner(),r.id);assert.equal(notices().length,3);
});

test('quota exhaustion queues notices; ambiguous send errors do not rollback or repeatedly email',()=>{
  const h=harness(),t=h.login();h.c.MailApp.getRemainingDailyQuota=()=>0;
  const r=h.c.bookSlot(h.input(t)),key='organizer-notice:'+r.id+':1';
  assert.equal(JSON.parse(h.props.get(key)).status,'pending');
  h.c.MailApp.getRemainingDailyQuota=()=>100;let sends=0;
  h.c.MailApp.sendEmail=()=>{sends++;throw Error('Lost mail response');};
  h.c.notificationsTick_();h.c.notificationsTick_();
  assert.equal(sends,2);assert.equal(JSON.parse(h.props.get(key)).status,'unknown');assert.equal(h.c.confirmationStatus_(r.id),'unknown');
  assert.equal(h.c.myBookings(t).length,1);
});

test('outbox never sends a notice for an uncommitted reservation',()=>{
  const h=harness();h.c.queueOrganizerNotice_({id:'uncommitted',revision:1,date:'2026-10-07'},'New signup',h.c.config_());
  h.c.deliverOrganizerNotices_(h.c.config_());assert.equal(h.mail.length,0);
});


test('student mutation endpoints are disabled even for the booking owner or a stale client',()=>{
  const h=harness(),t=h.login(),r=h.c.bookSlot(h.input(t));
  const before=JSON.stringify(h.c.record_(r.date)),count=h.mail.length;
  for(const token of [t,'invalid',h.owner()]) {
    assert.throws(()=>h.c.editBooking({...h.input(token),id:r.id,topic:'Not allowed'}),/Students cannot edit.*hcps-joshisr1/);
    assert.throws(()=>h.c.cancelBooking(token,r.id),/Students cannot cancel.*hcps-joshisr1/);
  }
  assert.equal(JSON.stringify(h.c.record_(r.date)),before);
  assert.equal(h.c.myBookings(t).length,1);
});

test('reservation detail confirmation goes once to verified student with school reply-to',()=>{
  const h=harness(),t=h.login(),input=h.input(t),r=h.c.bookSlot(input);
  const confirmations=()=>h.mail.filter(x=>x[0].subject?.includes('Reservation confirmation'));
  assert.equal(r.confirmation,'sent');assert.equal(confirmations().length,1);
  const m=confirmations()[0][0];assert.equal(m.to,'hcps-test@henricostudents.org');assert.equal(m.replyTo,h.c.organizerEmail_());
  assert.match(m.body,/Open your calendar invitation: https:\/\/www.google.com\/calendar\/event/);
  assert.doesNotMatch(m.body,/Reference:|View your reservation:|date and reference/);
  for(const value of [r.date,'11:35','12:05','Test room',input.name,input.topic,input.activity,input.details])assert(m.body.includes(value));
  assert.match(m.body,/Students cannot edit or cancel online/);assert.match(m.body,/not approval/);assert(!m.body.includes(t));
  h.c.bookSlot(input);h.c.notificationsTick_();assert.equal(confirmations().length,1);
  assert.match(h.invites.get(h.c.invitationId_(r.id)).description,/Changes or cancellation: email/);
});

test('queued confirmation uses current details, retries quota shortage, never confirms cancelled slots',()=>{
  const h=harness(),t=h.login(),owner=h.owner();h.c.MailApp.getRemainingDailyQuota=()=>0;
  const r=h.c.bookSlot(h.input(t));assert.equal(r.confirmation,'pending');
  h.c.organizerEditBooking({...h.input(owner),id:r.id,topic:'Corrected before delivery'});
  h.c.MailApp.getRemainingDailyQuota=()=>100;h.c.notificationsTick_();
  assert.match(h.mail.find(x=>x[0].subject?.includes('Reservation confirmation'))[0].body,/Corrected before delivery/);
  h.c.MailApp.getRemainingDailyQuota=()=>0;const second=h.c.bookSlot(h.input(t,'2026-10-07'));
  h.c.organizerCancelBooking(owner,second.id);h.c.MailApp.getRemainingDailyQuota=()=>100;h.c.notificationsTick_();
  assert.equal(h.c.confirmationStatus_(second.id),'skipped');
  assert.equal(h.mail.filter(x=>x[0].subject?.includes('Reservation confirmation')).length,1);
});

test('confirmation jobs never email uncommitted bookings or retroactively email older bookings',()=>{
  const h=harness();h.c.queueConfirmation_({id:'not-saved'});h.c.deliverConfirmations_(h.c.config_());assert.equal(h.mail.length,0);
  h.c.save_({id:'legacy',date:'2026-10-07',status:'booked',email:'legacy@henricostudents.org',createdAt:'2026-09-24T10:00:00Z'});
  h.c.deliverConfirmations_(h.c.config_());assert.equal(h.mail.length,0);
});


test('verification permits ten spaced codes per address while retaining cooldown and daily cap',()=>{
  const h=harness(),email='limit-test@henricostudents.org';
  for(let i=0;i<10;i++){
    h.setTime('2026-09-24T16:'+String(i).padStart(2,'0')+':00Z');h.c.requestCode(email);
    assert.throws(()=>h.c.requestCode(email),/Wait one minute/);
  }
  h.setTime('2026-09-24T16:10:00Z');assert.throws(()=>h.c.requestCode(email),/10 codes/);
  h.setTime('2026-09-24T22:10:00Z');h.c.requestCode(email);
  h.props.set('mailBudget',JSON.stringify({date:'2026-09-24',count:40}));
  assert.throws(()=>h.c.requestCode('another@henricostudents.org'),/Today.s verification-email allowance/);
});

test('only organizer destination bypasses count caps, without bypassing OTP, cooldown or Google quota',()=>{
  const h=harness(),email='hcps-joshisr1@henricostudents.org';
  h.props.set('mailBudget',JSON.stringify({date:'2026-09-24',count:40}));
  for(let i=0;i<12;i++){
    h.setTime('2026-09-24T16:'+String(i).padStart(2,'0')+':00Z');
    h.c.requestCode(email);
    assert.throws(()=>h.c.requestCode(email),/Wait one minute/);
  }
  assert.equal(JSON.parse(h.props.get('mailBudget')).count,40);
  assert.throws(()=>h.c.requestCode('hcps-joshisr1+other@henricostudents.org'),/Today.s verification-email allowance/);
  assert.throws(()=>h.c.verifyCode(email,'wrong'),/Incorrect code/);
  h.setTime('2026-09-24T16:12:00Z');h.c.MailApp.getRemainingDailyQuota=()=>0;
  assert.throws(()=>h.c.requestCode(email),/Google.s email sending quota/);
  assert.equal(h.mail.length,12);
});

test('owner grants roles; managers cannot delegate; revocation and downgrade affect existing tokens',()=>{
 const h=harness(),owner=h.owner(),student=h.login('officer@henricostudents.org');
 assert.throws(()=>h.c.setDashboardAccess(student,'other@henricostudents.org','manager'),/Only the dashboard owner/);
 assert.throws(()=>h.c.setDashboardAccess(owner,h.c.organizerEmail_(),'revoked'),/Owner access/);
 assert.throws(()=>h.c.setDashboardAccess(owner,'outside@example.com','viewer'),/school email/);
 assert.throws(()=>h.c.setDashboardAccess(owner,'officer@henricostudents.org','owner'),/Choose Viewer/);
 h.c.setDashboardAccess(owner,'officer@henricostudents.org','viewer');
 assert.equal(h.c.dashboardAccess(student).role,'viewer');assert.equal(h.c.dashboardAccess(student).members.length,0);
 h.c.organizerBookings(student);
 assert.throws(()=>h.c.organizerCancelBooking(student,'any'),/permission denied/);
 const booking=h.c.bookSlot(h.input(owner));
 h.c.setDashboardAccess(owner,'officer@henricostudents.org','manager');
 h.c.organizerEditBooking({...h.input(student),id:booking.id,topic:'Manager edited'});
 assert.throws(()=>h.c.setDashboardAccess(student,'other@henricostudents.org','viewer'),/Only the dashboard owner/);
 h.c.setDashboardAccess(owner,'officer@henricostudents.org','viewer');
 assert.throws(()=>h.c.organizerEditBooking({...h.input(student),id:booking.id}),/permission denied/);
 h.c.setDashboardAccess(owner,'officer@henricostudents.org','revoked');
 assert.throws(()=>h.c.organizerBookings(student),/permission denied/);
 assert.equal(h.c.dashboardAccess(owner).members.length,0);
});
