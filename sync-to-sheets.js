#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SPREADSHEET_NAME = 'Dallah Clinics';
const DEFAULT_SPREADSHEET_ID = '10Bhfqts3cyyjy7VP0ENA08wNdwlLRGZ9JK4QaHJ2egU';
const BASE_REVENUE_TAB = 'Revenue';
const BASE_DEPARTMENT_TAB = 'Department Wise';

async function main() {
  const { files: fileArgs, clinicName, reportDate } = parseArgs(
    process.argv.slice(2),
  );
  const spreadsheetId =
    process.env.SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;
  if (!spreadsheetId) {
    console.error(
      'Provide the target spreadsheet ID via SPREADSHEET_ID env or as the first CLI argument.',
    );
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

  const revenueTab = buildTabName(BASE_REVENUE_TAB, clinicName);
  const departmentTab = buildTabName(BASE_DEPARTMENT_TAB, clinicName);

  const datedRevenueRows = applyDateColumn(revenueRows, reportDate);
  const datedDepartmentRows = applyDateColumn(departmentRows, reportDate);

  if (datedRevenueRows.length) {
    await pushToSheet(
      sheets,
      spreadsheetId,
      revenueTab,
      datedRevenueRows,
    );
  } else {
    console.warn('No revenue data detected in the provided CSV files.');
  }

  if (datedDepartmentRows.length) {
    await pushToSheet(
      sheets,
      spreadsheetId,
      departmentTab,
      datedDepartmentRows,
    );
  } else {
    console.warn('No department data detected in the provided CSV files.');
  }

  console.log(
    `Finished syncing data to "${SPREADSHEET_NAME}" (${spreadsheetId}).`,
  );
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
    if (!rows.length) {
      return;
    }

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
  if (!rows.length) {
    return;
  }

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
  let reportDate = process.env.REPORT_DATE || '';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--clinic' && args[i + 1]) {
      clinic = args[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--clinic=')) {
      clinic = arg.split('=').slice(1).join('=');
      continue;
    }

    if (arg === '--date' && args[i + 1]) {
      reportDate = args[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--date=')) {
      reportDate = arg.split('=').slice(1).join('=');
      continue;
    }

    files.push(arg);
  }

  return {
    files,
    clinicName: clinic.trim(),
    reportDate: reportDate.trim(),
  };
}

function buildTabName(base, clinic) {
  return clinic ? `${clinic} ${base}` : base;
}

function applyDateColumn(rows, reportDate) {
  if (!reportDate || !rows.length) {
    return rows;
  }

  const [header, ...dataRows] = cloneRows(rows);
  const lowerHeader = header.map((cell) => cell.trim().toLowerCase());
  const dateIndex = lowerHeader.indexOf('date');

  if (dateIndex === -1) {
    const newHeader = [...header, 'Date'];
    const newRows = dataRows.map((row) => [...row, reportDate]);
    return [newHeader, ...newRows];
  }

  const updatedRows = dataRows.map((row) => {
    const copy = [...row];
    copy[dateIndex] = reportDate;
    return copy;
  });

  return [header, ...updatedRows];
}

function cloneRows(rows) {
  return rows.map((row) => [...row]);
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
  if (trimmed === '') {
    return '';
  }

  return trimmed.replace(/""/g, '"');
}

async function pushToSheet(sheets, spreadsheetId, tabName, rows) {
  const range = `${tabName}!A1`;
  console.log(`Updating "${tabName}" with ${rows.length} rows...`);

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${tabName}!A:ZZ`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: {
      values: rows,
    },
  });
}

async function createServiceAccountAuth() {
  const serviceAccountPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(
      'Missing .env service account file. Place the JSON credentials inside .env.',
    );
  }

  const raw = fs.readFileSync(serviceAccountPath, 'utf8');
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      'Unable to parse .env. Ensure it contains valid JSON for the service account.',
    );
  }

  const privateKey = credentials.private_key
    ? credentials.private_key.replace(/\\n/g, '\n')
    : null;

  return new google.auth.JWT({
    email: credentials.client_email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
