#!/usr/bin/env node

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4000;
const uploadRoot = path.join(__dirname, 'uploads');
ensureDirectory(uploadRoot);

const storage = multer.diskStorage({
  destination: (req, _, cb) => {
    if (!req.uploadWorkspace) {
      req.uploadWorkspace = fs.mkdtempSync(path.join(uploadRoot, 'batch-'));
    }
    cb(null, req.uploadWorkspace);
  },
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname) || '.html';
    cb(null, `${Date.now()}-${file.fieldname}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.html', '.htm', '.csv'].includes(ext)) {
      cb(new Error('Only HTML or CSV report files are allowed.'));
      return;
    }
    cb(null, true);
  },
});

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send(renderForm());
});

app.post(
  '/submit',
  upload.fields([
    { name: 'revenueFile', maxCount: 1 },
    { name: 'departmentFile', maxCount: 1 },
  ]),
  async (req, res) => {
    let workspaceDir = null;
    try {
      const revenueUpload = req.files.revenueFile?.[0] || null;
      const departmentUpload = req.files.departmentFile?.[0] || null;

      // Require both files
      if (!revenueUpload || !departmentUpload) {
        throw new Error('Please upload both Revenue and Department reports.');
      }

      // Require clinic selection
      const clinic = sanitizeText(req.body.clinic);
      if (!clinic) {
        throw new Error('Please select a clinic.');
      }

      const metadata = {
        clinic,
        reportPeriod: (req.body.reportPeriod || '').trim(),
        complaintsMedical: normalizeNumber(req.body.complaintsMedical),
        complaintsAdministrative: normalizeNumber(
          req.body.complaintsAdministrative,
        ),
        remarks: sanitizeTextArea(req.body.remarks),
        referrals: normalizeNumber(req.body.referrals),
      };

      workspaceDir = req.uploadWorkspace;

      const allUploads = [revenueUpload, departmentUpload].filter(Boolean);
      const csvOutputs = [];
      const savedInputs = [];

      for (const uploadFile of allUploads) {
        savedInputs.push(uploadFile.path);
        const csvPath = await ensureCsv(uploadFile.path);
        csvOutputs.push(csvPath);
      }

      await syncSheets(csvOutputs, metadata);
      res.send(renderSuccess(metadata, savedInputs, csvOutputs));
    } catch (error) {
      console.error(error);
      res.status(500).send(renderForm(error.message));
    } finally {
    }
  },
);

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    res.status(400).send(renderForm(err.message));
    return;
  }
  next(err);
});

app.listen(PORT, () => {
  console.log(`Form server running on http://localhost:${PORT}`);
});

function ensureCsv(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') {
    return Promise.resolve(filePath);
  }

  return convertHtmlToCsv(filePath);
}

