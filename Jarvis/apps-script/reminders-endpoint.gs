// Jarvis reminders endpoint.
// Paste into Extensions > Apps Script on a Google Sheet, then deploy as a
// Web App (Execute as: Me, Who has access: Anyone with the link).
// Copy the deployment URL into Netlify as REMINDERS_APPS_SCRIPT_URL.

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  var action = body.action;

  if (action === "add") {
    return addReminder(body.message, body.dueAt, body.type, body.targetNumber, body.recurrence);
  } else if (action === "checkDue") {
    return checkDue();
  } else if (action === "getContacts") {
    return getContacts();
  } else if (action === "logCall") {
    return logCall(body.task, body.targetNumber, body.transcript, body.summary, body.outcome);
  }

  return jsonResponse({ error: "Unknown action: " + action });
}

// Logs a finished call to the CallLog tab (created automatically the first
// time this runs). One row per call: when it happened, what it was for,
// who it called, the full back-and-forth, the summary, and how it ended.
function logCall(task, targetNumber, transcript, summary, outcome) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("CallLog");
  if (!sheet) {
    sheet = ss.insertSheet("CallLog");
    sheet.appendRow(["Timestamp", "Task", "TargetNumber", "Outcome", "Summary", "Transcript"]);
  }

  var newRow = sheet.getLastRow() + 1;
  var timestampCell = sheet.getRange(newRow, 1);
  timestampCell.setValue(new Date());
  timestampCell.setNumberFormat("M/d/yyyy h:mm AM/PM");
  sheet.getRange(newRow, 2).setValue(task || "");
  sheet.getRange(newRow, 3).setValue(targetNumber || "");
  sheet.getRange(newRow, 4).setValue(outcome || "");
  sheet.getRange(newRow, 5).setValue(summary || "");
  sheet.getRange(newRow, 6).setValue(transcript || "");

  return jsonResponse({ success: true });
}

// Returns everyone in the Contacts tab as {name, phoneNumber} pairs. Add a
// tab called "Contacts" to this same spreadsheet with two columns: Name and
// PhoneNumber (E.164 format, e.g. +16065551234) - edit it directly like a
// normal spreadsheet, no special formatting needed beyond those two columns.
function getContacts() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Contacts");
  if (!sheet) {
    return jsonResponse({ contacts: [] });
  }

  var data = sheet.getDataRange().getValues();
  var contacts = [];
  for (var i = 1; i < data.length; i++) {
    var name = data[i][0];
    var phoneNumber = data[i][1];
    if (name && phoneNumber) {
      contacts.push({ name: String(name).trim(), phoneNumber: String(phoneNumber).trim() });
    }
  }

  return jsonResponse({ contacts: contacts });
}

function addReminder(message, dueAt, type, targetNumber, recurrence) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Reminders");
  if (!sheet) {
    sheet = ss.insertSheet("Reminders");
    sheet.appendRow(["DueAt", "Message", "Status", "Type", "TargetNumber", "Recurrence"]);
  } else {
    if (!sheet.getRange(1, 4).getValue()) {
      sheet.getRange(1, 4).setValue("Type");
      sheet.getRange(1, 5).setValue("TargetNumber");
    }
    if (!sheet.getRange(1, 6).getValue()) {
      sheet.getRange(1, 6).setValue("Recurrence");
    }
  }

  var dueDate = new Date(dueAt);
  Logger.log("addReminder received dueAt=" + dueAt + " | parsed type=" + Object.prototype.toString.call(dueDate) + " | valid=" + !isNaN(dueDate.getTime()));

  var newRow = sheet.getLastRow() + 1;
  var dateCell = sheet.getRange(newRow, 1);
  dateCell.setValue(dueDate);
  dateCell.setNumberFormat("M/d/yyyy h:mm AM/PM");
  sheet.getRange(newRow, 2).setValue(message);
  sheet.getRange(newRow, 3).setValue("pending");
  sheet.getRange(newRow, 4).setValue(type || "notify");
  sheet.getRange(newRow, 5).setValue(targetNumber || "");
  sheet.getRange(newRow, 6).setValue(recurrence || "none");

  return jsonResponse({ success: true });
}

function checkDue() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Reminders");
  if (!sheet) {
    return jsonResponse({ due: [] });
  }

  var data = sheet.getDataRange().getValues();
  var now = new Date();
  var due = [];

  for (var i = 1; i < data.length; i++) {
    var dueAt = new Date(data[i][0]);
    var status = data[i][2];
    var recurrence = data[i][5] || "none";

    if (status === "pending" && dueAt <= now) {
      due.push({
        message: data[i][1],
        type: data[i][3] || "notify",
        targetNumber: data[i][4] || ""
      });

      if (recurrence && recurrence !== "none") {
        // Recurring - reschedule to the next occurrence instead of
        // permanently marking sent, so it fires again automatically.
        var next = calculateNextOccurrence(dueAt, recurrence, now);
        var dateCell = sheet.getRange(i + 1, 1);
        dateCell.setValue(next);
        dateCell.setNumberFormat("M/d/yyyy h:mm AM/PM");
        // status stays "pending" - it'll fire again at the new time
      } else {
        sheet.getRange(i + 1, 3).setValue("sent");
      }
    }
  }

  return jsonResponse({ due: due });
}

// Calculates the next occurrence for a recurring reminder. If the call was
// missed for a while (e.g. the system was down), this steps forward from
// the original due time until it lands in the future, rather than firing
// a burst of catch-up reminders all at once.
function calculateNextOccurrence(dueAt, recurrence, now) {
  var next = new Date(dueAt);
  var guard = 0; // safety cap in case of an unexpected infinite loop

  while (next <= now && guard < 366) {
    if (recurrence === "daily") {
      next.setDate(next.getDate() + 1);
    } else if (recurrence === "weekly") {
      next.setDate(next.getDate() + 7);
    } else if (recurrence === "weekdays") {
      next.setDate(next.getDate() + 1);
      var day = next.getDay(); // 0 = Sunday, 6 = Saturday
      if (day === 6) {
        next.setDate(next.getDate() + 2); // Saturday -> Monday
      } else if (day === 0) {
        next.setDate(next.getDate() + 1); // Sunday -> Monday
      }
    } else {
      break; // unrecognized pattern - don't loop forever
    }
    guard++;
  }

  return next;
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// One-time cleanup for rows created before the M/D/Y formatting fix - run
// this once manually from the Apps Script editor (select this function in
// the dropdown at the top, click Run). Re-parses every existing row's date
// and applies the correct display format. Safe to run more than once.
function fixLegacyDateFormatting() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Reminders");
  if (!sheet) {
    throw new Error("No tab named 'Reminders' found. Actual tab names: " + ss.getSheets().map(function(s){ return s.getName(); }).join(", "));
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error("Sheet found but has no data rows (lastRow=" + lastRow + ")");
  }

  var fixedCount = 0;
  for (var i = 2; i <= lastRow; i++) {
    var cell = sheet.getRange(i, 1);
    var raw = cell.getValue();
    var parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) {
      cell.setValue(parsed);
      cell.setNumberFormat("M/d/yyyy h:mm AM/PM");
      fixedCount++;
    }
  }
  Logger.log("Fixed " + fixedCount + " rows out of " + (lastRow - 1) + " data rows.");
}
