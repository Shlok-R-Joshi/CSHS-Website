/** Private calendar invitations and direct emails. All helpers are editor-only. */
function queueConfirmation_(r) {
  var p=PropertiesService.getScriptProperties(), key='confirmation:' + r.id;
  if(!p.getProperty(key)) p.setProperty(key,JSON.stringify({id:r.id,status:'pending'}));
}
function confirmationStatus_(id) {
  var job=JSON.parse(PropertiesService.getScriptProperties().getProperty('confirmation:' + id) || 'null');
  return job ? job.status : 'Not recorded (older signup)';
}
function deliverConfirmations_(c, attemptedInvites) {
  var p=PropertiesService.getScriptProperties(), all=p.getProperties(), attempted=0;
  Object.keys(all).filter(function(k){return k.indexOf('confirmation:')===0;}).sort().forEach(function(key){
    var job=JSON.parse(all[key]);
    if(job.status!=='pending' || attempted>=10)return;
    var r=bookingById_(job.id);
    if(!r)return; // A queued job cannot announce an uncommitted reservation.
    if(r.status!=='booked' || at_(r.date,c.start).getTime()<=Date.now()){
      job.status='skipped';p.setProperty(key,JSON.stringify(job));return;
    }
    try {
      if(MailApp.getRemainingDailyQuota()<1)return;
      if(attemptedInvites)attemptedInvites[r.id]=true;
      if(!inviteSafe_(r,c))return; // Wait for a real invitation before emailing its link.
      var invitationJob=JSON.parse(p.getProperty('invite:'+r.id));
      var event=Calendar.Events.get(invitationJob.calendarId,invitationId_(r.id));
      if(!event.htmlLink || event.status==='cancelled')return;
      job.status='sending';p.setProperty(key,JSON.stringify(job));attempted++;
      MailApp.sendEmail({to:r.email,replyTo:organizerEmail_(),name:'CS Wednesdays',
        subject:'CS Wednesdays — Reservation confirmation — ' + r.date,
        body:'Your CS Wednesday reservation is saved.\n\nWednesday: ' + r.date +
          '\nTime: ' + c.start + '–' + c.end + ' Eastern (America/New_York)\nRoom: ' + c.room +
          '\nName(s): ' + r.name + '\nPresentation topic: ' + r.topic +
          '\nActivity plan: ' + r.activity + '\nMeeting outline/plan: ' + r.details +
          '\n\nOpen your calendar invitation: ' + event.htmlLink +
          '\nSign in with the school email you used to reserve. Please respond to the invitation in Google Calendar.' +
          '\n\nThis confirms your reserved date, not approval of your presentation. Officers will notify you about selection.' +
          '\n\nNeed a change or cannot attend? Reply to this email or email ' + organizerEmail_() +
          ' ASAP with your date and presentation topic. Students cannot edit or cancel online. Your date stays reserved until the organizer processes your request.' +
          '\nDeclining the calendar invitation does not cancel the reservation.'});
      job.status='sent';job.sentAt=new Date().toISOString();
    }catch(e){job.status=job.status==='sending'?'unknown':'pending';console.error('Reservation confirmation needs review for booking ' + job.id);}
    p.setProperty(key,JSON.stringify(job));
  });
}
function queueOrganizerNotice_(r, action, c) {
  var p=PropertiesService.getScriptProperties(), key='organizer-notice:' + r.id + ':' + r.revision;
  if (p.getProperty(key)) return;
  p.setProperty(key,JSON.stringify({id:r.id,revision:r.revision,action:action,status:'pending',
    at:new Date().toISOString(),date:r.date,email:r.email,name:r.name,topic:r.topic,
    activity:r.activity,details:r.details,bookingStatus:r.status}));
}
function deliverOrganizerNotices_(c) {
  var p=PropertiesService.getScriptProperties(), all=p.getProperties(), sent=0;
  Object.keys(all).filter(function(k){return k.indexOf('organizer-notice:')===0;}).sort().forEach(function(key){
    var job=JSON.parse(all[key]);
    if(job.status!=='pending' || sent>=10) return;
    var current=bookingById_(job.id);
    // Do not announce an uncommitted write. Jobs are saved before ledger mutation.
    if(!current || (current.revision || 1)<job.revision) return;
    try {
      if(MailApp.getRemainingDailyQuota()<1) return;
      job.status='sending';p.setProperty(key,JSON.stringify(job));sent++;
      MailApp.sendEmail({to:organizerEmail_(),replyTo:job.email,name:'CS Wednesdays',
        subject:'CS Wednesdays — ' + job.action + ' — ' + job.date,
        body:job.action + '\nRecorded: ' + job.at + '\n\nWednesday: ' + job.date +
          '\nTime: ' + c.start + '–' + c.end + ' Eastern\nRoom: ' + c.room +
          '\nName(s): ' + job.name + '\nSchool email: ' + job.email + '\nTopic: ' + job.topic +
          '\nActivity: ' + job.activity + '\nOutline: ' + job.details +
          '\nStatus at this update: ' + job.bookingStatus + '\nReference: ' + job.id +
          '\n\nManage all signups: ' + c.siteUrl + '?manage=1#organizer' +
          '\nVerify ' + organizerEmail_() + ' to open the organizer panel. This link grants no access on its own.' +
          '\n\nA reserved date is not officer selection confirmation.'});
      job.status='sent';
    } catch(e) {
      // Sending can succeed even if its response fails. Avoid duplicate mail on retries.
      job.status=job.status==='sending'?'unknown':'pending';
      console.error('Organizer notification needs review for booking ' + job.id);
    }
    p.setProperty(key,JSON.stringify(job));
  });
}
function invitationId_(id) { return 'c5' + id.replace(/-/g, '').toLowerCase(); }
function privateCalendar_(calendarId) {
  var page;
  do {
    var result = Calendar.Acl.list(calendarId, page ? {pageToken: page} : {});
    if ((result.items || []).some(function(rule) {
      return rule.role !== 'none' && ['default', 'domain'].indexOf(rule.scope.type) >= 0;
    })) throw new Error('Invitation calendar must not be public or domain-shared.');
    page = result.nextPageToken;
  } while (page);
}
function missingEvent_(error) { return /\b404\b|\b410\b|not found|resource has been deleted/i.test(String(error.message || error)); }
function inviteSafe_(r, c) {
  var props = PropertiesService.getScriptProperties(), key = 'invite:' + r.id;
  // Separate durable job survives a new reservation replacing a cancelled date's ledger record.
  var old = JSON.parse(props.getProperty(key) || 'null');
  if (!old || old.status !== r.status || old.topic !== r.topic) {
    old = {id:r.id, date:r.date, email:r.email, topic:r.topic, status:r.status,
      calendarId:old ? old.calendarId : c.inviteCalendarId, pending:true};
    props.setProperty(key, JSON.stringify(old));
  }
  if (!old.pending) return true;
  try { deliverInvitation_(old, c); return true; }
  catch (e) { console.error('Invitation update pending for booking ' + r.id); return false; }
}
function deliverInvitation_(job, c) {
  privateCalendar_(job.calendarId);
  if (job.status === 'booked' && at_(job.date,c.end).getTime() <= Date.now()) {
    job.pending=false;
    PropertiesService.getScriptProperties().setProperty('invite:' + job.id,JSON.stringify(job));
    return; // Never send a stale invitation after an extended outage.
  }
  var id = invitationId_(job.id), existing;
  try { existing = Calendar.Events.get(job.calendarId, id); }
  catch (e) { if (!missingEvent_(e)) throw e; }
  if (job.status === 'cancelled') {
    if (existing && existing.status !== 'cancelled') Calendar.Events.remove(job.calendarId, id, {sendUpdates:'all'});
  } else if (!existing) {
    Calendar.Events.insert({
      id:id, summary:'CS Wednesday: ' + job.topic,
      description:'Your Wednesday lunch presentation is reserved.\nRoom: ' + c.room +
        '\nChanges or cancellation: email ' + organizerEmail_() +
        '\nStudents cannot edit or cancel online. Your date remains reserved until the organizer cancels it. Declining this invitation does not cancel the reservation.',
      location:c.room, visibility:'private',
      start:{dateTime:at_(job.date,c.start).toISOString(),timeZone:CSW_SCHEDULE.timezone},
      end:{dateTime:at_(job.date,c.end).toISOString(),timeZone:CSW_SCHEDULE.timezone},
      attendees:[{email:job.email,responseStatus:'needsAction'}],
      guestsCanModify:false,guestsCanInviteOthers:false,guestsCanSeeOtherGuests:false,
      reminders:{useDefault:false}
    }, job.calendarId, {sendUpdates:'all'});
  } else if (existing.summary !== 'CS Wednesday: ' + job.topic) {
    Calendar.Events.patch({summary:'CS Wednesday: ' + job.topic}, job.calendarId, id, {sendUpdates:'all'});
  }
  // A stable event ID makes a retry after a lost API response safe without a second invitation.
  job.pending=false;
  PropertiesService.getScriptProperties().setProperty('invite:' + job.id,JSON.stringify(job));
}
function reminderDue_(r, hours, now, c) {
  var start=at_(r.date,c.start).getTime(), due=start-hours*3600000;
  return r.status==='booked' && !closure_(r.date,c) && now>=due && now<start &&
    Date.parse(r.createdAt)<=due && (hours!==24 || now<start-3600000);
}
function sendReminder_(r, hours, c) {
  var props=PropertiesService.getScriptProperties(), key='reminder:' + r.id + ':' + hours;
  if (props.getProperty(key) || MailApp.getRemainingDailyQuota()<1) return;
  // Persist an attempt before sending. On an ambiguous mail failure, do not resend blindly.
  props.setProperty(key, JSON.stringify({status:'sending',at:new Date().toISOString()}));
  try {
    MailApp.sendEmail({to:r.email,replyTo:c.contact,name:'CS Wednesdays',
      subject:'Reminder: CS Wednesday ' + (hours===24 ? 'tomorrow' : 'in about an hour'),
      body:'You are hosting CS Wednesday on ' + r.date + ' from ' + c.start + ' to ' + c.end +
        ' (America/New_York).\nRoom: ' + c.room + '\nTopic: ' + r.topic +
        '\n\nPlease have your presentation and equipment ready.\nChanges or cancellation: email ' + organizerEmail_() +
        '. Students cannot edit or cancel online. Your date remains reserved until the organizer cancels it.' +
        '\nView your reservation: ' + c.siteUrl + '#signup'});
    props.setProperty(key,JSON.stringify({status:'sent',at:new Date().toISOString()}));
  } catch (e) {
    props.setProperty(key,JSON.stringify({status:'unknown',at:new Date().toISOString()}));
    console.error('Reminder delivery needs review for booking ' + r.id);
  }
}
// Install one time-driven trigger, every 15 minutes, after testing with the calendar owner.
function notificationsTick_() {
  locked_(function() {
    var c=config_(), props=PropertiesService.getScriptProperties(), attempted={};
    deliverOrganizerNotices_(c);
    deliverConfirmations_(c,attempted);
    dates_().map(record_).filter(Boolean).forEach(function(r) {
      if(!attempted[r.id] && (r.status==='cancelled' || at_(r.date,c.end).getTime()>Date.now())) {
        attempted[r.id]=true;
        inviteSafe_(r,c);
      }
    });
    // Retry old cancellation jobs even after the slot has been booked by someone else.
    var all=props.getProperties();
    Object.keys(all).filter(function(k){return k.indexOf('invite:')===0;}).forEach(function(k){
      var job=JSON.parse(all[k]);
      var current=record_(job.date);
      if(job.status==='booked' && (!current || current.id!==job.id || current.status==='cancelled')) {
        job.status='cancelled';job.pending=true;props.setProperty(k,JSON.stringify(job));
      }
      if(job.pending && !attempted[job.id])try{deliverInvitation_(job,c);}catch(e){console.error('Invitation job still pending: ' + job.id);}
    });
    dates_().map(record_).filter(Boolean).forEach(function(r) {
      var now=Date.now();
      var due=[24,1].filter(function(hours){return reminderDue_(r,hours,now,c);});
      if(!due.length)return;
      // Do not remind someone to attend a session that is now blocked by another event.
      if(events_(r.date,c,calendar_(c)).some(function(e){return !owned_(e,r.date);}))return;
      due.forEach(function(hours){sendReminder_(r,hours,c);});
    });
  });
}
