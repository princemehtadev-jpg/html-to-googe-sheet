#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SPREADSHEET_NAME = 'Dallah Clinics';
const DEFAULT_SPREADSHEET_ID = '10Bhfqts3cyyjy7VP0ENA08wNdwlLRGZ9JK4QaHJ2egU';
const BASE_REVENUE_TAB = 'Revenue';
const BASE_DEPARTMENT_TAB = 'Department Wise';
const OTHER_TAB = 'Other';
const UNKNOWN_LABEL = 'Unknown';

async function main() {
  const {
    files: fileArgs,
    clinicName,
    reportPeriod,
    medicalComplaints,
    administrativeComplaints,
    referrals,
    remarks,
  } = parseArgs(process.argv.slice(2));

  const spreadsheetId = process.env.SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;
  if (!spreadsheetId) {
    console.error('Provide the target spreadsheet ID via SPREADSHEET_ID env or as the first CLI argument.');
    process.exit(1);
  }

  const csvFiles = fileArgs.length ? fileArgs : discoverCsvFiles();
  if (!csvFiles.length) {
    console.error('No CSV files provided or found.');
    process.exit(1);
  }

  const { revenueRows, departmentRows } = loadDatasets(csvFiles);
  if (!revenueRows.length && !departmentRows.length) {
    console.error('No CSV data available to push.');
    process.exit(1);
  }

  const auth = await createServiceAccountAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const revenueTab = BASE_REVENUE_TAB;
  const departmentTab = BASE_DEPARTMENT_TAB;

  const datedRevenueRows = applyClinicColumn(applyDateColumn(revenueRows, reportPeriod), clinicName);
  const datedDepartmentRows = applyClinicColumn(applyDateColumn(departmentRows, reportPeriod), clinicName);

  const normalizedRevenueRows = ensureColumnsHaveValues(datedRevenueRows, ['doctor name']);
  const normalizedDepartmentRows = ensureColumnsHaveValues(datedDepartmentRows, ['department name', 'doctor name']);

  const formattedRevenueRows = formatNumericColumns(
    normalizedRevenueRows,
    new Set(['date', 'doctor id', 'doctor name', 'department id', 'department name'])
  );
  const formattedDepartmentRows = formatNumericColumns(
    normalizedDepartmentRows,
    new Set(['date', 'doctor id', 'doctor name', 'department id', 'department name'])
  );

if (formattedRevenueRows.length) {
  await pushToSheet(sheets, spreadsheetId, revenueTab, formattedRevenueRows);
  await ensureDateColumnFormat(sheets, spreadsheetId, revenueTab, formattedRevenueRows[0]);
} else {
  console.warn('No revenue data detected in the provided CSV files.');
}

if (formattedDepartmentRows.length) {
  await pushToSheet(sheets, spreadsheetId, departmentTab, formattedDepartmentRows);
  await ensureDateColumnFormat(sheets, spreadsheetId, departmentTab, formattedDepartmentRows[0]);
} else {
  console.warn('No department data detected in the provided CSV files.');
}

  await appendOtherMetricsRow(sheets, spreadsheetId, {
    clinicName,
    reportPeriod,
    medicalComplaints,
    administrativeComplaints,
    referrals,
    remarks,
  });

  console.log(`Finished syncing data to "${SPREADSHEET_NAME}" (${spreadsheetId}).`);
}

function discoverCsvFiles() {
  return fs
    .readdirSync(process.cwd())
    .filter((name) => name.toLowerCase().endsWith('.csv'))
    .map((file) => path.resolve(process.cwd(), file));
}

function loadDatasets(files) {
  const revenueRows = [];
  const departmentRows = [];

  files.forEach((file) => {
    const rows = parseCsv(file);
    if (!rows.length) return;

    const header = rows[0].map((cell) => cell.trim().toLowerCase());
    const isDepartmentData = header.includes('department id');
    if (isDepartmentData) {
      appendDataset(departmentRows, rows);
    } else {
      appendDataset(revenueRows, rows);
    }
  });

  return { revenueRows, departmentRows };
}

