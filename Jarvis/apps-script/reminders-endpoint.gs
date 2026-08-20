// Jarvis reminders endpoint.
// Paste into Extensions > Apps Script on a Google Sheet, then deploy as a
// Web App (Execute as: Me, Who has access: Anyone with the link).
// Copy the deployment URL into Netlify as REMINDERS_APPS_SCRIPT_URL.

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  var action = body.action;

  if (action === "add") {
    return addReminder(body.message, body.dueAt, body.type, body.targetNumber);
  } else if (action === "checkDue") {
    return checkDue();
  }

  return jsonResponse({ error: "Unknown action: " + action });
}

function addReminder(message, dueAt, type, targetNumber) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Reminders");
  if (!sheet) {
    sheet = ss.insertSheet("Reminders");
    sheet.appendRow(["DueAt", "Message", "Status", "Type", "TargetNumber"]);
  } else if (!sheet.getRange(1, 4).getValue()) {
    sheet.getRange(1, 4).setValue("Type");
    sheet.getRange(1, 5).setValue("TargetNumber");
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
    if (status === "pending" && dueAt <= now) {
      due.push({
        message: data[i][1],
        type: data[i][3] || "notify",
        targetNumber: data[i][4] || ""
      });
      sheet.getRange(i + 1, 3).setValue("sent");
    }
  }

  return jsonResponse({ due: due });
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
