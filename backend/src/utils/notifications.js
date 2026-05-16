import { pool } from "../db/index.js";

/**
 * @param {number} userId
 * @param {number|null} expenseId
 * @param {string} type
 * @param {string} message
 * @param {import("mariadb").PoolConnection} [existingConn] — same pool connection / transaction as the caller; do not release here.
 */
export async function createNotification(userId, expenseId, type, message, existingConn = null) {
    const ownConnection = existingConn == null;
    const conn = existingConn ?? (await pool.getConnection());
    try {
        await conn.query(
            `INSERT INTO notifications (user_id, expense_id, type, message)
         VALUES (?, ?, ?, ?)`,
            [userId, expenseId, type, message]
        );
    } catch (err) {
        console.log("Failed to create notification", err);
        if (existingConn) throw err;
    } finally {
        if (ownConnection && conn) conn.release();
    }
}
