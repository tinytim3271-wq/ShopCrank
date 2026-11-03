// Dependency-free PDF 1.4 writer for Workers: standard Helvetica fonts,
// WinAnsi text, US Letter pages. Enough for statements and reports.

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
// WinAnsi bytes for the few non-ASCII characters reports use.
const WIN_ANSI = { '·': 0xb7, '—': 0x97, '–': 0x96, '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '•': 0x95, '…': 0x85, 'é': 0xe9, 'ñ': 0xf1 };

function winAnsi(text) {
  let out = '';
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) out += char;
    else if (WIN_ANSI[char]) out += String.fromCharCode(WIN_ANSI[char]);
    else if (code === 0x09) out += ' ';
    else out += '?';
  }
  return out;
}

function pdfString(text) {
  return `(${winAnsi(text).replace(/[\\()]/g, match => `\\${match}`)})`;
}

/** Rough Helvetica advance width; good enough to keep columns from overlapping. */
export function textWidth(text, size) {
  return winAnsi(text).length * size * 0.52;
}

function fit(text, size, width) {
  const value = winAnsi(text);
  if (!width || textWidth(value, size) <= width) return value;
  const max = Math.max(1, Math.floor(width / (size * 0.52)) - 3);
  return `${value.slice(0, max)}...`;
}

function layoutPage(items) {
  const pages = [[]];
  let y = PAGE_HEIGHT - MARGIN;
  const ops = () => pages[pages.length - 1];
  const ensure = height => {
    if (y - height >= MARGIN) return;
    pages.push([]);
    y = PAGE_HEIGHT - MARGIN;
  };
  for (const item of items) {
    if (item.gap) { y -= item.gap; continue; }
    if (item.rule) {
      ensure(10);
      y -= 4;
      ops().push(`0.6 w ${MARGIN} ${y.toFixed(2)} m ${PAGE_WIDTH - MARGIN} ${y.toFixed(2)} l S`);
      y -= 8;
      continue;
    }
    const size = item.size || 10;
    const font = item.bold ? 'F2' : 'F1';
    const lineHeight = size * 1.45;
    ensure(lineHeight);
    y -= size;
    if (item.columns) {
      let x = MARGIN;
      item.columns.forEach((column, index) => {
        const width = item.widths?.[index] || 80;
        const isLast = index === item.columns.length - 1;
        const text = fit(column, size, width - 4);
        const left = isLast ? x + width - textWidth(text, size) : x;
        ops().push(`BT /${font} ${size} Tf ${left.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(text)} Tj ET`);
        x += width;
      });
    } else {
      ops().push(`BT /${font} ${size} Tf ${MARGIN} ${y.toFixed(2)} Td ${pdfString(fit(item.text, size, PAGE_WIDTH - MARGIN * 2))} Tj ET`);
    }
    y -= lineHeight - size;
  }
  return pages;
}

/**
 * pages: array of item lists. Items are { text, size, bold }, { columns,
 * widths, size, bold } (last column right-aligned), { rule: true }, { gap }.
 * A list that overflows continues on extra pages.
 */
export function buildPdf(pages, { title = 'Report' } = {}) {
  const physical = pages.flatMap(items => layoutPage(items));
  const objects = [];
  const add = body => { objects.push(body); return objects.length; };
  const catalogId = add('');
  const pagesId = add('');
  const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds = [];
  physical.forEach((ops, index) => {
    const footer = `BT /F1 8 Tf ${MARGIN} 30 Td ${pdfString(`${title} - page ${index + 1} of ${physical.length}`)} Tj ET`;
    const stream = [...ops, footer].join('\n');
    const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${contentId} 0 R >>`));
  });
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const infoId = add(`<< /Title ${pdfString(title)} /Producer (ShopCrank) >>`);
  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(body.length);
  for (let index = 0; index < body.length; index += 1) bytes[index] = body.charCodeAt(index) & 0xff;
  return { bytes, pageCount: physical.length };
}
