# CSHS website and CS Wednesday reservations

This fork contains the static CSHS website and the Google Apps Script source for the HCPS-owned reservation system. Publishing this repository does not deploy the CIT website or update Apps Script. No pull request or upstream merge is required to maintain this fork.

## Website

Serve the repository root using any static web server. The website uses HTML, CSS and browser JavaScript; the CIT server does not need a Node.js backend. Node.js is used only for development scripts and tests.

- CS Wednesdays: `html/CSW.html`
- Calendar: `html/calendar.html`
- Team: `html/about.html`
- Previous meetings: `html/previous.html`
- Current meeting presentation and its local viewer: `presentations/`

The team page retains the Dan Miller and Evan Rosen photos and uses placeholders for other officers. The previous-meetings gallery contains the supplied September meeting presentation. Controls inside the viewer navigate slides; outer gallery controls navigate presentations.

## Reservation backend

The `booking/` directory contains Google Apps Script source, including its manifest. The browser loads the school-owned web application configured in `js/csw-booking-config.js`. That file contains public configuration only. It must never contain credentials, private calendar IDs, signup records or access grants.

The deployment must execute as its school owner and retain the intended HCPS account access restriction. Google authorization and school policy still apply. Student email verification is an additional step, not a replacement for Google access controls.

Private configuration and operational records belong in Apps Script properties, not this repository. Backend settings include `CALENDAR_ID`, `INVITE_CALENDAR_ID`, `LUNCH_START`, `LUNCH_END`, `ROOM`, `CONTACT_EMAIL`, `SITE_URL` and optional date overrides. Keep the availability calendar separate from the private invitation calendar. Review the school-owner guard and setup routines before configuring a different deployment.

### Signup behavior

- Verify the student's email before booking an available date.
- Allow one group per date and limit future reservations per email.
- Reject unavailable dates, including past dates and configured closures.
- Send a calendar invitation and a confirmation email with reservation details and a calendar link.
- Do not include a reservation reference or a student self-management link in confirmation emails.
- Names entered for copresenters do not establish verified email addresses; invitations go to the verified submitter.
- Students contact the organizer to change or cancel a reservation. They cannot edit or cancel through student controls.
- Public availability can show presenters and topic. Email addresses and detailed plans stay private.

### Organizer dashboard

The verified owner can manage signups and grant or revoke dashboard access. Viewer access is read-only. Manager access permits signup edits and cancellations but does not permit granting access. Authorization checks run on the server; hiding browser buttons alone is not a security boundary.

Edits and cancellations update the calendar and notify the organizer. To change a reservation date, cancel it and arrange a new booking.

### Notifications and operational limits

Google mail and Calendar quotas still apply. Application safeguards, retry handling and duplicate prevention are included. An owner-specific application-limit exception does not remove Google's quotas or all request spacing safeguards.

Configure the supported maintenance triggers for calendar synchronization and email reminders. Review `booking/Notifications.gs` for the actual queue and retry behavior before deployment. Unknown delivery outcomes must not be blindly retried because that can duplicate messages. Reminder delivery depends on trigger execution and available Google quota.

## Development and validation

Run:

```sh
node --test tests/booking.test.cjs tests/booking-frontend.test.cjs
```

The current publication passed 49 local tests. These cover backend behavior and frontend expectations, including permissions, verification, reservations and notification handling. They do not replace testing Google authorization and delivery using a second school account. Do not treat publication of source as proof that a live deployment has been updated.

Schedule source is maintained in `data/csw-schedule.json`; regenerate derived schedule data with:

```sh
node scripts/build-schedule.cjs
```

Selection of presenters and approval of service points remain officer responsibilities; they are not automatically awarded by the reservation system.

## Publishing

Review the diff and test locally before pushing to this fork. Updating the live CIT site requires its separate authorized deployment process. Updating Apps Script requires a separate school-owned deployment. Do not commit private setup history, verification codes, booking exports or credentials.
