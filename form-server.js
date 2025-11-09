#!/usr/bin/env node

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 4000;
const uploadDir = path.join(__dirname, 'uploads');

ensureDirectory(uploadDir);

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
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
    try {
      const revenueUpload = req.files.revenueFile?.[0] || null;
      const departmentUpload = req.files.departmentFile?.[0] || null;

      if (!revenueUpload && !departmentUpload) {
        throw new Error('Please upload at least one HTML report.');
      }

      const metadata = {
        clinic: req.body.clinic || '',
        reportDate: req.body.reportDate || '',
        complaints: req.body.complaints || '',
        complaintType: req.body.complaintType || '',
        remarks: req.body.remarks || '',
        referrals: req.body.referrals || '',
      };

      const allUploads = [revenueUpload, departmentUpload].filter(Boolean);
      const csvOutputs = [];
      const savedInputs = [];

      for (const uploadFile of allUploads) {
        savedInputs.push(uploadFile.path);
        const csvPath = await ensureCsv(uploadFile.path);
        csvOutputs.push(csvPath);
      }

      await syncSheets(csvOutputs, metadata.clinic, metadata.reportDate);
      await cleanupFiles([...savedInputs, ...csvOutputs]);

      res.send(renderSuccess(metadata, savedInputs, csvOutputs));
    } catch (error) {
      console.error(error);
      res.status(500).send(renderForm(error.message));
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

  return new Promise((resolve, reject) => {
    execFile(
      'node',
      ['html-to-csv.js', filePath],
      { cwd: __dirname },
      (error) => {
        if (error) {
          reject(
            new Error(
              `Failed to convert ${path.basename(filePath)}: ${error.message}`,
            ),
          );
          return;
        }

        const csvPath = filePath.replace(/\.html?$/i, '.csv');
        resolve(csvPath);
      },
    );
  });
}

function syncSheets(csvPaths, clinicName, reportDate) {
  return new Promise((resolve, reject) => {
    const args = ['sync-to-sheets.js'];
    if (clinicName) {
      args.push('--clinic', clinicName);
    }
    if (reportDate) {
      args.push('--date', reportDate);
    }
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

async function cleanupFiles(filePaths) {
  const uniquePaths = [...new Set(filePaths)].filter(Boolean);
  await Promise.all(
    uniquePaths.map(async (filePath) => {
      try {
        await fs.promises.unlink(filePath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.warn(`Unable to remove ${filePath}: ${error.message}`);
        }
      }
    }),
  );
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
        <input type="file" id="revenueFile" name="revenueFile" accept=".html,.htm,.csv">
      </div>
      <div class="field">
        <label for="departmentFile">Select Department File:</label>
        <input type="file" id="departmentFile" name="departmentFile" accept=".html,.htm,.csv">
      </div>
      <div class="field">
        <label for="clinic">Select Clinic:</label>
        <select id="clinic" name="clinic">
          <option value="Al Yarmouk">Al Yarmouk</option>
          <option value="Qurtubah">Qurtubah</option>
          <option value="Al Salam">Al Salam</option>
          <option value="Al Areed">Al Areed</option>
          <option value="Executive">Executive</option>
        </select>
      </div>
      <div class="field">
        <label for="reportDate">Select Date:</label>
        <input type="date" id="reportDate" name="reportDate">
      </div>
      <div class="field">
        <label for="complaints">Number of Complaints (عدد الشكاوى اليوم):</label>
        <input type="number" min="0" id="complaints" name="complaints" placeholder="0">
      </div>
      <div class="field">
        <label for="complaintType">Complaint Type:</label>
        <select id="complaintType" name="complaintType">
          <option value="Medical">Medical</option>
          <option value="Service">Service</option>
          <option value="Insurance">Insurance</option>
        </select>
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
    ['Date', metadata.reportDate || '-'],
    ['Complaints', metadata.complaints || '0'],
    ['Complaint Type', metadata.complaintType || '-'],
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

function escapeHtml(value) {
  return value
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