function appendDataset(target, rows) {
  if (!rows.length) return;

  if (!target.length) {
    target.push(...cloneRows(rows));
    return;
  }

  const [, ...dataRows] = rows;
  target.splice(target.length, 0, ...cloneRows(dataRows));
}

function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length)
    .map((line) => splitCsvLine(line));
}

function parseArgs(args) {
  const files = [];
  let clinic = process.env.CLINIC_NAME || '';
  let reportPeriod = process.env.REPORT_PERIOD || '';
  let medical = process.env.MEDICAL_COMPLAINTS || '';
  let administrative = process.env.ADMINISTRATIVE_COMPLAINTS || '';
  let referrals = process.env.REFERRALS || '';
  let remarks = process.env.REMARKS || '';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--clinic' && args[i + 1]) { clinic = args[i + 1]; i += 1; continue; }
    if (arg.startsWith('--clinic=')) { clinic = arg.split('=').slice(1).join('='); continue; }

    if (arg === '--date' && args[i + 1]) { reportPeriod = args[i + 1]; i += 1; continue; }
    if (arg.startsWith('--date=')) { reportPeriod = arg.split('=').slice(1).join('='); continue; }

    if (arg === '--medical' && args[i + 1]) { medical = args[i + 1]; i += 1; continue; }
    if (arg.startsWith('--medical=')) { medical = arg.split('=').slice(1).join('='); continue; }

    if (arg === '--administrative' && args[i + 1]) { administrative = args[i + 1]; i += 1; continue; }
    if (arg.startsWith('--administrative=')) { administrative = arg.split('=').slice(1).join('='); continue; }

    if (arg === '--referrals' && args[i + 1]) { referrals = args[i + 1]; i += 1; continue; }
    if (arg.startsWith('--referrals=')) { referrals = arg.split('=').slice(1).join('='); continue; }

    if (arg === '--remarks' && args[i + 1]) { remarks = args[i + 1]; i += 1; continue; }
    if (arg.startsWith('--remarks=')) { remarks = arg.split('=').slice(1).join('='); continue; }

    files.push(arg);
  }

  return {
    files,
    clinicName: clinic.trim(),
    reportPeriod: reportPeriod.trim(),
    medicalComplaints: medical.trim(),
    administrativeComplaints: administrative.trim(),
    referrals: referrals.trim(),
    remarks: remarks.trim(),
  };
}

async function appendOtherMetricsRow(
  sheets,
  spreadsheetId,
  { clinicName, reportPeriod, medicalComplaints, administrativeComplaints, referrals, remarks },
) {
  if (!clinicName || !reportPeriod) return;

  const normalizedDate = normalizePeriod(reportPeriod);
  const row = [
    normalizedDate,
    clinicName,
    Number(medicalComplaints) || 0,
    Number(administrativeComplaints) || 0,
    Number(referrals) || 0,
    remarks || '',
  ];

  await pushToSheet(sheets, spreadsheetId, OTHER_TAB, [
    ['Date', 'Clinic', 'Medical Complaints', 'Administrative Complaints', 'Referrals', 'Remarks'],
    row,
  ]);
}

function applyDateColumn(rows, reportPeriod) {
  if (!reportPeriod || !rows.length) return rows;

  const normalizedDate = normalizePeriod(reportPeriod);
  const [header, ...dataRows] = cloneRows(rows);
  const lowerHeader = header.map((cell) => cell.trim().toLowerCase());
  const dateIndex = lowerHeader.indexOf('date');

  if (dateIndex === -1) {
    const newHeader = ['Date', ...header];
    const newRows = dataRows.map((row) => [normalizedDate, ...row]);
    return [newHeader, ...newRows];
  }

  const updatedRows = dataRows.map((row) => {
    const copy = [...row];
    copy[dateIndex] = normalizedDate;
    return copy;
  });

  return [header, ...updatedRows];
}

