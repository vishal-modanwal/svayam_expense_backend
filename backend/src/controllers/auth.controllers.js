import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db/index.js'; // Pool connection from your db config
import { sendEmailOTP } from '../utils/emailService.js';
import { getOTPExpiry, otp } from '../utils/otp.js';

/**
 * FUNCTION 1: Generate & Send Email OTP
 */
export const sendVerificationEmail = async (req, res) => {
    const { email } = req.body;
    const generateOtp = otp();
    const expiry = getOTPExpiry(); // 10 mins validity

    try {
        const existing = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
        if (existing.length > 0) return res.status(400).json({ message: "Email already registered" });

        await pool.query(
            `INSERT INTO users (email, otp_code, otp_expiry, is_active) 
             VALUES (?, ?, ?, 0) ON DUPLICATE KEY UPDATE otp_code = ?, otp_expiry = ?`,
            [email, generateOtp , expiry , generateOtp , expiry]
        );

        await sendEmailOTP(email, generateOtp);
        res.json({ message: "OTP sent to your email." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * FUNCTION 2: Check Email Verified (True/False)
 * User ke OTP enter karne par ye check karega.
 */
export const checkEmailVerification = async (req, res) => {
    const { email, otp } = req.body;
    try {
        const rows = await pool.query(
            "SELECT id FROM users WHERE email = ? AND otp_code = ? AND otp_expiry > NOW()",
            [email, otp]
        );

        if (rows.length > 0) {
            await pool.query("UPDATE users SET is_verified_email = 1, otp_code = NULL WHERE email = ?", [email]);
            return res.json({ verified: true, message: "Email verified successfully!" });
        } else {
            return res.json({ verified: false, message: "Invalid or expired OTP." });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};


/**
 * 3. FINAL REGISTER
 * Jab email verified ho jaye, tab final data save karna.
 */
export const register = async (req, res) => {
    const { name, email, mobile_no, password } = req.body;

    try {
        // Confirm email is verified
        const status = await pool.query(
            "SELECT is_verified_email FROM users WHERE email = ?", [email]
        );

        if (status.length === 0 || !status[0].is_verified_email) {
            return res.status(400).json({ message: "Please verify your email first." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Final update: Mobile save karein aur active mark karein
        await pool.query(
            `UPDATE users SET 
                name = ?, 
                mobile_no = ?, 
                password = ?, 
                is_active = 1
             WHERE email = ?`,
            [name, mobile_no, hashedPassword, email]
        );

        res.json({ message: "Registration successful! You can now login." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * 4. LOGIN (Dual Identity: Email OR Phone)
 */
export const login = async (req, res) => {
    const { email, mobile_no , password } = req.body;

    try {
        const rows = await pool.query(
            `SELECT * FROM users WHERE (email = ? OR mobile_no = ?)`,
            [email, mobile_no]
        );
        const user = rows[0];

        if (!user) return res.status(401).json({ message: "Invalid credentials" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ message: "Incorrect password." });

        const token = jwt.sign(
            { id: user.id, role: user.role }, 
            process.env.JWT_SECRET, 
            { expiresIn: process.env.JWTEXPIRY }
        );

        res.json({ 
            token, 
            user: { id: user.id, name: user.name, email: user.email, mobile: user.mobile_no } 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};