# CS tutoring

School-owned backend deployed as version 31 on October 12, 2026. `tutoringEnabled` is true. The combined `codex/cshs-complete-update` branch includes tutoring, separate-tab signup, team photos, and the points portal link. The website repository has not been pushed or published.

## What it does

- Students verify an HCPS email, choose a course, describe what they need help with, and give a preferred date and weekly availability.
- Tutors verify their email and register courses they have already taken and the times they are available. Students must select a course; tutors select from the listed completed courses.
- Submission sends a receipt to the student/tutor and a notice to Shlok. It does not create a calendar invitation.
- The owner chooses a tutor with a matching course and shared availability, confirms the school day and room, sets the time, and approves. Both participants receive approval emails and a private calendar invitation.
- The system blocks past dates, weekends, known closures, mismatched availability, self-matching, and overlapping approved tutoring/CS Wednesday sessions for a known participant.
- The dashboard has pending requests, approved sessions, active tutors, history, and delivery issues. Details start collapsed.
- Students can see their own registration and sessions but cannot edit or cancel them. Managers can cancel sessions, deactivate tutor registrations, and mark attendance. Only the owner approves matches. Viewers can only read.
- Completed attendance records show session hours. Tutors earn one service point per hour, but points must still be logged through the existing CSHS process.
- Email reminders go to both participants around 24 hours and one hour before a session, provided it was approved before that reminder time. The existing 15-minute trigger handles them.

All tutoring records stay private. They are not added to the public website calendar. An invitation includes the student/tutor names and topic, but not other requests or registrations. Organizer access is shared with CS Wednesdays.

## Preview

Serve the repository on port 8767 and open:

`http://127.0.0.1:8767/html/tutoring.html`

CS Wednesday signup opens the school-owned app directly in the same tab; tutoring opens it in a new tab. School sign-in can still expire, but it can complete normally there instead of failing inside a website iframe. The calendar stays embedded, with a separate-tab fallback if it does not respond within ten seconds. A late successful response restores the calendar.

For a local-only demonstration, open `http://127.0.0.1:8767/booking/TutoringPage.html?demo=1`. It is explicitly labelled, uses invented people, makes no backend calls, and resets on refresh. It is not a substitute for server validation.

## Deployment reference (backend steps already completed)

1. In the existing **school-owned** Apps Script project, add `Tutoring.gs` and `TutoringPage.html` from `booking/`. Update the `doGet`, `requestCode`, and `organizerApproveBooking` functions from `Code.gs`, plus `runEmailReminders` from `SchoolSetup.gs`. If the deployed project combines `.gs` files into one, replace existing functions rather than adding duplicates.
2. Keep the existing private invitation calendar, verified-school-email checks, officer roles and HCPS-only web-app access. No new scopes or public calendar permissions are needed. Do not rerun calendar setup.
3. Update the existing web-app deployment to a new version. Verify `?view=tutoring` opens the correct page while `?view=calendar` and CS Wednesday signup still work.
4. Keep the existing school-owner `runEmailReminders` trigger (every 15 minutes). It now also runs the private tutoring delivery/reminder worker; do not add duplicate triggers.
5. Test a real request, match, approval, email/invitation delivery, refresh, and cancellation with consenting school test accounts. Inspect both inboxes and calendar cancellations. See the live validation record below. Testing with two different people still requires consenting school accounts.
6. Set `tutoringEnabled: true` in `js/csw-booking-config.js`, then publish the reviewed website changes through the normal repository process.

The Google Forms in the CS Tutoring Drive folder remain unchanged. Existing responses are not imported automatically.

## Limits and failure handling

- The inherited school schedule only enumerates Wednesday closures. Other weekdays are not automatically certified as school days; the organizer must check the school calendar, bell times, and room before approval. Availability labels do not determine exact bell times.
- Only participants known to this system are checked for overlaps. Personal calendars, classmates named in group presentation text, and room bookings are not scanned.
- One active tutor registration and two open student requests per school email. For changes, cancel/deactivate and resubmit; there is no rescheduling editor in this version.
- School verification shares the existing cooldowns and Google email quotas. A successful request persists even when mail or Calendar delivery is delayed.
- Calendar invitations use stable IDs to avoid duplicate events after a lost response. Pending Calendar work and quota-blocked mail retry via the trigger. Ambiguous email sends show `unknown` or `sending`; check inboxes before contacting the person manually. They are not blindly resent.
- A cancelled session stops approval/reminder emails. Calendar cancellation retries if Google is unavailable. Queued invitations are not sent after the session starts.
- Records use Apps Script Properties alongside CS Wednesdays. A 200-record cap prevents unbounded growth; an editor must arrange private archival before raising it. No automatic deletion is provided, and Google storage/runtime limits still apply.

