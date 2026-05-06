import jwt from 'jsonwebtoken';
import { pool } from '../db/index.js';

/**
 * AUTH MIDDLEWARE
 * Purpose: Protect routes and inject user data into the request object.
 */
export const auth = async (req, res, next) => {
    let token;

    // 1. Check if token exists in Headers
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            // Get token from header (Format: Bearer <token>)
            token = req.headers.authorization.split(' ')[1];

            // 2. Verify Token
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // 3. Fetch user from DB to ensure they still exist and are active
            const rows = await pool.query(
                "SELECT id, name, email, role FROM users WHERE id = ? AND is_active = 1",
                [decoded.id]
            );

            if (rows.length === 0) {
                return res.status(401).json({ message: "Not authorized, user not found or inactive" });
            }

            // 4. Attach user to request object
            req.user = rows[0];
            next();
        } catch (error) {
            console.error("Auth Middleware Error:", error.message);
            res.status(401).json({ message: "Not authorized, token failed" });
        }
    }

    if (!token) {
        res.status(401).json({ message: "Not authorized, no token provided" });
    }
};