function applyClinicColumn(rows, clinicName) {
  if (!rows.length) return rows;

  const normalizedClinic = clinicName ? clinicName.trim() : UNKNOWN_LABEL;
  const [header, ...dataRows] = cloneRows(rows);
  const lowerHeader = header.map((cell) => cell.trim().toLowerCase());
  const clinicIndex = lowerHeader.indexOf('clinic');

  if (clinicIndex === -1) {
    const newHeader = ['Clinic', ...header];
    const newRows = dataRows.map((row) => [normalizedClinic, ...row]);
    return [newHeader, ...newRows];
  }

  const updatedRows = dataRows.map((row) => {
    const copy = [...row];
    copy[clinicIndex] = normalizedClinic;
    return copy;
  });

  return [header, ...updatedRows];
}

/** Convert Excel/Google Sheets serial day number to YYYY-MM-DD (UTC). */
function excelSerialToIsoDate(serial) {
  const base = new Date(Date.UTC(1899, 11, 30)); // 1899-12-30
  const ms = Number(serial) * 24 * 60 * 60 * 1000;
  const d = new Date(base.getTime() + ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizePeriod(period) {
  const trimmed = String(period).trim();
  if (!trimmed) return '';

  // Excel/Sheets serial like 45870 or 45870.0
  if (/^\d+(\.0+)?$/.test(trimmed)) {
    return excelSerialToIsoDate(Math.trunc(Number(trimmed)));
  }

  // ISO-like: 2025-08 or 2025-08-01
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${month}-${day || '01'}`;
  }

  // Fallback (USER_ENTERED will try to parse)
  return trimmed;
}

function cloneRows(rows) {
  return rows.map((row) => [...row]);
}

function ensureColumnsHaveValues(rows, columnNames) {
  if (!rows.length || !columnNames.length) return rows;

  return columnNames.reduce(
    (currentRows, columnName) => ensureColumnHasValue(currentRows, columnName),
    rows
  );
}

function ensureColumnHasValue(rows, columnName) {
  if (!rows.length) return rows;

  const [header, ...dataRows] = rows;
  const targetIndex = header.findIndex(
    (cell) => cell && cell.trim().toLowerCase() === columnName
  );

  if (targetIndex === -1) return rows;

  const normalizedRows = dataRows.map((row) => {
    const copy = [...row];
    if (isMissingValue(copy[targetIndex])) {
      copy[targetIndex] = UNKNOWN_LABEL;
    }
    return copy;
  });

  return [header, ...normalizedRows];
}

function isMissingValue(value) {
  if (value === undefined || value === null) return true;

  const text = String(value).trim();
  if (!text) return true;

  const lower = text.toLowerCase();
  return lower === 'null' || lower === 'undefined';
}

function formatNumericColumns(rows, exclusionSet) {
  if (!rows.length) return rows;

  const [header, ...dataRows] = rows;
  const numericIndices = detectNumericColumnIndices(header, dataRows, exclusionSet);

  const formattedRows = dataRows.map((row) => {
    const copy = [...row];
    numericIndices.forEach((index) => {
      if (copy[index] === '' || copy[index] === undefined) {
        copy[index] = 0;
        return;
      }
      const normalized = Number(copy[index]);
      copy[index] = Number.isFinite(normalized) ? normalized : 0;
    });
    return copy;
  });

  return [header, ...formattedRows];
}

function findColumnIndex(header, columnName) {
  return header.findIndex(
    (cell) => cell && cell.trim().toLowerCase() === columnName.trim().toLowerCase()
  );
}

async function removeRowsForDate(sheets, spreadsheetId, tabName, targetDate, clinicName = null) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A:ZZ`,
    });

    const values = response.data.values || [];
    if (!values.length) return;

    const header = values[0];
    const dateIdx = findColumnIndex(header, 'date');
    if (dateIdx === -1) return;

    const clinicIdx = clinicName !== null ? findColumnIndex(header, 'clinic') : -1;
    const normalizedTarget = normalizePeriod(targetDate);
    const filteredRows = values.slice(1).filter((row) => {
      const rowDate = row[dateIdx] || '';
      if (normalizePeriod(rowDate) !== normalizedTarget) return true;

      if (clinicIdx === -1 || clinicName === null) return false;
      return (row[clinicIdx] || '') !== clinicName;
    });

    if (filteredRows.length === values.length - 1) return;

    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${tabName}!A:ZZ`,
    });

    const newValues = [header, ...filteredRows];
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: newValues },
    });
  } catch (error) {
    if (error.code === 400 || error.code === 404) return;
    throw error;
  }
}

function detectNumericColumnIndices(header, dataRows, exclusionSet) {
  return header.reduce((indices, cell, idx) => {
    const key = cell ? cell.trim().toLowerCase() : '';
    if (!key || exclusionSet.has(key)) return indices;

    let seenNumeric = false;
    let seenNonNumeric = false;

    for (let i = 0; i < dataRows.length; i += 1) {
      const value = dataRows[i][idx];
      if (value === undefined || value === '') continue;

      const numericValue = Number(value);
      if (Number.isFinite(numericValue)) {
        seenNumeric = true;
      } else {
        seenNonNumeric = true;
        break;
      }
    }

    if (seenNumeric && !seenNonNumeric) indices.push(idx);
    return indices;
  }, []);
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(cleanCellValue(current));
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(cleanCellValue(current));
  return cells;
}

function cleanCellValue(value) {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return trimmed.replace(/""/g, '"');
}

async function pushToSheet(sheets, spreadsheetId, tabName, rows) {
  if (!rows.length) return;

  const dateIndex = findColumnIndex(rows[0], 'date');
  const targetDate = dateIndex !== -1 && rows.length > 1 ? rows[1][dateIndex] : null;
  const clinicIndex = findColumnIndex(rows[0], 'clinic');
  const targetClinic = clinicIndex !== -1 && rows.length > 1 ? rows[1][clinicIndex] : null;

  if (dateIndex !== -1 && targetDate) {
    await removeRowsForDate(sheets, spreadsheetId, tabName, targetDate, targetClinic);
  }

  const range = `${tabName}!A1`;
  let hasExistingData = false;

  try {
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!1:1` });
    hasExistingData = Array.isArray(existing.data.values) && existing.data.values.length > 0;
  } catch (error) {
    if (error.code !== 400 && error.code !== 404) throw error;
  }

  const valuesToAppend = hasExistingData ? rows.slice(1) : rows;
  if (!valuesToAppend.length) {
    console.log(`No new rows to append for "${tabName}".`);
    return;
  }

  console.log(`Appending ${valuesToAppend.length} row(s) to "${tabName}" (header preserved: ${hasExistingData}).`);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: valuesToAppend },
  });
}

