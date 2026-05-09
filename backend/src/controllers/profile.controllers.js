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
        const user = await pool.query(
            "SELECT email from users WHERE email=?" , [email]
        );
        if(!user){
              return res.status(404).json({ message: "User with this email does not exist" });
        }
        const result = await pool.query(
            "UPDATE users SET otp_code = ?, otp_expiry = ? WHERE email = ?",
            [genOtp, expiry, email]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "User with this email does not exist" });
        }

        // Gmail ke zariye OTP bhejna
        await sendEmailOTP(email, genOtp);
        res.json({ message: "Reset OTP sent to your email. Valid for 10 minutes." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};




export const resetPassword = async (req, res) => {
    // 1. Destructure all needed fields
    const { email, password , otp} = req.body; 

    try {
        // 2. Initial User Check
        const [rows] = await pool.query(
            "SELECT email, otp_code, otp_expiry FROM users WHERE email = ?", 
            [email]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: "User with this email does not exist" });
        }

        const user = rows; // Single user object

        // 3. Manual OTP Validation (Better for debugging)
        // if (user.otp_code !== otp) {
        //     return res.status(400).json({ message: "Invalid OTP code" });
        // }

        // 4. Manual Expiry Check (Avoids timezone confusion)
        // const dbTime = new Date(); // Or get from DB SELECT NOW()
        // if (new Date(user.otp_expiry) < dbTime) {
        //     return res.status(400).json({ message: "OTP has expired" });
        // }

        // 5. Update Password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const result = await pool.query(
            "UPDATE users SET password = ?, otp_code = NULL, otp_expiry = NULL WHERE email = ?",
            [hashedPassword, email]
        );

        if (result.affectedRows === 0) {
            return res.status(500).json({ message: "Failed to update password. Please try again." });
        }

        res.json({ message: "Password reset successful." });

    } catch (error) {
        console.error("Reset Password Error:", error);
        res.status(500).json({ error: error.message });
    }
};