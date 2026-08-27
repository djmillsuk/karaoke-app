'use strict';

/**
 * Minimal RFC-4180 CSV parser. Handles quoted fields, escaped quotes,
 * embedded newlines and both LF / CRLF line endings.
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      sawAnyChar = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      sawAnyChar = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (sawAnyChar || row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
      sawAnyChar = false;
    } else {
      field += ch;
      sawAnyChar = true;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
  }

  return rows;
}

module.exports = { parseCsv };
