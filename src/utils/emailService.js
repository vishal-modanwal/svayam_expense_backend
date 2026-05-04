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