// Uses the same verified school identities and officer roles as CS Wednesdays.
// Tutoring records and invitations never appear on the public calendar.
var TUTORING_COURSES = [
  "AP Computer Science Principles",
  "AP Computer Science A",
  "Application Development",
  "Intro to Programming",
];
var TUTORING_PERIODS = ["A lunch", "B lunch", "Before school", "After school"];

function tutoringRead_(id) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(String(id || "")))
    throw new Error("Invalid record.");
  return JSON.parse(
    PropertiesService.getScriptProperties().getProperty("tutoring:" + id) ||
      "null",
  );
}
function tutoringSave_(record) {
  var props = PropertiesService.getScriptProperties(),
    value = JSON.stringify(record);
  var key = "tutoring:" + record.id,
    all = props.getProperties();
  // Conservative UTF-8 estimate leaves room for the existing booking service.
  all[key] = value;
  var size = Object.keys(all).reduce(function (total, k) {
    return total + 3 * (k.length + all[k].length);
  }, 0);
  var bytes = encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, "x").length;
  if (bytes > 8500 || size > 450000)
    throw new Error(
      "Tutoring storage is nearly full. Contact the organizer to archive old records.",
    );
  props.setProperty(key, value);
}
function tutoringRecords_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(all)
    .filter(function (key) {
      return key.indexOf("tutoring:") === 0;
    })
    .map(function (key) {
      return JSON.parse(all[key]);
    });
}
function tutoringAvailability_(values) {
  if (!Array.isArray(values) || !values.length || values.length > 20)
    throw new Error("Choose your available days and times.");
  return values.filter(function (value, index) {
    if (!/^[1-5]:[0-3]$/.test(value))
      throw new Error("Choose valid availability.");
    return values.indexOf(value) === index;
  });
}
function tutoringCourse_(value) {
  return clean_(value, "course", 80);
}
function tutoringDay_(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")))
    throw new Error("Choose a valid date.");
  var day = new Date(date + "T12:00:00Z");
  if (
    !isFinite(day) ||
    day.toISOString().slice(0, 10) !== date ||
    day.getUTCDay() < 1 ||
    day.getUTCDay() > 5 ||
    date < dateKey_(new Date()) ||
    date < CSW_SCHEDULE.firstDay ||
    date > CSW_SCHEDULE.lastDay ||
    CSW_SCHEDULE.closed[date]
  )
    throw new Error(
      "Choose a future school weekday in the current school year.",
    );
  return day.getUTCDay();
}
function tutoringQueue_(r, key, to, name, subject, body) {
  r.mail = r.mail || {};
  if (!r.mail[key])
    r.mail[key] = {
      to: to,
      name: name,
      subject: subject,
      body: body === tutoringDetails_(r) ? "$details" : body,
      status: "pending",
    };
}
function tutoringNote_(r, action) {
  tutoringQueue_(
    r,
    "organizer-" + r.revision,
    organizerEmail_(),
    "Shlok",
    action,
    r.name +
      " (" +
      r.email +
      ")\n" +
      (r.course || r.courses.join(", ")) +
      "\n\nOpen the tutoring dashboard: " +
      (typeof ScriptApp !== "undefined" && ScriptApp.getService
        ? ScriptApp.getService().getUrl() + "?view=tutoring"
        : config_().siteUrl.replace(/\/html\/.*$/, "") + "/html/tutoring.html"),
  );
}
function tutoringSubmit(input) {
  input = input || {};
  return locked_(function () {
    var email = identity_(input.token),
      records = tutoringRecords_();
    if (!/^[a-zA-Z0-9-]{20,80}$/.test(String(input.requestId || "")))
      throw new Error("Refresh the page and try again.");
    var previous = records.filter(function (r) {
      return r.email === email && r.requestId === input.requestId;
    })[0];
    if (previous) return { id: previous.id, status: previous.status };
    if (["tutor", "request"].indexOf(input.kind) < 0)
      throw new Error("Choose tutor registration or a help request.");
    if (records.length >= 200)
      throw new Error(
        "Please contact the organizer; tutoring storage needs archiving.",
      );
    if (
      input.kind === "tutor" &&
      records.some(function (r) {
        return r.kind === "tutor" && r.email === email && r.status === "active";
      })
    )
      throw new Error(
        "You are already registered. Email the organizer to update your availability.",
      );
    if (
      input.kind === "request" &&
      records.filter(function (r) {
        return (
          r.kind === "request" &&
          r.email === email &&
          (r.status === "pending" ||
            (r.status === "approved" && at_(r.date, r.end) > new Date()))
        );
      }).length >= 2
    )
      throw new Error(
        "You can have two open tutoring requests. Contact the organizer for changes.",
      );
    var r = {
      id: Utilities.getUuid(),
      requestId: input.requestId,
      kind: input.kind,
      email: email,
      name: clean_(input.name, "first and last name", 100),
      availability: tutoringAvailability_(input.availability),
      status: input.kind === "tutor" ? "active" : "pending",
      revision: 1,
      createdAt: new Date().toISOString(),
      mail: {},
    };
    if (r.kind === "tutor") {
      if (input.completed !== true)
        throw new Error(
          "Confirm you have already taken the courses you want to tutor.",
        );
      if (
        !Array.isArray(input.courses) ||
        !input.courses.length ||
        input.courses.length > 5
      )
        throw new Error("Choose one to five courses.");
      r.courses = input.courses
        .map(tutoringCourse_)
        .filter(function (c, i, list) {
          return list.indexOf(c) === i;
        });
    } else {
      r.course = tutoringCourse_(input.course);
      r.details = clean_(input.details, "topics or questions", 1000, true);
      tutoringDay_(input.date);
      r.requestedDate = input.date;
      if (
        !r.availability.some(function (a) {
          return Number(a.split(":")[0]) === tutoringDay_(input.date);
        })
      )
        throw new Error("Your requested date must match an available day.");
    }
    tutoringQueue_(
      r,
      "receipt",
      email,
      r.name,
      r.kind === "tutor"
        ? "Tutor registration received"
        : "Tutoring request received",
      r.kind === "tutor"
        ? "You are registered to tutor " +
            r.courses.join(", ") +
            ". Matching depends on demand. Tutors earn 1 service point per hour."
        : "Your request for " +
            r.course +
            " on " +
            r.requestedDate +
            " has been submitted. It is awaiting a tutor match and organizer approval. No session is booked yet.",
    );
    tutoringNote_(
      r,
      r.kind === "tutor" ? "New tutor registration" : "New tutoring request",
    );
    tutoringSave_(r);
    tutoringDeliver_(r);
    return { id: r.id, status: r.status };
  });
}
function tutoringDashboard(token) {
  var email = identity_(token),
    role = dashboardRole_(email);
  return {
    role: role,
    email: email,
    courses: TUTORING_COURSES,
    records: tutoringRecords_()
      .filter(function (r) {
        return role || r.email === email || r.tutorEmail === email;
      })
      .map(function (r) {
        var copy = JSON.parse(JSON.stringify(r));
        delete copy.requestId;
        // Delivery metadata is useful to officers, but message bodies can contain third-party details.
        copy.mail = role
          ? Object.keys(r.mail || {}).map(function (key) {
              return { label: key, status: r.mail[key].status };
            })
          : [];
        return copy;
      }),
  };
}
function tutoringApprove(input) {
  input = input || {};
  return locked_(function () {
    calendarOwner_(input.token);
    var r = tutoringRead_(input.id),
      tutor = tutoringRead_(input.tutorId);
    if (!r || r.kind !== "request") throw new Error("Request not found.");
    if (r.status === "approved") return { status: r.status }; // Safe retry after a lost response.
    if (r.status !== "pending")
      throw new Error("This request is no longer pending.");
    if (
      !tutor ||
      tutor.kind !== "tutor" ||
      tutor.status !== "active" ||
      tutor.email === r.email ||
      tutor.courses.indexOf(r.course) < 0
    )
      throw new Error(
        "Choose an active tutor who has taken this course (not the requesting student).",
      );
    var day = tutoringDay_(input.date),
      period = String(input.period),
      slot = day + ":" + period;
    if (
      !/^[0-3]$/.test(period) ||
      r.availability.indexOf(slot) < 0 ||
      tutor.availability.indexOf(slot) < 0
    )
      throw new Error("Both people must be available for this day and period.");
    if (input.schoolDayConfirmed !== true)
      throw new Error(
        "Confirm the school day, bell times and room before approving.",
      );
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.start || "") ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.end || "")
    )
      throw new Error("Enter valid start and end times.");
    var start = at_(input.date, input.start),
      end = at_(input.date, input.end);
    if (start <= new Date() || end <= start || end - start > 7200000)
      throw new Error("Choose a future session lasting up to two hours.");
    var room = clean_(input.room, "room", 80);
    var conflict = tutoringRecords_().some(function (other) {
      return (
        other.kind === "request" &&
        other.status === "approved" &&
        other.id !== r.id &&
        other.date === input.date &&
        at_(other.date, other.start) < end &&
        at_(other.date, other.end) > start &&
        [other.email, other.tutorEmail].some(function (person) {
          return person === r.email || person === tutor.email;
        })
      );
    });
    // Also protect participants with approved CS Wednesday presentations.
    var c = config_();
    if (!conflict)
      conflict = dates_().some(function (date) {
        var b = record_(date);
        return (
          b &&
          b.status === "booked" &&
          [r.email, tutor.email].indexOf(b.email) >= 0 &&
          at_(date, c.start) < end &&
          at_(date, c.end) > start
        );
      });
    if (conflict)
      throw new Error("A participant already has a session at this time.");
    privateCalendar_(c.inviteCalendarId); // Fail closed if the invitation calendar is public.
    r.status = "approved";
    r.revision++;
    r.tutorId = tutor.id;
    r.tutorName = tutor.name;
    r.tutorEmail = tutor.email;
    r.date = input.date;
    r.period = Number(period);
    r.start = input.start;
    r.end = input.end;
    r.room = room;
    r.calendarId = c.inviteCalendarId;
    r.inviteStatus = "pending";
    r.approvedAt = new Date().toISOString();
    r.mail.receipt.status =
      r.mail.receipt.status === "pending" ? "skipped" : r.mail.receipt.status;
    [
      { email: r.email, name: r.name },
      { email: r.tutorEmail, name: r.tutorName },
    ].forEach(function (person, i) {
      tutoringQueue_(
        r,
        "approval-" + i,
        person.email,
        person.name,
        "Tutoring session approved",
        tutoringDetails_(r),
      );
    });
    tutoringNote_(r, "Tutoring session approved");
    tutoringSave_(r); // Persist before contacting Calendar or sending approval emails.
    tutoringDeliver_(r);
    return { status: r.status, invitation: r.inviteStatus };
  });
}
function tutoringDetails_(r) {
  return (
    r.course +
    "\nDate: " +
    r.date +
    "\nTime: " +
    r.start +
    "–" +
    r.end +
    " Eastern\nRoom: " +
    r.room +
    "\nStudent: " +
    r.name +
    "\nTutor: " +
    r.tutorName +
    "\n\nTopics:\n" +
    r.details
  );
}
function tutoringClose(token, id, action) {
  return locked_(function () {
    dashboardIdentity_(token, true);
    var r = tutoringRead_(id);
    if (!r) throw new Error("Record not found.");
    if (["cancel", "complete", "deactivate"].indexOf(action) < 0)
      throw new Error("Unknown action.");
    var target =
      action === "complete"
        ? "completed"
        : action === "deactivate"
          ? "inactive"
          : "cancelled";
    if (r.status === target) return { status: r.status };
    if (
      action === "deactivate"
        ? r.kind !== "tutor" || r.status !== "active"
        : r.kind !== "request" || ["pending", "approved"].indexOf(r.status) < 0
    )
      throw new Error("This action is not available.");
    if (
      action === "complete" &&
      (r.status !== "approved" || at_(r.date, r.end) > new Date())
    )
      throw new Error("Only mark attendance after the approved session ends.");
    r.status = target;
    r.revision++;
    if (target === "completed") {
      r.hours = (at_(r.date, r.end) - at_(r.date, r.start)) / 3600000;
      r.completedBy = identity_(token); // Attendance record only; points are not submitted automatically.
    }
    if (target === "cancelled" && r.calendarId) r.inviteStatus = "pending";
    Object.keys(r.mail || {}).forEach(function (key) {
      if (r.mail[key].status === "pending" && !key.startsWith("organizer-"))
        r.mail[key].status = "skipped";
    });
    if (target !== "completed") {
      tutoringQueue_(
        r,
        "closed-student",
        r.email,
        r.name,
        r.kind === "tutor"
          ? "Tutor registration closed"
          : "Tutoring request cancelled",
        r.kind === "tutor"
          ? "Your tutor registration is no longer accepting new matches. Existing sessions are unchanged."
          : "Your tutoring request for " +
              r.course +
              " has been cancelled by the organizer.",
      );
      if (r.tutorEmail)
        tutoringQueue_(
          r,
          "closed-tutor",
          r.tutorEmail,
          r.tutorName,
          "Tutoring session cancelled",
          tutoringDetails_(r),
        );
    }
    tutoringNote_(r, "Tutoring: " + target);
    tutoringSave_(r);
    tutoringDeliver_(r);
    return { status: r.status };
  });
}
function tutoringInvite_(r) {
  if (!r.calendarId || r.inviteStatus !== "pending") return;
  privateCalendar_(r.calendarId);
  var id = "a7" + r.id.replace(/-/g, "").toLowerCase(),
    event;
  try {
    event = Calendar.Events.get(r.calendarId, id);
  } catch (e) {
    if (!missingEvent_(e)) throw e;
  }
  if (r.status === "cancelled") {
    if (event && event.status !== "cancelled")
      Calendar.Events.remove(r.calendarId, id, { sendUpdates: "all" });
  } else if (r.status === "approved") {
    if (at_(r.date, r.start) <= new Date()) {
      r.inviteStatus = "expired";
      return;
    }
    if (event && event.status === "cancelled")
      throw new Error(
        "Invitation was deleted. Cancel and arrange a new session.",
      );
    if (!event)
      event = Calendar.Events.insert(
        {
          id: id,
          summary: "CS Tutoring: " + r.course,
          location: r.room,
          description:
            tutoringDetails_(r) + "\n\nChanges: email " + organizerEmail_(),
          visibility: "private",
          start: {
            dateTime: at_(r.date, r.start).toISOString(),
            timeZone: CSW_SCHEDULE.timezone,
          },
          end: {
            dateTime: at_(r.date, r.end).toISOString(),
            timeZone: CSW_SCHEDULE.timezone,
          },
          attendees: [r.email, r.tutorEmail].filter(function (email, i, list) {
            return list.indexOf(email) === i;
          }).map(function (email) { return { email: email }; }),
          guestsCanModify: false,
          guestsCanInviteOthers: false,
          guestsCanSeeOtherGuests: false,
          reminders: { useDefault: false },
        },
        r.calendarId,
        { sendUpdates: "all" },
      );
    r.calendarLink = event.htmlLink || "";
    if (!r.calendarLink) throw new Error("Calendar link unavailable.");
  }
  r.inviteStatus = "sent";
}
function tutoringDeliver_(r) {
  try {
    tutoringInvite_(r);
  } catch (e) {
    r.inviteStatus = "pending";
  }
  tutoringSave_(r);
  Object.keys(r.mail || {}).forEach(function (key) {
    var job = r.mail[key];
    if (job.status !== "pending" || MailApp.getRemainingDailyQuota() < 1)
      return;
    if (key.startsWith("approval-") || key.startsWith("reminder-")) {
      if (r.status !== "approved" || at_(r.date, r.start) <= new Date()) {
        job.status = "skipped";
        tutoringSave_(r);
        return;
      }
      if (r.inviteStatus !== "sent") return;
    }
    job.status = "sending";
    tutoringSave_(r);
    try {
      MailApp.sendEmail({
        to: job.to,
        replyTo: organizerEmail_(),
        name: "CSHS Tutoring",
        subject: "CSHS — " + job.subject,
        body:
          "Dear " +
          job.name +
          ",\n\n" +
          (job.body === "$details" ? tutoringDetails_(r) : job.body) +
          (key.startsWith("approval-") || key.startsWith("reminder-")
            ? "\n\nCalendar invitation: " + r.calendarLink
            : "") +
          "\n\nChanges or cancellation: email " +
          organizerEmail_() +
          ".\n\nBest regards,\nShlok Joshi",
      });
      job.status = "sent";
    } catch (e) {
      job.status = "unknown";
    } // MailApp cannot safely deduplicate an uncertain send.
    tutoringSave_(r);
  });
}
// Editor-installed trigger, every 15 minutes. No public unauthenticated send endpoint.
function runTutoringReminders_() {
  locked_(function () {
    tutoringRecords_().forEach(function (r) {
      if (r.status === "approved")
        [24, 1].forEach(function (hours) {
          var due = at_(r.date, r.start).getTime() - hours * 3600000;
          if (
            Date.now() >= due &&
            Date.now() < due + 1800000 &&
            new Date(r.approvedAt).getTime() <= due
          ) {
            [
              { email: r.email, name: r.name },
              { email: r.tutorEmail, name: r.tutorName },
            ].forEach(function (person, i) {
              tutoringQueue_(
                r,
                "reminder-" + hours + "-" + i,
                person.email,
                person.name,
                "Tutoring reminder",
                tutoringDetails_(r),
              );
            });
          }
        });
      tutoringDeliver_(r);
    });
  });
}
