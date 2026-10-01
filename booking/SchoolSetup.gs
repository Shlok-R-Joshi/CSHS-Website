/** Run manually in the Apps Script editor while signed into the HCPS owner account.
 * Creates private draft calendars only. Does not send mail, publish, or install triggers.
 */
function setupSchoolDraft() {
  var owner = 'hcps-joshisr1@henricostudents.org';
  if (Session.getActiveUser().getEmail() !== owner || Session.getEffectiveUser().getEmail() !== owner) {
    throw new Error('Run setup only as the HCPS owner account in the Apps Script editor.');
  }
  return locked_(function() {
    var p = PropertiesService.getScriptProperties();
    [['CALENDAR_ID', 'CS Wednesdays Availability — HCPS Branch Draft'],
     ['INVITE_CALENDAR_ID', 'CS Wednesdays Private Invitations — HCPS Branch Draft']].forEach(function(pair) {
      if (p.getProperty(pair[0])) return;
      var matches = CalendarApp.getOwnedCalendarsByName(pair[1]);
      if (matches.length > 1) throw new Error('Multiple draft calendars found. Select the intended one manually.');
      var cal = matches[0] || CalendarApp.createCalendar(pair[1], {timeZone:'America/New_York'});
      p.setProperty(pair[0], cal.getId());
    });
    p.setProperties({LUNCH_START:'11:55', LUNCH_END:'12:55', ROOM:'SC2',
      CONTACT_EMAIL:owner, SITE_URL:'https://drhscit.org/cshs/html/CSW.html'});
    return 'HCPS-owned draft calendars configured. No emails sent; no deployment or triggers created.';
  });
}

// Owner-guarded entry points visible in the Apps Script trigger UI.
function requireSchoolOwner_() {
  var owner = 'hcps-joshisr1@henricostudents.org';
  if (Session.getEffectiveUser().getEmail() !== owner || Session.getActiveUser().getEmail() !== owner) {
    throw new Error('Only the school owner may run this maintenance function.');
  }
}
function runCalendarSync() {
  requireSchoolOwner_();
  var report = syncCalendar_();
  console.log(JSON.stringify(report));
  return report;
}
function runEmailReminders() { requireSchoolOwner_(); notificationsTick_(); }
function testOwnerReminderDelivery() {
  requireSchoolOwner_();
  var c=config_();
  [24,1].forEach(function(hours) {
    var r={id:'owner-delivery-test-20260926', email:'hcps-joshisr1@henricostudents.org',
      date:'TEST ONLY - no real session',topic:'TEST ONLY - reminder delivery validation'};
    sendReminder_(r,hours,c);
    var result=JSON.parse(PropertiesService.getScriptProperties().getProperty('reminder:'+r.id+':'+hours)||'null');
    if(!result || result.status!=='sent')throw new Error('Test reminder was not confirmed sent. Inspect mail quota/logs.');
  });
  console.log('Both owner-only reminder test messages sent. Re-running does not resend.');
}
