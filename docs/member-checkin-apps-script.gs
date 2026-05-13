const MEMBERS_SHEET_NAME = "Members";
const ATTENDANCE_SHEET_NAME = "Attendance";

// Optional but recommended: paste the long ID from your Google Sheet URL here.
// Example URL:
// https://docs.google.com/spreadsheets/d/PASTE_THIS_PART_HERE/edit
const SPREADSHEET_ID = "";

const MEMBER_HEADERS = [
  "MemberID",
  "CardID",
  "Name",
  "Email",
  "Phone",
  "Membership",
  "Status",
  "JoinDate",
  "Notes",
  "UpdatedAt",
];

const ATTENDANCE_HEADERS = [
  "VisitID",
  "MemberID",
  "CardID",
  "MemberName",
  "Membership",
  "Status",
  "CheckInAt",
  "CheckOutAt",
  "UpdatedAt",
];

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const action = String(body.action || "").trim();
    const payload = body.payload || {};

    if (action === "membershipSnapshot") {
      return jsonResponse_({
        ok: true,
        members: readMembers_(),
        visits: readAttendance_(),
      });
    }

    if (action === "upsertMember") {
      const member = upsertMember_(payload);
      return jsonResponse_({ ok: true, member });
    }

    if (action === "checkInMember") {
      const visit = upsertVisit_(payload);
      return jsonResponse_({ ok: true, visit });
    }

    if (action === "checkOutMember") {
      const visit = upsertVisit_(payload);
      return jsonResponse_({ ok: true, visit });
    }

    return jsonResponse_({ ok: false, error: "Unknown action: " + action });
  } catch (error) {
    return jsonResponse_({ ok: false, error: error.message || String(error) });
  }
}

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "membershipSnapshot").trim();
    const callback = String((e && e.parameter && e.parameter.callback) || "").trim();

    if (action === "membershipSnapshot") {
      return response_({
        ok: true,
        message: "JMT membership check-in backend is running.",
        members: readMembers_(),
        visits: readAttendance_(),
      }, callback);
    }

    return response_({ ok: false, error: "Unknown action: " + action }, callback);
  } catch (error) {
    return response_({ ok: false, error: error.message || String(error) }, "");
  }
}

function getSpreadsheet_() {
  if (SPREADSHEET_ID) {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("No spreadsheet found. Open your Google Sheet, use Extensions > Apps Script, or paste the Sheet ID into SPREADSHEET_ID.");
  }

  return spreadsheet;
}

function upsertMember_(payload) {
  const sheet = getSheet_(MEMBERS_SHEET_NAME, MEMBER_HEADERS);
  const member = {
    MemberID: String(payload.memberId || payload.MemberID || Utilities.getUuid()).trim(),
    CardID: String(payload.cardId || payload.CardID || "").trim().toUpperCase(),
    Name: String(payload.name || payload.Name || "").trim(),
    Email: String(payload.email || payload.Email || "").trim(),
    Phone: String(payload.phone || payload.Phone || "").trim(),
    Membership: String(payload.membership || payload.Membership || "").trim(),
    Status: String(payload.status || payload.Status || "Active").trim(),
    JoinDate: String(payload.joinDate || payload.JoinDate || "").trim(),
    Notes: String(payload.notes || payload.Notes || "").trim(),
    UpdatedAt: new Date().toISOString(),
  };

  if (!member.CardID) {
    member.CardID = member.MemberID.toUpperCase();
  }

  const row = findRowByValue_(sheet, "MemberID", member.MemberID);
  writeObjectToRow_(sheet, MEMBER_HEADERS, member, row || sheet.getLastRow() + 1);

  return member;
}

function upsertVisit_(payload) {
  const sheet = getSheet_(ATTENDANCE_SHEET_NAME, ATTENDANCE_HEADERS);
  const visit = {
    VisitID: String(payload.visitId || payload.VisitID || Utilities.getUuid()).trim(),
    MemberID: String(payload.memberId || payload.MemberID || "").trim(),
    CardID: String(payload.cardId || payload.CardID || "").trim().toUpperCase(),
    MemberName: String(payload.memberName || payload.MemberName || "").trim(),
    Membership: String(payload.membership || payload.Membership || "").trim(),
    Status: String(payload.status || payload.Status || "").trim(),
    CheckInAt: String(payload.checkInAt || payload.CheckInAt || "").trim(),
    CheckOutAt: String(payload.checkOutAt || payload.CheckOutAt || "").trim(),
    UpdatedAt: new Date().toISOString(),
  };

  const row = findRowByValue_(sheet, "VisitID", visit.VisitID);
  writeObjectToRow_(sheet, ATTENDANCE_HEADERS, visit, row || sheet.getLastRow() + 1);

  return visit;
}

function readMembers_() {
  return readSheetObjects_(getSheet_(MEMBERS_SHEET_NAME, MEMBER_HEADERS)).map(function(row) {
    return {
      memberId: row.MemberID,
      cardId: row.CardID,
      name: row.Name,
      email: row.Email,
      phone: row.Phone,
      membership: row.Membership,
      status: row.Status,
      joinDate: row.JoinDate,
      notes: row.Notes,
    };
  });
}

function readAttendance_() {
  return readSheetObjects_(getSheet_(ATTENDANCE_SHEET_NAME, ATTENDANCE_HEADERS)).map(function(row) {
    return {
      visitId: row.VisitID,
      memberId: row.MemberID,
      cardId: row.CardID,
      memberName: row.MemberName,
      membership: row.Membership,
      status: row.Status,
      checkInAt: row.CheckInAt,
      checkOutAt: row.CheckOutAt,
    };
  });
}

function getSheet_(name, headers) {
  const spreadsheet = getSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  const existingHeaders = sheet.getRange(1, 1, 1, Math.max(headers.length, sheet.getLastColumn() || 1)).getValues()[0];
  const missingHeaders = headers.some(function(header, index) {
    return existingHeaders[index] !== header;
  });

  if (sheet.getLastRow() === 0 || missingHeaders) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function readSheetObjects_(sheet) {
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];

  const headers = values[0];
  return values.slice(1).filter(function(row) {
    return row.some(function(cell) {
      return String(cell).trim() !== "";
    });
  }).map(function(row) {
    return headers.reduce(function(record, header, index) {
      record[header] = row[index] || "";
      return record;
    }, {});
  });
}

function findRowByValue_(sheet, headerName, value) {
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return null;

  const columnIndex = values[0].indexOf(headerName);
  if (columnIndex < 0) return null;

  const target = String(value || "").trim();
  for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    if (String(values[rowIndex][columnIndex] || "").trim() === target) {
      return rowIndex + 1;
    }
  }

  return null;
}

function writeObjectToRow_(sheet, headers, record, rowNumber) {
  const values = headers.map(function(header) {
    return record[header] || "";
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([values]);
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function response_(payload, callback) {
  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + JSON.stringify(payload) + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return jsonResponse_(payload);
}
