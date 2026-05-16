import { pool } from "../db/index.js";
import { selectRowArray } from "../utils/mariaRows.js";

const jsonNumber = (v) => (typeof v === "bigint" ? Number(v) : v);

const rowToJson = (row) =>
    Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])
    );

/**
 * GET /api/admin/notifications (admin only)
 * Lists all in-app notifications with optional filters and pagination.
 */
export const getNotifications = async (req, res) => {
    try {
        const limitRaw = req.query.limit;
        const offsetRaw = req.query.offset;
        const limit = Math.min(
            100,
            Math.max(1, parseInt(String(limitRaw ?? "50"), 10) || 50)
        );
        const offset = Math.max(0, parseInt(String(offsetRaw ?? "0"), 10) || 0);

        const userIdFilter =
            req.query.user_id !== undefined && req.query.user_id !== ""
                ? parseInt(String(req.query.user_id), 10)
                : null;
        if (userIdFilter !== null && !Number.isFinite(userIdFilter)) {
            return res.status(400).json({ message: "Invalid user_id." });
        }

        const readParam = req.query.is_read;
        let readClause = "";
        const params = [];
        const countParams = [];

        if (readParam === "true" || readParam === "1") {
            readClause = " AND n.is_read = 1 ";
        } else if (readParam === "false" || readParam === "0") {
            readClause = " AND n.is_read = 0 ";
        }

        let userClause = "";
        if (userIdFilter !== null) {
            userClause = " AND n.user_id = ? ";
            params.push(userIdFilter);
            countParams.push(userIdFilter);
        }

        const countSql = `
            SELECT COUNT(*) AS total
            FROM notifications n
            WHERE 1=1 ${readClause} ${userClause}
        `;
        const countRaw = await pool.query(countSql, countParams);
        const countRows = selectRowArray(countRaw);
        const total = jsonNumber(countRows[0]?.total ?? 0);

        const listSql = `
            SELECT
                n.id,
                n.user_id,
                n.expense_id,
                n.type,
                n.message,
                n.is_read,
                n.created_at,
                u.name AS user_name,
                u.email AS user_email
            FROM notifications n
            LEFT JOIN users u ON u.id = n.user_id
            WHERE 1=1 ${readClause} ${userClause}
            ORDER BY n.created_at DESC, n.id DESC
            LIMIT ? OFFSET ?
        `;
        const listParams = [...params, limit, offset];
        const listRaw = await pool.query(listSql, listParams);
        const rows = selectRowArray(listRaw).map(rowToJson);

        res.json({
            notifications: rows,
            pagination: {
                total,
                limit,
                offset,
                has_more: offset + rows.length < total
            }
        });
    } catch (error) {
        console.error("getNotifications:", error.message);
        res.status(500).json({ message: error.message });
    }
};

/**
 * GET /api/admin/notifications/unread-count (admin only)
 * Badge: count of notifications where is_read is false / 0.
 */
export const getUnreadNotificationCount = async (req, res) => {
    try {
        const countRaw = await pool.query(
            "SELECT COUNT(*) AS unread_count FROM notifications WHERE is_read = 0"
        );
        const rows = selectRowArray(countRaw);
        const unread_count = jsonNumber(rows[0]?.unread_count ?? 0);

        res.json({ unread_count });
    } catch (error) {
        console.error("getUnreadNotificationCount:", error.message);
        res.status(500).json({ message: error.message });
    }
};

/**
 * PATCH /api/admin/notifications/read-all (admin only)
 * Marks every unread notification as read.
 */
export const markAllNotificationsRead = async (req, res) => {
    try {
        const result = await pool.query(
            "UPDATE notifications SET is_read = 1 WHERE is_read = 0"
        );
        const marked_read = jsonNumber(result?.affectedRows ?? 0);

        res.json({
            message: "All notifications marked as read.",
            marked_read
        });
    } catch (error) {
        console.error("markAllNotificationsRead:", error.message);
        res.status(500).json({ message: error.message });
    }
};
