#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function main() {
  const cliArgs = process.argv.slice(2);
  const files = cliArgs.length ? cliArgs : discoverHtmlFiles();

  if (!files.length) {
    console.error('No HTML files provided or found in the current directory.');
    process.exit(1);
  }

  files.forEach((file) => {
    try {
      convertHtmlToCsv(path.resolve(file));
    } catch (error) {
      console.error(`Failed to convert ${file}: ${error.message}`);
      process.exitCode = 1;
    }
  });
}

function discoverHtmlFiles() {
  return fs
    .readdirSync(process.cwd())
    .filter((name) => name.toLowerCase().endsWith('.html'));
}

function convertHtmlToCsv(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const rows = extractRows(html);
  const normalized = normalizeRows(rows);

  if (!normalized.length) {
    console.warn(`No table rows found in ${filePath}. Skipping.`);
    return;
  }

  const csvContent = normalized
    .map((row) => row.map(csvEscape).join(','))
    .join('\n');
  const outputPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath, path.extname(filePath))}.csv`,
  );

  fs.writeFileSync(outputPath, csvContent);
  console.log(`Created ${outputPath} with ${normalized.length} rows.`);
}

function extractRows(html) {
  const rows = [];
  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  rowMatches.forEach((rowHtml) => {
    const cellMatches = rowHtml.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    if (!cellMatches.length) {
      return;
    }

    const row = [];
    cellMatches.forEach((cellHtml) => {
      const cellText = cleanCell(cellHtml);
      const colspan = extractSpan(cellHtml, 'colspan');

      row.push(cellText);
      for (let i = 1; i < colspan; i += 1) {
        row.push('');
      }
    });

    const compactRow = compressRow(row);
    if (compactRow) {
      rows.push(compactRow);
    }
  });

  return rows;
}

function compressRow(row) {
  const filtered = row.filter((cell) => cell !== '');
  return filtered.length ? filtered : null;
}

function normalizeRows(rows) {
  const cleaned = rows.filter((row) => !isTotalsRow(row));
  if (looksLikeDepartmentReport(cleaned)) {
    return normalizeDepartmentReport(cleaned);
  }

  return cleaned;
}

function isTotalsRow(row) {
  if (!row.length || !row[0]) {
    return false;
  }

  const label = row[0].replace(/[:]/g, '').trim().toLowerCase();
  return (
    label === 'total' ||
    label === 'totals' ||
    label === 'grand totals' ||
    label === 'grand total'
  );
}

function looksLikeDepartmentReport(rows) {
  const hasDeptRow = rows.some((row) => isDepartmentRow(row));
  const hasDoctorHeader = rows.some(
    (row) => row[0] && row[0].trim().toLowerCase() === 'doctor name',
  );

  return hasDeptRow && hasDoctorHeader;
}

function normalizeDepartmentReport(rows) {
  const result = [];
  let currentDepartment = null;
  let metricsHeader = null;
  let metricsCount = 0;
  const departmentState = new Map();

  rows.forEach((row) => {
    if (isDepartmentRow(row)) {
      currentDepartment = parseIdAndName(row[0]);
      return;
    }

    if (row[0] && row[0].trim().toLowerCase() === 'doctor name') {
      metricsHeader = row.slice(1);
      metricsCount = metricsHeader.length;
      if (metricsHeader.length && !result.length) {
        result.push([
          'Department ID',
          'Department Name',
          'Doctor ID',
          'Doctor Name',
          ...metricsHeader,
        ]);
      }
      return;
    }

    if (!currentDepartment || !metricsHeader || row.length < 2) {
      return;
    }

    if (isTotalsRow(row)) {
      return;
    }

    const parsedDoctor = parseIdAndName(row[0]);
    let doctorId = '';
    let doctorName = '';
    let metricCells;

    if (row.length === metricsCount) {
      metricCells = row.slice(0, metricsCount);
    } else if (parsedDoctor) {
      doctorId = parsedDoctor.id;
      doctorName = parsedDoctor.name;
      metricCells = row.slice(1);
    } else {
      doctorName = row[0] || '';
      metricCells = row.slice(1);
    }

    if (!metricCells.length) {
      return;
    }

    const departmentId = currentDepartment.id;
    const state =
      departmentState.get(departmentId) || { doctors: 0, summaryAdded: false };
    const hasDoctorData = doctorId || doctorName;

    if (!hasDoctorData) {
      if (state.summaryAdded || state.doctors > 0) {
        departmentState.set(departmentId, state);
        return;
      }
      state.summaryAdded = true;
    } else {
      state.doctors += 1;
    }
    departmentState.set(departmentId, state);

    result.push([
      currentDepartment.id,
      currentDepartment.name,
      doctorId,
      doctorName,
      ...padMetrics(metricCells, metricsCount),
    ]);
  });

  return result.length ? result : rows;
}

function isDepartmentRow(row) {
  return row.length === 1 && !!parseIdAndName(row[0]);
}

function parseIdAndName(value) {
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d+)\s*-\s*(.+)$/);
  if (!match) {
    return null;
  }

  return {
    id: match[1],
    name: match[2].trim(),
  };
}

function padMetrics(cells, desiredLength) {
  const padded = cells.slice(0, desiredLength);
  while (padded.length < desiredLength) {
    padded.push('');
  }
  return padded;
}

function cleanCell(cellHtml) {
  const innerHtml = cellHtml
    .replace(/^<t[dh][^>]*?>/i, '')
    .replace(/<\/t[dh]>$/i, '');

  const text = innerHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return decodeEntities(text);
}

function extractSpan(cellHtml, attributeName) {
  const match = cellHtml.match(
    new RegExp(`${attributeName}\\s*=\\s*["']?(\\d+)`, 'i'),
  );
  if (!match) {
    return 1;
  }

  const span = parseInt(match[1], 10);
  return Number.isFinite(span) && span > 1 ? span : 1;
}

const htmlEntities = {
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

    if (htmlEntities[lower]) {
      return htmlEntities[lower];
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

  const needsQuotes = /[",\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

main();