function syncSheets(csvPaths, metadata) {
  return new Promise((resolve, reject) => {
    const args = ['sync-to-sheets.js'];
    if (metadata.clinic) {
      args.push('--clinic', metadata.clinic);
    }
    if (metadata.reportPeriod) {
      args.push('--date', metadata.reportPeriod);
    }
    args.push('--medical', metadata.complaintsMedical);
    args.push('--administrative', metadata.complaintsAdministrative);
    args.push('--referrals', metadata.referrals);
    // Pass remarks using --remarks= to support empty string safely
    args.push(`--remarks=${metadata.remarks || ''}`);
    args.push(...csvPaths);

    execFile(
      'node',
      args,
      { cwd: __dirname },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Failed to sync data to Google Sheets: ${stderr || error.message}`,
            ),
          );
          return;
        }
        console.log(stdout);
        resolve();
      },
    );
  });
}

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function convertHtmlToCsv(htmlPath) {
  const html = await fs.promises.readFile(htmlPath, 'utf8');
  const rows = extractRows(html);
  if (!rows.length) {
    throw new Error(`No table data detected in ${path.basename(htmlPath)}.`);
  }

  const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  const csvPath = htmlPath.replace(/\.html?$/i, '.csv');
  await fs.promises.writeFile(csvPath, csv, 'utf8');
  return csvPath;
}

function extractRows(html) {
  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const rows = [];

  rowMatches.forEach((rowHtml) => {
    const cellMatches = rowHtml.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    if (!cellMatches.length) {
      return;
    }

    const row = [];
    cellMatches.forEach((cellHtml) => {
      const text = cleanCell(cellHtml);
      const colspan = extractSpan(cellHtml, 'colspan');
      row.push(text);
      for (let i = 1; i < colspan; i += 1) {
        row.push('');
      }
    });

    const compactRow = row.filter((cell) => cell !== '');
    if (compactRow.length) {
      rows.push(compactRow);
    }
  });

  return rows;
}

function cleanCell(cellHtml) {
  const inner = cellHtml
    .replace(/^<t[dh][^>]*>/i, '')
    .replace(/<\/t[dh]>$/i, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return decodeEntities(inner);
}

function extractSpan(cellHtml, attribute) {
  const match = cellHtml.match(
    new RegExp(`${attribute}\\s*=\\s*["']?(\\d+)`, 'i'),
  );
  if (!match) {
    return 1;
  }
  const span = Number.parseInt(match[1], 10);
  return Number.isFinite(span) && span > 1 ? span : 1;
}

const ENTITY_MAP = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (ENTITY_MAP[lower]) {
      return ENTITY_MAP[lower];
    }
    if (lower.startsWith('#x')) {
      return String.fromCharCode(parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith('#')) {
      return String.fromCharCode(parseInt(lower.slice(1), 10));
    }
    return match;
  });
}

function csvEscape(value) {
  if (value === undefined || value === null) {
    return '';
  }
  const str = String(value);
  const needsQuotes = /[",\n]/.test(str);
  const escaped = str.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

async function removeDirectory(dirPath) {
  try {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Unable to remove workspace ${dirPath}: ${error.message}`);
  }
}

function renderForm(errorMessage) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dallah Clinics Upload</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      margin: 0;
      min-height: 100vh;
      background: linear-gradient(135deg, #060b23, #101835);
      color: #f5f6fb;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px 16px;
    }
    .card {
      background: rgba(8, 12, 31, 0.9);
      border-radius: 18px;
      width: 100%;
      max-width: 520px;
      padding: 36px;
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    h1 {
      margin: 0 0 24px;
      font-size: 1.7rem;
      font-weight: 600;
      text-align: center;
    }
    label {
      display: block;
      margin-bottom: 8px;
      font-size: 0.95rem;
      font-weight: 600;
      letter-spacing: 0.01em;
    }
    input, select, textarea {
      width: 100%;
      border-radius: 12px;
      border: none;
      padding: 14px 16px;
      font-size: 0.95rem;
      background: rgba(255, 255, 255, 0.08);
      color: #e6e9f4;
      transition: background 0.2s ease;
    }
    input[type="file"] {
      padding: 10px;
      background: rgba(255, 255, 255, 0.12);
    }
    input:focus, select:focus, textarea:focus {
      outline: 2px solid rgba(117, 156, 255, 0.5);
      background: rgba(255, 255, 255, 0.12);
    }
    textarea {
      min-height: 110px;
      resize: vertical;
    }
    button {
      width: 100%;
      margin-top: 20px;
      padding: 15px;
      border-radius: 12px;
      border: none;
      background: linear-gradient(120deg, #7a93ff, #546dff);
      color: #fff;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 12px 24px rgba(84, 109, 255, 0.35);
    }
    .field {
      margin-bottom: 18px;
    }
    .error {
      background: rgba(255, 86, 92, 0.15);
      color: #ff9c9f;
      padding: 12px 16px;
      border-radius: 12px;
      margin-bottom: 18px;
      border: 1px solid rgba(255, 86, 92, 0.4);
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Dallah Clinics Upload</h1>
    ${errorMessage ? `<div class="error">${errorMessage}</div>` : ''}
    <form action="/submit" method="post" enctype="multipart/form-data">
      <div class="field">
        <label for="revenueFile">Select Revenue File:</label>
        <input type="file" id="revenueFile" name="revenueFile" accept=".html,.htm,.csv" required>
      </div>
      <div class="field">
        <label for="departmentFile">Select Department File:</label>
        <input type="file" id="departmentFile" name="departmentFile" accept=".html,.htm,.csv" required>
      </div>
      <div class="field">
        <label for="clinic">Select Clinic:</label>
        <select id="clinic" name="clinic" required>
          <option value="" selected disabled hidden>Select clinic</option>
          <option value="Al Yarmouk">Al Yarmouk</option>
          <option value="Qurtubah">Qurtubah</option>
          <option value="Al Salam">Al Salam</option>
          <option value="Al Areed">Al Areed</option>
          <option value="Executive">Executive</option>
        </select>
      </div>
      <div class="field">
        <label for="reportPeriod">Select Month & Year:</label>
        <input type="month" id="reportPeriod" name="reportPeriod" min="2020-01">
      </div>
      <div class="field">
        <label for="complaintsMedical">Number of Medical Complaints:</label>
        <input type="number" min="0" id="complaintsMedical" name="complaintsMedical" placeholder="0">
      </div>
      <div class="field">
        <label for="complaintsAdministrative">Number of Administrative Complaints:</label>
        <input type="number" min="0" id="complaintsAdministrative" name="complaintsAdministrative" placeholder="0">
      </div>
      <div class="field">
        <label for="remarks">Remarks (Optional):</label>
        <textarea id="remarks" name="remarks" placeholder="Enter remarks here (optional)"></textarea>
      </div>
      <div class="field">
        <label for="referrals">Number of Referral Patients:</label>
        <input type="number" min="0" id="referrals" name="referrals" placeholder="0">
      </div>
      <button type="submit">Submit</button>
    </form>
  </div>
</body>
</html>`;
}

function renderSuccess(metadata, htmlFiles, csvFiles) {
  const rows = [
    ['Clinic', metadata.clinic || '-'],
    ['Month & Year', metadata.reportPeriod || '-'],
    ['Medical Complaints', metadata.complaintsMedical || '0'],
    ['Administrative Complaints', metadata.complaintsAdministrative || '0'],
    ['Referrals', metadata.referrals || '0'],
    ['Remarks', metadata.remarks || '—'],
  ];

  const metaRows = rows
    .map(
      ([label, value]) =>
        `<tr><td><strong>${label}</strong></td><td>${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  const htmlList = htmlFiles
    .map((file) => `<li>${escapeHtml(path.basename(file))}</li>`)
    .join('');
  const csvList = csvFiles
    .map((file) => `<li>${escapeHtml(path.basename(file))}</li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Upload Complete</title>
  <style>
    body {
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background: #050913;
      color: #f5f6fb;
      min-height: 100vh;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px;
    }
    .card {
      background: rgba(13, 18, 35, 0.95);
      border-radius: 18px;
      width: 100%;
      max-width: 640px;
      padding: 32px;
      box-shadow: 0 25px 50px rgba(0,0,0,0.5);
      border: 1px solid rgba(255,255,255,0.06);
    }
    h1 { margin-top: 0; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    td { padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.08); }
    ul { margin: 0; padding-left: 18px; }
    a {
      display: inline-block;
      margin-top: 20px;
      padding: 12px 20px;
      border-radius: 10px;
      background: #556dff;
      color: #fff;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Upload Successful</h1>
    <p>The reports were converted and synced to Google Sheets.</p>
    <table>${metaRows}</table>
    <p><strong>Uploaded HTML files:</strong></p>
    <ul>${htmlList}</ul>
    <p><strong>Generated CSV files:</strong></p>
    <ul>${csvList}</ul>
    <a href="/">Upload another report</a>
  </div>
</body>
</html>`;
}

function sanitizeText(value) {
  return (value || '').trim();
}

function sanitizeTextArea(value) {
  return (value || '').trim();
}

function normalizeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function escapeHtml(value) {
  return value
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
