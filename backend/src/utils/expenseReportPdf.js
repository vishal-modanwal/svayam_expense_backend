import PDFDocument from 'pdfkit';

const fmtInr = (n) =>
    new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 2
    }).format(Number(n || 0));

const fmtDate = (d) => {
    if (!d) return '—';
    const x = new Date(d);
    return Number.isNaN(x.getTime()) ? String(d) : x.toLocaleDateString('en-IN');
};

const truncate = (s, max) => {
    const t = String(s ?? '');
    return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

const normalizeRow = (raw) =>
    Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
    );

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

    const doc = new PDFDocument({ margin: 36, size: 'A4', info: { Title: reportTitle } });
    doc.pipe(res);

    doc.fontSize(16).text(reportTitle, { align: 'center' });
    doc.moveDown(0.35);
    doc.fontSize(9).fillColor('#333333');
    subtitleLines.forEach((line) => {
        doc.text(line, { align: 'center' });
    });
    doc.fillColor('#000000');
    doc.moveDown(0.75);

    const margin = 36;
    const pageWidth = 595.28;
    const usable = pageWidth - margin * 2;
    const bottom = 770;

    const col = includeUserColumn
        ? { d: margin, t: margin + 58, u: margin + 168, c: margin + 248, a: margin + 318, ty: margin + 378, p: margin + 418 }
        : { d: margin, t: margin + 72, c: margin + 212, a: margin + 312, ty: margin + 382, p: margin + 432 };

    const headerLine = 11;
    const bodyLine = 11;

    const drawHeader = () => {
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(8);
        doc.text('Date', col.d, y, { width: 52 });
        doc.text('Title', col.t, y, { width: includeUserColumn ? 100 : 120 });
        if (includeUserColumn) doc.text('User', col.u, y, { width: 72 });
        doc.text('Category', col.c, y, { width: includeUserColumn ? 62 : 88 });
        doc.text('Amount', col.a, y, { width: 56, align: 'right' });
        doc.text('Type', col.ty, y, { width: 36 });
        doc.text('Payment', col.p, y, { width: usable - (col.p - margin), ellipsis: true });
        doc.y = y + headerLine + 2;
        doc.moveTo(margin, doc.y).lineTo(pageWidth - margin, doc.y).strokeColor('#cccccc').lineWidth(0.5).stroke();
        doc.strokeColor('#000000').lineWidth(1);
        doc.y += 6;
        doc.font('Helvetica').fontSize(8);
    };

    drawHeader();

    let total = 0;
    for (const raw of rows) {
        if (doc.y > bottom) {
            doc.addPage();
            drawHeader();
        }

        const r = normalizeRow(raw);
        const amt = Number(r.amount || 0);
        total += amt;

        const y = doc.y;
        doc.text(fmtDate(r.expense_date), col.d, y, { width: 52 });
        doc.text(truncate(r.title, 70), col.t, y, { width: includeUserColumn ? 100 : 120 });
        if (includeUserColumn) doc.text(truncate(r.user_name, 30), col.u, y, { width: 72 });
        doc.text(truncate(r.category_name, 24), col.c, y, { width: includeUserColumn ? 62 : 88 });
        doc.text(fmtInr(amt), col.a, y, { width: 56, align: 'right' });
        doc.text(String(r.expense_type || ''), col.ty, y, { width: 36 });
        doc.text(truncate(r.payment_method, 20), col.p, y, {
            width: usable - (col.p - margin),
            ellipsis: true
        });
        doc.y = y + bodyLine + 4;
    }

    doc.moveDown(0.5);
    if (doc.y > bottom - 40) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text(`Total: ${fmtInr(total)}`, margin, doc.y, { align: 'right', width: usable });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(8).fillColor('#666666');
    doc.text(`Rows: ${rows.length}`, { align: 'center' });

    doc.end();
}