## Tests

Local validation: 116 automated checks passed, including the existing CS Wednesday suite, tutoring recovery, separate-tab links, and calendar fallback. Browser demo checks covered tutor registration, multiline student requests, and matching/approval. Automated checks do not verify real Google email or Calendar delivery.

`node --test tests/*.test.cjs`

Tutoring tests use mocked Google services and verified test identities. They cover privacy, permissions, multiline plans, eligibility, invalid dates, request limits, conflicts, approval, cancellation, attendance, reminders, quota handling, and lost Calendar responses. The original booking harness is shared under `tests/helpers/` so CS Wednesday checks continue unchanged.

## Live validation — October 12, 2026

- Existing school project and deployment reused; execution remains the HCPS owner and access remains school-only. No personal account, additional OAuth permissions, public calendar access, or duplicate triggers.
- Backed up the live Code.gs before editing and verified the four changed integration functions matched the repository base. Unrelated live functions were preserved.
- Apps Script requires unique file base names: HTML is `TutoringPage.html`, separate from `Tutoring.gs`.
- Verified OTP arrival in the HCPS inbox; real student request and tutor registration; multiline, punctuation and ampersand preservation; records survive reload and reverification.
- Verified self-matching remains blocked. No other student's account was used or contacted.
- Temporary school-owner-only delivery fixture sent approval copies for both roles and 24-hour/1-hour reminder formats to the owner. Verified messages in Gmail, correct greeting/signature/details/link, and one private event with one unique school recipient. This verifies delivery, not two distinct participants or elapsed reminder timing.
- The temporary test entry point was removed before version 29 deployment. Its local source and pre-edit backup are outside the repo in the owner's deployment evidence directory.
- Replaced native browser confirmation prompts with page dialogs. Verified Keep unchanged leaves a request pending, Confirm cancels it, and controls recover afterwards.
- Cancelled both disposable requests and deactivated the disposable tutor through the real dashboard. Cancellation emails arrived and the invitation disappeared from both the private organizer calendar and school attendee calendar. Test records remain labelled in History; no real reservations were changed.
- All test delivery statuses reported sent. The reminder trigger completed at 9:57 PM with tutoring installed; no additional trigger was created.
- Existing CS Wednesday availability and club calendar still load. The website tutoring link opens the real school backend (no demo parameter).
- 104 automated tests passed, covering separate identities, matching/approval, conflicts, privacy, quotas, exactly-once recovery, cancellation and reminder timing with mocked Google services. Live two-person approval and real 24-hour/1-hour timing have not been independently exercised.

Review the local site at `http://127.0.0.1:8767/html/tutoring.html`. The shared Apps Script backend is live, but adding the tutoring link/page to the public CIT website still requires publishing the website branch.

## Combined branch checks — October 12, 2026

- Both website buttons opened the real school apps in separate Chrome tabs. No signup iframe or automatic popup remains on those pages. Calendar date and organizer links preserve their parameters.
- Tutoring version 30 preserves submission confirmation if the follow-up dashboard read fails. Failed or ambiguous writes retain their retry IDs. The live source was backed up, compared, saved and read back before updating the existing deployment; no account or access settings changed.
- The tutoring landing page and mobile menu were checked at desktop and 390-pixel phone widths. Shared navigation collapses before the full menu would overflow.
- Team photos and the points portal button were brought into the same branch. The obsolete points message and unused login handler were removed.
- 114 local tests pass. No new test emails or calendar bookings were created during this final integration check. The owner-only delivery evidence and two-account limitations above still apply.

## Signup refinements — October 12, 2026

- CS Wednesday button navigates directly in the same tab; removed the two requested explanatory paragraphs.
- Tutoring starts with Select a course and rejects an empty choice. Removed the optional extra tutor course field and officer-role explanation.
- Active tutoring signups include Request changes; CS Wednesday calls its existing email link Request changes by email. These open a prefilled message to the school organizer. Users must send it; no reservation changes automatically.
- School backend version 31 includes the two form updates. 116 tests pass. No access or booking state changed.
