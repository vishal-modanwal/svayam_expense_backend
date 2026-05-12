import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

const mailConfigured = () =>
    Boolean(String(process.env.GMAIL_USER || '').trim() && String(process.env.GMAIL_PASS || '').trim());

/**
 * HTML email when standard spending crosses 90% of monthly category budget (admins only).
 * @param {string[]} adminEmails
 * @param {{ categoryName: string, periodLabel: string, month: number, year: number, allocated: number, spent: number, remaining: number, usagePercent: number, currency: string }} detail
 */
export const sendBudget90PercentAlert = async (adminEmails, detail) => {
    if (!mailConfigured()) {
        console.warn('Budget alert email skipped: GMAIL_USER / GMAIL_PASS not set.');
        return false;
    }
    const list = (Array.isArray(adminEmails) ? adminEmails : [])
        .map((e) => String(e).trim())
        .filter(Boolean);
    if (!list.length) return false;

    const fmt = (n) => {
        try {
            return new Intl.NumberFormat('en-IN', {
                style: 'currency',
                currency: detail.currency || 'INR',
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            }).format(Number(n) || 0);
        } catch {
            return `${Number(n).toFixed(2)} ${detail.currency || ''}`.trim();
        }
    };

    const usage = Number(detail.usagePercent);
    const usageStr = Number.isFinite(usage) ? usage.toFixed(1) : '—';

    const subject = `Svayam — Budget alert: ${detail.categoryName} has reached ${usageStr}% of monthly allocation`;

    const outer = 'font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;background-color:#f4f6fb;margin:0;padding:32px 12px;';
    const card =
        'max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);';
    const header =
        'background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);color:#ffffff;padding:28px 32px;text-align:left;';
    const h1 = 'margin:0;font-size:22px;font-weight:600;line-height:1.3;letter-spacing:-0.02em;';
    const sub = 'margin:10px 0 0;font-size:15px;opacity:0.92;line-height:1.5;font-weight:400;';
    const bodyPad = 'padding:28px 32px 32px;color:#1e293b;font-size:15px;line-height:1.6;';
    const pill =
        'display:inline-block;background:#fef3c7;color:#92400e;font-size:13px;font-weight:600;padding:6px 12px;border-radius:999px;margin-bottom:18px;';
    const table = 'width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;';
    const th = 'text-align:left;padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-weight:600;';
    const td = 'text-align:left;padding:12px;border-bottom:1px solid #f1f5f9;color:#0f172a;';
    const tdStrong = 'font-weight:600;color:#1e40af;';
    const foot = 'padding:0 32px 28px;font-size:12px;color:#94a3b8;line-height:1.5;';

    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="${outer}">
  <div style="${card}">
    <div style="${header}">
      <p style="${h1}">Monthly budget threshold reached</p>
      <p style="${sub}">Standard spending for <strong style="font-weight:600;">${escapeHtml(detail.categoryName)}</strong> has reached <strong>${escapeHtml(usageStr)}%</strong> of the allocated amount for <strong>${escapeHtml(detail.periodLabel)}</strong>. Only about <strong>${fmt(detail.remaining)}</strong> remains before the ceiling.</p>
    </div>
    <div style="${bodyPad}">
      <span style="${pill}">90% allocation used</span>
      <p style="margin:0 0 8px;">Summary for this category and period:</p>
      <table role="presentation" style="${table}">
        <tr><th style="${th}">Allocated</th><td style="${td}">${fmt(detail.allocated)}</td></tr>
        <tr><th style="${th}">Spent (standard)</th><td style="${td} ${tdStrong}">${fmt(detail.spent)}</td></tr>
        <tr><th style="${th}">Remaining</th><td style="${td}">${fmt(detail.remaining)}</td></tr>
        <tr><th style="${th}">Usage</th><td style="${td} ${tdStrong}">${escapeHtml(usageStr)}%</td></tr>
      </table>
      <p style="margin:24px 0 0;color:#475569;">Please review this category in the <strong>Svayam Expense</strong> admin dashboard and adjust budgets or spending if needed.</p>
    </div>
    <div style="${foot}">
      This is an automated message from Svayam Expense Tracker. Do not reply to this email.
    </div>
  </div>
</body>
</html>`;

    const text = [
        `Monthly budget threshold reached (${usageStr}% used).`,
        `Category: ${detail.categoryName}`,
        `Period: ${detail.periodLabel}`,
        `Allocated: ${fmt(detail.allocated)} | Spent (standard): ${fmt(detail.spent)} | Remaining: ${fmt(detail.remaining)}`,
        '',
        'Review budgets in the Svayam Expense admin dashboard.'
    ].join('\n');

    const to = list[0];
    const bcc = list.length > 1 ? list.slice(1) : undefined;

    try {
        await transporter.sendMail({
            from: `"Svayam Expense" <${process.env.GMAIL_USER}>`,
            to,
            bcc,
            subject,
            text,
            html
        });
        return true;
    } catch (error) {
        console.error('Budget 90% email error:', error.message);
        return false;
    }
};

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const sendEmailOTP = async (to, otp) => {
    try {
        await transporter.sendMail({
            from: `"Svayam Tracker" <${process.env.GMAIL_USER}>`,
            to: to,
            subject: "Verify Your Email - Svayam Tracker",
            text: `Your verification OTP is: ${otp}. It is valid for 10 minutes.`,
            html: `<b>Your verification OTP is: ${otp}</b><p>Valid for 10 minutes.</p>`
        });
        return true;
    } catch (error) {
        console.error("Email Error:", error);
        return false;
    }
};