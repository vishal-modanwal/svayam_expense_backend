import bcrypt from 'bcryptjs';
import { pool } from '../db/index.js';
import { sendEmailOTP } from '../utils/emailService.js';
import { otp  , getOTPExpiry} from '../utils/otp.js';

/**
 * 1. GET ME: Fetch logged-in user's profile
 */
export const getMe = async (req, res) => {
    const userId = req.user.id;

    try {
        const rows = await pool.query(
            "SELECT id, name, email, mobile_no, role, created_at FROM users WHERE id = ?",
            [userId]
        );

        if (rows.length === 0) return res.status(404).json({ message: "User not found" });

        res.json({ user: rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * 2. UPDATE PROFILE: Dynamic Update (Name, Number, Password)
 */
export const updateProfile = async (req, res) => {
    const userId = req.user.id;
    const { name, mobile_no} = req.body;

    let updates = [];
    let params = [];

    // Dynamic query building logic
    if (name) { 
        updates.push("name = ?"); 
        params.push(name); 
    }
    if (mobile_no) { 
        updates.push("mobile_no = ?"); 
        params.push(mobile_no); 
    }
    

    if (updates.length === 0) {
        return res.status(400).json({ message: "Nothing to update" });
    }

    params.push(userId); // WHERE clause parameter

    try {
        const sql = `UPDATE users SET ${updates.join(", ")} WHERE id = ?`;
        const result = await pool.query(sql, params);

        if (result.affectedRows === 0) return res.status(404).json({ message: "User not found" });

        res.json({ message: "Profile updated successfully!" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * 3. FORGOT PASSWORD: OTP Request
 * User email deta hai aur 15-min valid OTP use mil jata hai.
 */
export const forgotPassword = async (req, res) => {
    const { email } = req.body;
    const genOtp = otp();
    const expiry = getOTPExpiry();

    try {
        const result = await pool.query(
            "UPDATE users SET otp_code = ?, otp_expiry = ? WHERE email = ?",
            [genOtp, expiry, email]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "User with this email does not exist" });
        }

        // Gmail ke zariye OTP bhejna
        await sendEmailOTP(email, otp);
        res.json({ message: "Reset OTP sent to your email. Valid for 10 minutes." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * 4. RESET PASSWORD: Final Change with OTP
 */
export const resetPassword = async (req, res) => {
    const { email, otp, newPassword } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        // OTP correctness aur expiry dono check hoti hain
        const result = await pool.query(
            "UPDATE users SET password = ?, otp_code = NULL, otp_expiry = NULL WHERE email = ? AND otp_code = ? AND otp_expiry > NOW()",
            [hashedPassword, email, otp]
        );

        if (result.affectedRows === 0) {
            return res.status(400).json({ message: "Invalid OTP or OTP has expired" });
        }

        res.json({ message: "Password reset successful. You can now login with your new password." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};