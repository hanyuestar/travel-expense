/* csv.js — 轻量 CSV 序列化（零依赖）：单元格转义 + BOM + CRLF */
'use strict';

function cell(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* rows: 数组的数组，与 head 等长（不足补空，多余丢弃） */
function toCsv(head, rows) {
  const lines = [head.map(cell).join(',')];
  for (const row of rows) {
    lines.push(head.map((_, i) => cell(row[i])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

module.exports = { cell, toCsv };
