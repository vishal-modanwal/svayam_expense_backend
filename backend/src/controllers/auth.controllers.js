import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../db/index.js";
import { selectRowArray } from "../utils/mariaRows.js";
import {
    sendEmailOTP,
    sendNewUserRegisteredAdminEmail,
    sendRegistrationPendingUserEmail,
} from "../utils/emailService.js";
import { getOTPExpiry, otp } from "../utils/otp.js";
import {
    isMissingRegistrationPendingTableError,
    normalizeEmail,
} from "../utils/registrationPending.js";
import { createNotification } from "../utils/notifications.js";
import {
    ACTIVATION_NOTIFY,
    createPendingActivationRequest,
    isMissingActivationTableError,
} from "../utils/activationRequest.js";

/**
 * POST /api/auth/sendEmailOtp
 * Stores OTP in registration_pending only — no users row until register completes.
 */
export const sendVerificationEmail = async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
        return res.status(400).json({ message: "Valid email is required." });
    }

    const generateOtp = otp();
    const expiry = getOTPExpiry();

    try {
        const existingUser = selectRowArray(
            await pool.query("SELECT id FROM users WHERE email = ?", [email])
        );
        if (existingUser.length > 0) {
            return res.status(400).json({ message: "Email already registered." });
        }

        const pending = selectRowArray(
            await pool.query(
                "SELECT email_verified_at FROM registration_pending WHERE email = ?",
                [email]
            )
        );
        if (pending.length && pending[0].email_verified_at) {
            return res.status(400).json({
                message:
                    "Email already verified. Please complete registration with your name, mobile, and password.",
                code: "EMAIL_VERIFIED_COMPLETE_REGISTER",
            });
        }

        await pool.query(
            `INSERT INTO registration_pending (email, otp_code, otp_expiry, email_verified_at)
             VALUES (?, ?, ?, NULL)
             ON DUPLICATE KEY UPDATE
               otp_code = VALUES(otp_code),
               otp_expiry = VALUES(otp_expiry),
               email_verified_at = NULL,
               updated_at = CURRENT_TIMESTAMP`,
            [email, generateOtp, expiry]
        );

        await sendEmailOTP(email, generateOtp);
        res.json({ message: "OTP sent to your email." });
    } catch (error) {
        if (isMissingRegistrationPendingTableError(error)) {
            return res.status(503).json({
                message: "Run Schema.sql registration_pending upgrade, then retry.",
                code: "SCHEMA_MISSING_registration_pending",
            });
        }
        res.status(500).json({ error: error.message });
    }
};

/**
 * POST /api/auth/verifyEmailOtp
 */
export const checkEmailVerification = async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const otpCode = String(req.body?.otp ?? "").trim();

    if (!email || !otpCode) {
        return res.status(400).json({ message: "Email and OTP are required." });
    }

    try {
        const rows = selectRowArray(
            await pool.query(
                `SELECT id FROM registration_pending
                 WHERE email = ? AND otp_code = ? AND otp_expiry > NOW()`,
                [email, otpCode]
            )
        );

        if (!rows.length) {
            return res.json({
                verified: false,
                message: "Invalid or expired OTP.",
            });
        }

        await pool.query(
            `UPDATE registration_pending
             SET email_verified_at = CURRENT_TIMESTAMP,
                 otp_code = NULL,
                 otp_expiry = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE email = ?`,
            [email]
        );

        return res.json({
            verified: true,
            message: "Email verified successfully. Complete registration to create your account.",
        });
    } catch (error) {
        if (isMissingRegistrationPendingTableError(error)) {
            return res.status(503).json({
                message: "Run Schema.sql registration_pending upgrade, then retry.",
                code: "SCHEMA_MISSING_registration_pending",
            });
        }
        res.status(500).json({ error: error.message });
    }
};

/**
 * POST /api/auth/register
 * Single transaction: verified pending → insert users → delete pending.
 */
