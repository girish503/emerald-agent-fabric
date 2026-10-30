const fs = require('fs');
const p = 'scripts/run-phase14-live-smoke.ts';
let s = fs.readFileSync(p, 'utf8');

// Find the taskDirective declaration
const marker = '  const taskDirective =\n';
const idx1 = s.indexOf(marker);
if (idx1 < 0) {
  // Try CRLF
  const markerCR = '  const taskDirective =\r\n';
  const idx1cr = s.indexOf(markerCR);
  if (idx1cr < 0) {
    console.error('FATAL: cannot find taskDirective declaration');
    process.exit(1);
  }
}

// Find the start of 'const taskDirective'
const startIdx = s.indexOf('const taskDirective =');
// Find the semicolon that ends the statement. The directive is a single-quoted string ending with ';
// We need to find the closing '; for the assignment
let searchFrom = startIdx + 'const taskDirective ='.length;
// The old directive is a single statement ending with ';'
// Find the first ';' after the declaration that ends this statement
let endIdx = s.indexOf("';", searchFrom);
if (endIdx < 0) {
  console.error('FATAL: cannot find end of taskDirective');
  process.exit(1);
}
endIdx += 2; // include the ';'

const oldStr = s.substring(startIdx, endIdx);
console.log('Found directive (' + oldStr.length + ' chars)');

const newDirective = `const taskDirective = [
    "Repair the failing math implementation.",
    "",
    "First read src/math.js.",
    "",
    "For read_file, use only:",
    '{"path":"src/math.js"}',
    "",
    "Do not include offsetLine, limitLines, or maxBytes unless you actually need them.",
    "If you include any of those optional numeric parameters, they must be integers >= 1.",
    "",
    "After inspecting the file, use write_file on:",
    '{"path":"src/math.js","content":"<corrected implementation>"}',
    "",
    "Only make the minimal code change required to fix the failing behavior.",
    "",
    "After the repair is applied, continue until you can truthfully determine that the task is complete.",
  ].join("\\n");`;

s = s.substring(0, startIdx) + newDirective + s.substring(endIdx);
fs.writeFileSync(p, s, 'utf8');
console.log('SUCCESS: directive replaced');
