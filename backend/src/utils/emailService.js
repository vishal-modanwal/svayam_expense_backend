import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMAIL_ASSETS_DIR = path.join(__dirname, '../public/email');
/** Prefer svayam-expense-logo.* in public/email; fall back to legacy tracker asset; else inline SVG. */
const LOGO_FILENAME_CANDIDATES = [
    'svayam-expense-logo.png',
    'svayam-expense-logo.jpg',
    'svayam-expense-logo.jpeg',
    'svayam-expense-logo.webp',
    'svayam-tracker-logo.png'
];
const LOGO_CID = 'svayamexpense-logo@svayam';

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

const BRAND_TAGLINE = 'Clear spending. Smarter budgets.';

export const mailConfigured = () =>
    Boolean(String(process.env.GMAIL_USER || '').trim() && String(process.env.GMAIL_PASS || '').trim());

export function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resolveLogoFilePath() {
    const fromEnv = String(process.env.EMAIL_HEADER_LOGO_PATH || '').trim();
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    for (const name of LOGO_FILENAME_CANDIDATES) {
        const p = path.join(EMAIL_ASSETS_DIR, name);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

const HEADER_LOGO_HEIGHT_PX = 36;

/** Small badge when no file logo — reads on navy header. */
function brandMarkSvgDataUri() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><rect width="36" height="36" rx="8" fill="#f1f5f9"/><text x="18" y="24" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="16" font-weight="800" fill="#0f172a">S</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function buildHeaderLogoWordmarkRow(logoImgHtml) {
    const wordmark =
        '<span style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:21px;font-weight:800;color:#f8fafc;letter-spacing:-0.02em;line-height:1.2;white-space:nowrap;">SvayamExpense</span>';
    return `<table role="presentation" cellspacing="0" cellpadding="0" align="center" style="margin:0 auto;"><tr><td style="padding:0;vertical-align:middle;">${logoImgHtml}</td><td style="padding:0 0 0 14px;vertical-align:middle;">${wordmark}</td></tr></table>`;
}

/**
 * @returns {{ headerInnerHtml: string, attachments: { filename: string; path: string; cid: string }[] }}
 */
function buildBrandHeader() {
    const h = HEADER_LOGO_HEIGHT_PX;
    const logoPath = resolveLogoFilePath();
    if (logoPath) {
        const logoImg = `<img src="cid:${LOGO_CID}" alt="" height="${h}" style="display:block;height:${h}px;width:auto;max-width:140px;border:0;outline:none;text-decoration:none;" />`;
        return {
            headerInnerHtml: buildHeaderLogoWordmarkRow(logoImg),
            attachments: [
                {
                    filename: path.basename(logoPath),
                    path: logoPath,
                    cid: LOGO_CID
                }
            ]
        };
    }
    const src = brandMarkSvgDataUri();
    const logoImg = `<img src="${src}" width="${h}" height="${h}" alt="" style="display:block;height:${h}px;width:${h}px;border:0;outline:none;text-decoration:none;" />`;
    return {
        headerInnerHtml: buildHeaderLogoWordmarkRow(logoImg),
        attachments: []
    };
}

/**
 * SvayamExpense layout: navy header, centered hero, left-accent detail card (email-client friendly tables).
 * @returns {{ html: string, attachments: { filename: string; path: string; cid: string }[] }}
 */
function layoutSvayamExpenseEmail({ headline, sublineHtml, cardTitle, cardSubtitle, cardIntroHtml, rows, footerHtml }) {
    const outer =
        'margin:0;padding:0;background-color:#e8ecf1;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;';
    const wrap = 'max-width:600px;margin:0 auto;padding:24px 12px 40px;';
    const shell =
        'background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(15,23,42,0.08);border:1px solid #e2e8f0;';
    const header =
        'background-color:#0f172a;padding:36px 28px 32px;text-align:center;border-bottom:1px solid #1e293b;';
    const tag = 'margin:14px 0 0;font-size:13px;color:#94a3b8;line-height:1.5;';
    const { headerInnerHtml, attachments: headerAttachments } = buildBrandHeader();
    const heroPad = 'padding:36px 28px 8px;text-align:center;';
    const h1 = 'margin:0;font-size:26px;font-weight:700;color:#0f172a;line-height:1.35;letter-spacing:-0.02em;';
    const sub = 'margin:16px auto 0;max-width:480px;font-size:15px;color:#64748b;line-height:1.65;text-align:center;';
    const cardWrap = 'padding:8px 28px 36px;';
    const card =
        'background-color:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;border-left:4px solid #2563eb;padding:22px 22px 22px 20px;text-align:left;';
    const ct = 'margin:0;font-size:18px;font-weight:700;color:#0f172a;line-height:1.3;';
    const cs = 'margin:6px 0 0;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;';
    const ci = 'margin:14px 0 0;font-size:14px;color:#64748b;line-height:1.6;';
    const rowLabel =
        'font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;padding:14px 0 4px;vertical-align:top;width:38%;';
    const rowVal = 'font-size:15px;font-weight:700;color:#0f172a;padding:14px 0 4px;vertical-align:top;text-align:right;';
    const hr = 'border:none;border-top:1px solid #e2e8f0;margin:12px 0 0;';

    const rowHtml = rows
        .map(
            (r) => `
    <tr>
      <td style="${rowLabel}">${escapeHtml(r.label)}</td>
      <td style="${rowVal}">${r.valueHtml}</td>
    </tr>`
        )
        .join('');

    const htmlOut = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="x-ua-compatible" content="ie=edge"></head>
<body style="${outer}">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#e8ecf1;"><tr><td style="${wrap}">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="${shell}">
      <tr><td style="${header}">
        ${headerInnerHtml}
        <p style="${tag}">${escapeHtml(BRAND_TAGLINE)}</p>
      </td></tr>
      <tr><td style="${heroPad}">
        <h1 style="${h1}">${headline}</h1>
        <div style="${sub}">${sublineHtml}</div>
      </td></tr>
      <tr><td style="${cardWrap}">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="${card}">
          <tr><td>
            <p style="${ct}">${escapeHtml(cardTitle)}</p>
            <p style="${cs}">${escapeHtml(cardSubtitle)}</p>
            <div style="${ci}">${cardIntroHtml}</div>
            <hr style="${hr}" />
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:4px;">${rowHtml}</table>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:0 28px 28px;font-size:12px;color:#94a3b8;line-height:1.55;text-align:center;">${footerHtml}</td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;

    return { html: htmlOut, attachments: headerAttachments };
}

async function sendMail({ to, bcc, subject, html, text, attachments = [] }) {
    if (!mailConfigured()) {
        console.warn('Email skipped: GMAIL_USER / GMAIL_PASS not set.');
        return false;
    }
    try {
        await transporter.sendMail({
            from: `"SvayamExpense" <${process.env.GMAIL_USER}>`,
            to,
            bcc,
            subject,
            text,
            html,
            attachments
        });
        return true;
    } catch (error) {
        console.error('Email send error:', error.message);
        return false;
    }
}

/**
 * HTML email when standard spending crosses 90% of monthly category budget (admins only).
 */
export const sendBudget90PercentAlert = async (adminEmails, detail) => {
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

    const subject = `SvayamExpense — Budget alert: ${detail.categoryName} at ${usageStr}%`;

    const headline = `Budget threshold reached`;
    const sublineHtml = `Standard spending for <strong style="color:#334155;">${escapeHtml(detail.categoryName)}</strong> has reached <strong style="color:#334155;">${escapeHtml(usageStr)}%</strong> of the allocated amount for <strong style="color:#334155;">${escapeHtml(detail.periodLabel)}</strong>. Roughly <strong style="color:#334155;">${escapeHtml(fmt(detail.remaining))}</strong> remains before the full allocation is used.`;

    const cardTitle = detail.categoryName;
    const cardSubtitle = 'Category & billing period';
    const cardIntroHtml = `Please review this line in the <strong>SvayamExpense</strong> admin dashboard. You can adjust budgets or follow up on spending if needed.`;

    const rows = [
        { label: 'Period', valueHtml: escapeHtml(detail.periodLabel) },
        { label: 'Allocated', valueHtml: escapeHtml(fmt(detail.allocated)) },
        { label: 'Spent (standard)', valueHtml: escapeHtml(fmt(detail.spent)) },
        { label: 'Remaining', valueHtml: escapeHtml(fmt(detail.remaining)) },
        { label: 'Usage', valueHtml: `${escapeHtml(usageStr)}%` }
    ];

    const footerHtml = `This is an automated message from SvayamExpense. Please do not reply to this email.`;

    const { html, attachments } = layoutSvayamExpenseEmail({
        headline,
        sublineHtml,
        cardTitle,
        cardSubtitle,
        cardIntroHtml,
        rows,
        footerHtml
    });

    const text = [
        `Budget threshold reached (${usageStr}% used).`,
        `Category: ${detail.categoryName}`,
        `Period: ${detail.periodLabel}`,
        `Allocated: ${fmt(detail.allocated)} | Spent (standard): ${fmt(detail.spent)} | Remaining: ${fmt(detail.remaining)}`,
        '',
        'Review in the SvayamExpense admin dashboard.'
    ].join('\n');

    const to = list[0];
    const bcc = list.length > 1 ? list.slice(1) : undefined;
    return sendMail({ to, bcc, subject, html, text, attachments });
};

/**
 * Email OTP: verification (signup flow) or password reset — same professional layout.
 * @param {'verify' | 'reset'} [purpose]
 */
export const sendEmailOTP = async (to, otp, purpose = 'verify') => {
    const isReset = purpose === 'reset';
    const subject = isReset
        ? 'Reset your password — SvayamExpense'
        : 'Verify your email — SvayamExpense';

    const headline = isReset ? `Reset your password` : `Verify your email`;
    const sublineHtml = isReset
        ? `We received a request to reset the password for your SvayamExpense account. Use the one-time code below. If you did not request this, you can ignore this email.`
        : `Thanks for choosing <strong style="color:#334155;">SvayamExpense</strong>. Enter the verification code below to confirm your email and continue registration. This helps us keep your account secure.`;

    const cardTitle = isReset ? 'Password reset' : 'Email verification';
    const cardSubtitle = isReset ? 'Your reset code' : 'Your verification code';
    const cardIntroHtml = isReset
        ? `This code expires in <strong>10 minutes</strong>. After resetting, use your new password to sign in.`
        : `You are one step away from activating your workspace. This code expires in <strong>10 minutes</strong>.`;

    const rows = [
        {
            label: 'Code',
            valueHtml: `<span style="font-size:22px;letter-spacing:0.18em;font-family:Consolas,Monaco,monospace;">${escapeHtml(String(otp))}</span>`
        },
        { label: 'Valid for', valueHtml: escapeHtml('10 minutes') },
        { label: 'Status', valueHtml: escapeHtml(isReset ? 'Action required' : 'Pending verification') }
    ];

    const footerHtml = `If you did not request this email, you can safely ignore it. &mdash; SvayamExpense`;

    const { html, attachments } = layoutSvayamExpenseEmail({
        headline,
        sublineHtml,
        cardTitle,
        cardSubtitle,
        cardIntroHtml,
        rows,
        footerHtml
    });

    const text = isReset
        ? `SvayamExpense password reset\n\nYour OTP: ${otp}\nValid for 10 minutes.\n\nIf you did not request a reset, ignore this email.`
        : `SvayamExpense email verification\n\nYour OTP: ${otp}\nValid for 10 minutes.\n\nEnter this code to verify your email and complete signup.`;

    return sendMail({ to, subject, html, text, attachments });
};

/**
 * After successful registration (profile completed) — onboarding welcome.
 */
export const sendWelcomeOnboardingEmail = async (to, name) => {
    const safeName = String(name || 'there').trim() || 'there';
    const subject = `Welcome to SvayamExpense, ${safeName}`;

    const headline = `Welcome aboard, ${escapeHtml(safeName)}!`;
    const sublineHtml = `Your account is <strong style="color:#334155;">active</strong>. SvayamExpense helps teams log expenses, stay within monthly budgets, and keep finance visibility in one place. Here is how to get started.`;

    const cardTitle = 'Your quick start';
    const cardSubtitle = 'Next steps in the app';
    const cardIntroHtml = `Use the same email and password you just set to <strong>sign in</strong>. Then explore logging expenses, attaching receipts where needed, and checking category spend against your organization&rsquo;s monthly budgets.`;

    const rows = [
        { label: 'Account', valueHtml: escapeHtml('Active') },
        { label: 'Focus', valueHtml: escapeHtml('Expenses & monthly budgets') },
        { label: 'Tip', valueHtml: escapeHtml('Keep expense dates accurate for correct month buckets.') }
    ];

    const footerHtml = `Questions? Reach your organization admin. This is an automated message from SvayamExpense.`;

    const { html, attachments } = layoutSvayamExpenseEmail({
        headline,
        sublineHtml,
        cardTitle,
        cardSubtitle,
        cardIntroHtml,
        rows,
        footerHtml
    });

    const text = [
        `Welcome to SvayamExpense, ${safeName}!`,
        '',
        'Your account is active. Sign in with your email and password.',
        'Log expenses, attach receipts, and track spend against monthly category budgets.',
        '',
        '— SvayamExpense'
    ].join('\n');

    return sendMail({ to, subject, html, text, attachments });
};

/**
 * Email to user when admin approves or rejects an account activation request.
 * @param {string} to
 * @param {{ name?: string, action: 'approve' | 'reject', adminNote?: string | null }} detail
 */
export const sendActivationRequestReviewEmail = async (to, detail) => {
    const email = String(to || "").trim();
    if (!email) return false;

    const approved = detail.action === "approve";
    const safeName = String(detail.name || "there").trim() || "there";
    const note = detail.adminNote ? String(detail.adminNote).trim() : "";

    const subject = approved
        ? "Your SvayamExpense account is now active"
        : "Your SvayamExpense activation request was not approved";

    const headline = approved ? "Account activated" : "Activation request declined";
    const sublineHtml = approved
        ? `Hi <strong style="color:#334155;">${escapeHtml(safeName)}</strong>, your request to reactivate your <strong>SvayamExpense</strong> account has been <strong style="color:#334155;">approved</strong>. You can sign in and use the app normally.`
        : `Hi <strong style="color:#334155;">${escapeHtml(safeName)}</strong>, your request to reactivate your <strong>SvayamExpense</strong> account was <strong style="color:#334155;">not approved</strong> at this time. You may submit a new request from your profile if your situation has changed.`;

    const cardTitle = approved ? "You are all set" : "What you can do next";
    const cardSubtitle = approved ? "Account status" : "Request outcome";
    const cardIntroHtml = approved
        ? `Open SvayamExpense and sign in with your existing email and password. If you have trouble accessing the app, contact your organization administrator.`
        : note
          ? `Administrator note: <strong style="color:#334155;">${escapeHtml(note)}</strong>`
          : `If you believe this was a mistake, contact your organization administrator or submit a new activation request after signing in.`;

    const rows = approved
        ? [
              { label: "Status", valueHtml: escapeHtml("Active") },
              { label: "Access", valueHtml: escapeHtml("Full app access restored") },
          ]
        : [
              { label: "Status", valueHtml: escapeHtml("Inactive") },
              { label: "New request", valueHtml: escapeHtml("Allowed after sign-in") },
          ];

    if (note && approved) {
        rows.push({
            label: "Admin note",
            valueHtml: escapeHtml(note),
        });
    }

    const footerHtml = `This is an automated message from SvayamExpense. Please do not reply to this email.`;

    const { html, attachments } = layoutSvayamExpenseEmail({
        headline,
        sublineHtml,
        cardTitle,
        cardSubtitle,
        cardIntroHtml,
        rows,
        footerHtml,
    });

    const text = approved
        ? [
              `Hi ${safeName},`,
              "",
              "Your SvayamExpense account activation request was approved.",
              "Your account is now active. Sign in with your email and password.",
              note ? `Admin note: ${note}` : "",
              "",
              "— SvayamExpense",
          ]
              .filter(Boolean)
              .join("\n")
        : [
              `Hi ${safeName},`,
              "",
              "Your SvayamExpense account activation request was not approved.",
              note ? `Reason: ${note}` : "",
              "You may submit a new request from your profile after signing in.",
              "",
              "— SvayamExpense",
          ]
              .filter(Boolean)
              .join("\n");

    return sendMail({ to: email, subject, html, text, attachments });
};

/**
 * After register — account created but inactive until admin activates.
 */
export const sendRegistrationPendingUserEmail = async (to, name) => {
    const email = String(to || "").trim();
    if (!email) return false;

    const safeName = String(name || "there").trim() || "there";
    const subject = "Account created — pending admin activation | SvayamExpense";

    const headline = "Account created successfully";
    const sublineHtml = `Hi <strong style="color:#334155;">${escapeHtml(safeName)}</strong>, your <strong>SvayamExpense</strong> account has been created. An administrator will review your profile and <strong style="color:#334155;">activate</strong> your account. After activation, you can sign in and <strong>add expenses</strong>.`;

    const cardTitle = "What happens next";
    const cardSubtitle = "Account status";
    const cardIntroHtml = `You may sign in with your email and password, but expense features stay unavailable until an admin activates your account. We will email you again when your account is active.`;

    const rows = [
        { label: "Status", valueHtml: escapeHtml("Inactive (pending review)") },
        { label: "Expenses", valueHtml: escapeHtml("Available after activation") },
    ];

    const footerHtml = `This is an automated message from SvayamExpense. Please do not reply to this email.`;

    const { html, attachments } = layoutSvayamExpenseEmail({
        headline,
        sublineHtml,
        cardTitle,
        cardSubtitle,
        cardIntroHtml,
        rows,
        footerHtml,
    });

    const text = [
        `Hi ${safeName},`,
        "",
        "Your SvayamExpense account was created successfully.",
        "An administrator will review your profile and activate your account.",
        "After activation, you can sign in and add expenses.",
        "You will receive another email when your account is activated.",
        "",
        "— SvayamExpense",
    ].join("\n");

    return sendMail({ to: email, subject, html, text, attachments });
};

/**
 * Notify all admins by email when a new user completes registration.
 */
export const sendNewUserRegisteredAdminEmail = async (adminEmails, detail) => {
    const list = (Array.isArray(adminEmails) ? adminEmails : [])
        .map((e) => String(e).trim())
        .filter(Boolean);
    if (!list.length) return false;

    const safeName = escapeHtml(String(detail.name || "New user").trim() || "New user");
    const safeEmail = escapeHtml(String(detail.email || "").trim());
    const safeMobile = escapeHtml(String(detail.mobile || "—").trim() || "—");
    const userId = detail.userId != null ? escapeHtml(String(detail.userId)) : "—";

    const subject = `SvayamExpense — New user registration: ${String(detail.name || detail.email || "review required")}`;

    const headline = "New user registration";
    const sublineHtml = `A new user completed signup and is <strong style="color:#334155;">waiting for activation</strong>. Please review their profile in the admin dashboard and activate the account when appropriate.`;

    const cardTitle = safeName;
    const cardSubtitle = "Registration details";
    const cardIntroHtml = `Until you activate this account, the user cannot add expenses. Use the admin panel to review pending users and approve access.`;

    const rows = [
        { label: "User ID", valueHtml: userId },
        { label: "Email", valueHtml: safeEmail },
        { label: "Mobile", valueHtml: safeMobile },
        { label: "Status", valueHtml: escapeHtml("Inactive — pending your approval") },
    ];

    const footerHtml = `This is an automated message from SvayamExpense. Please do not reply to this email.`;

    const { html, attachments } = layoutSvayamExpenseEmail({
        headline,
        sublineHtml,
        cardTitle,
        cardSubtitle,
        cardIntroHtml,
        rows,
        footerHtml,
    });

    const text = [
        "New user registration on SvayamExpense",
        "",
        `Name: ${detail.name || "—"}`,
        `Email: ${detail.email || "—"}`,
        `Mobile: ${detail.mobile || "—"}`,
        `User ID: ${detail.userId ?? "—"}`,
        "",
        "The account is inactive until an admin activates it in the dashboard.",
        "",
        "— SvayamExpense",
    ].join("\n");

    const to = list[0];
    const bcc = list.length > 1 ? list.slice(1) : undefined;
    return sendMail({ to, bcc, subject, html, text, attachments });
};

/**
 * When admin activates a user account (new registration or admin approval).
 */
export const sendUserAccountActivatedEmail = async (to, detail) => {
    const email = String(to || "").trim();
    if (!email) return false;

    const safeName = String(detail.name || "there").trim() || "there";
    const note = detail.adminNote ? String(detail.adminNote).trim() : "";

    const subject = "Your SvayamExpense account is active — you can add expenses";

    const headline = "Account activated";
    const sublineHtml = `Hi <strong style="color:#334155;">${escapeHtml(safeName)}</strong>, your <strong>SvayamExpense</strong> account has been <strong style="color:#334155;">activated</strong>. You can sign in and start adding expenses.`;

    const cardTitle = "You are all set";
    const cardSubtitle = "Account status";
    const cardIntroHtml = note
        ? `Administrator note: <strong style="color:#334155;">${escapeHtml(note)}</strong><br/><br/>Sign in with your email and password to use the app.`
        : `Sign in with your email and password to log expenses, attach receipts, and track your monthly budget.`;

    const rows = [
        { label: "Status", valueHtml: escapeHtml("Active") },
        { label: "Expenses", valueHtml: escapeHtml("You can add expenses now") },
    ];

    const footerHtml = `This is an automated message from SvayamExpense. Please do not reply to this email.`;

    const { html, attachments } = layoutSvayamExpenseEmail({
        headline,
        sublineHtml,
        cardTitle,
        cardSubtitle,
        cardIntroHtml,
        rows,
        footerHtml,
    });

    const text = [
        `Hi ${safeName},`,
        "",
        "Your SvayamExpense account has been activated.",
        "You can sign in and add expenses.",
        note ? `Note from admin: ${note}` : "",
        "",
        "— SvayamExpense",
    ]
        .filter(Boolean)
        .join("\n");

    return sendMail({ to: email, subject, html, text, attachments });
};