export const register = async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    const email = normalizeEmail(req.body?.email);
    const mobile_no = String(req.body?.mobile_no ?? "").trim();
    const password = req.body?.password;

    if (!name || !email || !mobile_no || !password) {
        return res.status(400).json({
            message: "name, email, mobile_no, and password are required.",
        });
    }

    let connection;
    try {
        const dupMobile = selectRowArray(
            await pool.query("SELECT id FROM users WHERE mobile_no = ?", [mobile_no])
        );
        if (dupMobile.length) {
            return res.status(400).json({ message: "Mobile number already registered." });
        }

        const hashedPassword = await bcrypt.hash(String(password), 10);

        connection = await pool.getConnection();
        await connection.beginTransaction();

        const pendingRows = selectRowArray(
            await connection.query(
                `SELECT id, email_verified_at FROM registration_pending
                 WHERE email = ? FOR UPDATE`,
                [email]
            )
        );

        if (!pendingRows.length || !pendingRows[0].email_verified_at) {
            await connection.rollback();
            return res.status(400).json({
                message: "Please verify your email with OTP before registering.",
                code: "EMAIL_NOT_VERIFIED",
            });
        }

        const existingUser = selectRowArray(
            await connection.query(
                "SELECT id FROM users WHERE email = ? OR mobile_no = ?",
                [email, mobile_no]
            )
        );
        if (existingUser.length) {
            await connection.rollback();
            return res.status(400).json({
                message: "Email or mobile number already registered.",
            });
        }

        const insertResult = await connection.query(
            `INSERT INTO users (
                name, email, mobile_no, password, role,
                is_verified_email, is_active, otp_code, otp_expiry
             ) VALUES (?, ?, ?, ?, 'user', 1, 0, NULL, NULL)`,
            [name, email, mobile_no, hashedPassword]
        );

        const userId =
            typeof insertResult.insertId === "bigint"
                ? Number(insertResult.insertId)
                : insertResult.insertId;

        const activationRequestId = await createPendingActivationRequest(
            connection,
            userId
        );

        const adminRows = selectRowArray(
            await connection.query(
                `SELECT id, email FROM users WHERE role = 'admin' AND is_active = 1`
            )
        );
        const notifyMsg = `New user ${name} (${email}) registered. Review and activate the account.`;
        for (const admin of adminRows) {
            const adminId =
                typeof admin.id === "bigint" ? Number(admin.id) : admin.id;
            await createNotification(
                adminId,
                null,
                ACTIVATION_NOTIFY.NEW_USER_REGISTERED,
                notifyMsg,
                connection
            );
        }

        await connection.query("DELETE FROM registration_pending WHERE email = ?", [email]);

        await connection.commit();

        sendRegistrationPendingUserEmail(email, name).catch((err) =>
            console.error("Registration pending user email failed:", err.message)
        );

        const adminEmails = adminRows
            .map((a) => String(a.email ?? "").trim())
            .filter(Boolean);
        if (adminEmails.length) {
            sendNewUserRegisteredAdminEmail(adminEmails, {
                userId,
                name,
                email,
                mobile: mobile_no,
            }).catch((err) =>
                console.error("New user admin email failed:", err.message)
            );
        }

        res.status(201).json({
            message:
                "Account created successfully. An administrator will review and activate your account before you can add expenses.",
            user_id: userId,
            activation_request_id: activationRequestId,
            is_active: false,
            activity_status: "inactive",
        });
    } catch (error) {
        if (connection) await connection.rollback();
        if (error?.errno === 1062 || error?.code === "ER_DUP_ENTRY") {
            return res.status(400).json({
                message: "Email or mobile number already registered.",
            });
        }
        if (isMissingRegistrationPendingTableError(error)) {
            return res.status(503).json({
                message: "Run Schema.sql registration_pending upgrade, then retry.",
                code: "SCHEMA_MISSING_registration_pending",
            });
        }
        if (isMissingActivationTableError(error)) {
            return res.status(503).json({
                message:
                    "Run Schema.sql user_activation_requests upgrade, then retry.",
                code: "SCHEMA_MISSING_user_activation_requests",
            });
        }
        res.status(500).json({ error: error.message });
    } finally {
        if (connection) connection.release();
    }
};

/**
 * POST /api/auth/login
 */
export const login = async (req, res) => {
    const { email, mobile_no, password } = req.body;

    try {
        const rows = selectRowArray(
            await pool.query(`SELECT * FROM users WHERE (email = ? OR mobile_no = ?)`, [
                email,
                mobile_no,
            ])
        );
        const user = rows[0];

        if (!user) return res.status(401).json({ message: "Invalid credentials" });

        if (!user.password) {
            return res.status(400).json({
                message: "Account setup is incomplete. Please finish registration.",
                code: "REGISTRATION_INCOMPLETE",
            });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ message: "Incorrect password." });

        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWTEXPIRY }
        );

        const isActive = Number(user.is_active) === 1;
        res.json({
            token,
            user: {
                id: typeof user.id === "bigint" ? Number(user.id) : user.id,
                name: user.name,
                email: user.email,
                mobile: user.mobile_no,
                role: user.role,
                is_active: isActive,
                activity_status: isActive ? "active" : "inactive",
            },
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
