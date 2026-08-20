// Jarvis reminders endpoint.
// Paste into Extensions > Apps Script on a Google Sheet, then deploy as a
// Web App (Execute as: Me, Who has access: Anyone with the link).
// Copy the deployment URL into Netlify as REMINDERS_APPS_SCRIPT_URL.

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  var action = body.action;

  if (action === "add") {
    return addReminder(body.message, body.dueAt);
  } else if (action === "checkDue") {
    return checkDue();
  }

  return jsonResponse({ error: "Unknown action: " + action });
}

function addReminder(message, dueAt) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Reminders");
  if (!sheet) {
    sheet = ss.insertSheet("Reminders");
    sheet.appendRow(["DueAt", "Message", "Status"]);
  }
  var dueDate = new Date(dueAt);
  sheet.appendRow([dueDate, message, "pending"]);
  sheet.getRange(sheet.getLastRow(), 1).setNumberFormat("M/D/YYYY h:mm AM/PM");
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
      due.push({ message: data[i][1] });
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