async function createServiceAccountAuth() {
  const serviceAccountPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error('Missing .env service account file. Place the JSON credentials inside .env.');
  }

  const raw = fs.readFileSync(serviceAccountPath, 'utf8');
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error('Unable to parse .env. Ensure it contains valid JSON for the service account.');
  }

  const privateKey = credentials.private_key ? credentials.private_key.replace(/\\n/g, '\n') : null;

  return new google.auth.JWT({
    email: credentials.client_email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// ---------------- DATE COLUMN FORMAT HELPERS ----------------

async function getSheetIdByTitle(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });
  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties && s.properties.title === title
  );
  return sheet ? sheet.properties.sheetId : null;
}

/** Force the 'Date' column to use DATE format (yyyy-mm-dd). */
async function ensureDateColumnFormat(sheets, spreadsheetId, tabName, headerRow) {
  const dateColIdx = findColumnIndex(headerRow, 'date');
  if (dateColIdx === -1) return;

  const sheetId = await getSheetIdByTitle(sheets, spreadsheetId, tabName);
  if (sheetId == null) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1, // skip header row
              startColumnIndex: dateColIdx,
              endColumnIndex: dateColIdx + 1,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' },
                horizontalAlignment: 'LEFT',
              },
            },
            fields: 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment',
          },
        },
      ],
    },
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
