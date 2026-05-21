import PDFDocument from 'pdfkit';

/** Helvetica lacks ₹ glyph — use Rs. so amounts render cleanly in PDF. */
const fmtInr = (n) => {
    const num = Number(n || 0);
    const formatted = new Intl.NumberFormat('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(num);
    return `Rs. ${formatted}`;
};

const fmtDate = (d) => {
    if (!d) return '—';
    const x = new Date(d);
    return Number.isNaN(x.getTime()) ? String(d) : x.toLocaleDateString('en-IN');
};

const dash = (v) => {
    const t = String(v ?? '').trim();
    return t === '' ? '—' : t;
};

const normalizeRow = (raw) =>
    Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
    );

const COL_GAP = 10;
const CELL_PAD = 5;

/**
 * Columns with fixed gaps between slots; text is inset inside each slot.
 */
function buildColumns(includeUserColumn, margin, usableWidth) {
    const specs = includeUserColumn
        ? [
              { key: 'date', label: 'Date', pct: 0.08 },
              { key: 'title', label: 'Title', pct: 0.13 },
              { key: 'user', label: 'User', pct: 0.1 },
              { key: 'vendor', label: 'Vendor', pct: 0.16 },
              { key: 'category', label: 'Category', pct: 0.11 },
              { key: 'amount', label: 'Amount', pct: 0.12, align: 'right' },
              { key: 'type', label: 'Type', pct: 0.09 },
              { key: 'payment', label: 'Payment', pct: 0.21 }
          ]
        : [
              { key: 'date', label: 'Date', pct: 0.09 },
              { key: 'title', label: 'Title', pct: 0.15 },
              { key: 'vendor', label: 'Vendor', pct: 0.18 },
              { key: 'category', label: 'Category', pct: 0.13 },
              { key: 'amount', label: 'Amount', pct: 0.13, align: 'right' },
              { key: 'type', label: 'Type', pct: 0.1 },
              { key: 'payment', label: 'Payment', pct: 0.22 }
          ];

    const n = specs.length;
    const totalGap = COL_GAP * (n - 1);
    const contentWidth = usableWidth - totalGap;
    const rightEdge = margin + usableWidth;

    let slotX = margin;
    return specs.map((spec, i) => {
        const isLast = i === n - 1;
        const boxW = isLast ? rightEdge - slotX : Math.floor(contentWidth * spec.pct);
        const col = {
            ...spec,
            boxX: slotX,
            boxW,
            x: slotX + CELL_PAD,
            w: Math.max(8, boxW - CELL_PAD * 2)
        };
        slotX += boxW + (isLast ? 0 : COL_GAP);
        return col;
    });
}

function cellOptions(col) {
    return {
        width: col.w,
        align: col.align || 'left',
        ellipsis: true,
        lineBreak: true
    };
}

function valuesForRow(r, includeUserColumn) {
    const cells = {
        date: fmtDate(r.expense_date),
        title: dash(r.title),
        vendor: dash(r.vendor),
        category: dash(r.category_name),
        amount: fmtInr(r.amount || 0),
        type: dash(r.expense_type),
        payment: dash(r.payment_method)
    };
    if (includeUserColumn) {
        cells.user = dash(r.user_name);
    }
    return cells;
}

function drawColumnDividers(doc, cols, yTop, yBottom) {
    doc.save();
    doc.strokeColor('#dddddd').lineWidth(0.5);
    for (let i = 1; i < cols.length; i++) {
        const x = cols[i].boxX - COL_GAP / 2;
        doc.moveTo(x, yTop).lineTo(x, yBottom).stroke();
    }
    doc.restore();
    doc.strokeColor('#000000').lineWidth(1);
}

/** Draw one table row; returns y position after the row. */
function drawTableRow(doc, cols, y, cellMap, { bold = false, fontSize = 8 } = {}) {
    const font = bold ? 'Helvetica-Bold' : 'Helvetica';
    doc.font(font).fontSize(fontSize);

    const texts = cols.map((c) => cellMap[c.key] ?? '—');
    const optsList = cols.map((c) => cellOptions(c));

    const heights = texts.map((text, i) => doc.heightOfString(text, optsList[i]));
    const maxH = Math.max(...heights, fontSize + 3);
    const rowPad = 7;

    for (let i = 0; i < cols.length; i++) {
        const savedY = doc.y;
        doc.text(texts[i], cols[i].x, y, optsList[i]);
        doc.y = savedY;
    }

    return y + maxH + rowPad;
}

/**
 * Streams a tabular expense PDF to the Express response.
 * @param {import('express').Response} res
 * @param {{ reportTitle: string; subtitleLines: string[]; rows: object[]; includeUserColumn?: boolean }} opts
 */
export function sendExpenseReportPdf(res, opts) {
    const { reportTitle, subtitleLines, rows, includeUserColumn } = opts;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `expense-report-${stamp}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const margin = 36;
    const doc = new PDFDocument({
        margin,
        size: 'A4',
        layout: 'landscape',
        info: { Title: reportTitle }
    });
    doc.pipe(res);

    const pageWidth = 841.89;
    const pageHeight = 595.28;
    const usable = pageWidth - margin * 2;
    const bottom = pageHeight - 48;

    doc.fontSize(16).text(reportTitle, { align: 'center' });
    doc.moveDown(0.35);
    doc.fontSize(9).fillColor('#333333');
    subtitleLines.forEach((line) => {
        doc.text(line, { align: 'center' });
    });
    doc.fillColor('#000000');
    doc.moveDown(0.75);

    const cols = buildColumns(!!includeUserColumn, margin, usable);

    const drawHeader = () => {
        const headerMap = Object.fromEntries(cols.map((c) => [c.key, c.label]));
        const y0 = doc.y;
        const y1 = drawTableRow(doc, cols, y0, headerMap, { bold: true, fontSize: 8 });
        drawColumnDividers(doc, cols, y0 - 2, y1);
        doc.moveTo(margin, y1).lineTo(pageWidth - margin, y1).strokeColor('#cccccc').lineWidth(0.5).stroke();
        doc.strokeColor('#000000').lineWidth(1);
        doc.y = y1 + 8;
        doc.font('Helvetica').fontSize(8);
    };

    drawHeader();

    let total = 0;
    let tableTop = doc.y;
    for (const raw of rows) {
        if (doc.y > bottom) {
            drawColumnDividers(doc, cols, tableTop, doc.y);
            doc.addPage();
            drawHeader();
            tableTop = doc.y;
        }

        const r = normalizeRow(raw);
        total += Number(r.amount || 0);
        const y = doc.y;
        doc.y = drawTableRow(doc, cols, y, valuesForRow(r, !!includeUserColumn));
    }

    drawColumnDividers(doc, cols, tableTop, doc.y);

    doc.moveDown(0.5);
    if (doc.y > bottom - 40) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text(`Total: ${fmtInr(total)}`, margin, doc.y, { align: 'right', width: usable });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(8).fillColor('#666666');
    doc.text(`Rows: ${rows.length}`, { align: 'center' });

    doc.end();
}
