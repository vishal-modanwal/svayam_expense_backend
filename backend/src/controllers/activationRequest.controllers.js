import { pool } from "../db/index.js";
import { selectRowArray } from "../utils/mariaRows.js";
import { createNotification } from "../utils/notifications.js";
import { sendActivationRequestReviewEmail } from "../utils/emailService.js";
import {
    ACTIVATION_NOTIFY,
    ACTIVATION_STATUS,
    isMissingActivationTableError,
} from "../utils/activationRequest.js";

const num = (v) => (typeof v === "bigint" ? Number(v) : Number(v || 0));

const mapRequestRow = (row) => ({
    id: num(row.id),
    user_id: num(row.user_id),
    user_name: row.user_name ?? null,
    user_email: row.user_email ?? null,
    status: row.status,
    message: row.message ?? null,
    admin_note: row.admin_note ?? null,
    reviewed_by: row.reviewed_by != null ? num(row.reviewed_by) : null,
    reviewed_by_name: row.reviewed_by_name ?? null,
    reviewed_at: row.reviewed_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
});

async function fetchLatestRequestForUser(userId) {
    const rows = selectRowArray(
        await pool.query(
            `SELECT r.*, u.name AS user_name, u.email AS user_email,
                    a.name AS reviewed_by_name
             FROM user_activation_requests r
             JOIN users u ON u.id = r.user_id
             LEFT JOIN users a ON a.id = r.reviewed_by
             WHERE r.user_id = ?
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT 1`,
            [userId]
        )
    );
    return rows[0] ?? null;
}

async function fetchPendingForUser(userId) {
    const rows = selectRowArray(
        await pool.query(
            `SELECT id FROM user_activation_requests
             WHERE user_id = ? AND status = ? LIMIT 1`,
            [userId, ACTIVATION_STATUS.PENDING]
        )
    );
    return rows[0] ?? null;
}

async function notifyAdminsNewRequest(conn, subjectUserId, message) {
    const userRows = selectRowArray(
        await conn.query("SELECT name, email FROM users WHERE id = ?", [subjectUserId])
    );
    const label = userRows[0]?.name || userRows[0]?.email || `User #${subjectUserId}`;
    const msgText = message?.trim()
        ? `${label} requested account activation: ${message.trim()}`
        : `${label} requested account activation.`;

    const admins = selectRowArray(
        await conn.query(
            `SELECT id FROM users WHERE role = 'admin' AND is_active = 1`
        )
    );
    for (const admin of admins) {
        await createNotification(
            num(admin.id),
            null,
            ACTIVATION_NOTIFY.SUBMITTED,
            msgText,
            conn
        );
    }
}

/**
 * POST /api/profile/activation-request
 * Body: { message? }
 */
export const submitActivationRequest = async (req, res) => {
    try {
        const userId = num(req.user?.id);
        if (!Number.isFinite(userId)) {
            return res.status(401).json({ message: "Invalid user session." });
        }

        const userRows = selectRowArray(
            await pool.query(
                "SELECT id, name, email, role, is_active FROM users WHERE id = ?",
                [userId]
            )
        );
        if (!userRows.length) {
            return res.status(404).json({ message: "User not found." });
        }
        const user = userRows[0];
        if (user.role === "admin") {
            return res.status(400).json({
                message: "Admin accounts do not use activation requests.",
            });
        }
        if (Number(user.is_active) === 1) {
            return res.status(400).json({
                message: "Your account is already active.",
                activity_status: "active",
            });
        }

        const pending = await fetchPendingForUser(userId);
        if (pending) {
            return res.status(409).json({
                message: "You already have a pending activation request.",
                request_id: num(pending.id),
                status: ACTIVATION_STATUS.PENDING,
            });
        }

        const message =
            req.body?.message !== undefined && req.body?.message !== null
                ? String(req.body.message).trim() || null
                : null;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const ins = await conn.query(
                `INSERT INTO user_activation_requests (user_id, status, message)
                 VALUES (?, ?, ?)`,
                [userId, ACTIVATION_STATUS.PENDING, message]
            );
            await notifyAdminsNewRequest(conn, userId, message);
            await conn.commit();

            const requestId = num(ins.insertId);
            const row = await fetchLatestRequestForUser(userId);

            res.status(201).json({
                status: "success",
                message: "Activation request submitted. An administrator will review it.",
                request: row ? mapRequestRow(row) : { id: requestId, status: ACTIVATION_STATUS.PENDING },
                is_active: false,
                activity_status: "inactive",
            });
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
    } catch (e) {
        if (isMissingActivationTableError(e)) {
            return res.status(503).json({
                message: "Run Schema.sql user_activation_requests upgrade, then retry.",
                code: "SCHEMA_MISSING_user_activation_requests",
            });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * GET /api/profile/activation-request
 */
export const getMyActivationRequest = async (req, res) => {
    try {
        const userId = num(req.user?.id);
        if (!Number.isFinite(userId)) {
            return res.status(401).json({ message: "Invalid user session." });
        }

        const userRows = selectRowArray(
            await pool.query("SELECT is_active FROM users WHERE id = ?", [userId])
        );
        if (!userRows.length) {
            return res.status(404).json({ message: "User not found." });
        }

        const active = Number(userRows[0].is_active) === 1;
        const row = await fetchLatestRequestForUser(userId);

        res.json({
            status: "success",
            is_active: active,
            activity_status: active ? "active" : "inactive",
            request: row ? mapRequestRow(row) : null,
        });
    } catch (e) {
        if (isMissingActivationTableError(e)) {
            return res.json({
                status: "success",
                is_active: Number(req.user?.is_active) === 1,
                activity_status: Number(req.user?.is_active) === 1 ? "active" : "inactive",
                request: null,
            });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * GET /api/admin/activation-requests?status=pending&page=1&limit=20
 */
export const listActivationRequests = async (req, res) => {
    try {
        const page = Math.max(parseInt(String(req.query.page ?? "1"), 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);
        const offset = (page - 1) * limit;

        const clauses = ["1=1"];
        const params = [];

        if (req.query.status !== undefined && req.query.status !== "") {
            const st = String(req.query.status).toLowerCase();
            const allowed = Object.values(ACTIVATION_STATUS);
            if (!allowed.includes(st)) {
                return res.status(400).json({
                    message: `Invalid status. Use: ${allowed.join(", ")}`,
                });
            }
            clauses.push("r.status = ?");
            params.push(st);
        }

        const whereSql = `WHERE ${clauses.join(" AND ")}`;

        const total = num(
            selectRowArray(
                await pool.query(
                    `SELECT COUNT(*) AS total FROM user_activation_requests r ${whereSql}`,
                    params
                )
            )[0]?.total
        );

        const rows = selectRowArray(
            await pool.query(
                `SELECT r.*, u.name AS user_name, u.email AS user_email,
                        a.name AS reviewed_by_name
                 FROM user_activation_requests r
                 JOIN users u ON u.id = r.user_id
                 LEFT JOIN users a ON a.id = r.reviewed_by
                 ${whereSql}
                 ORDER BY
                   CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END,
                   r.created_at DESC,
                   r.id DESC
                 LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            )
        );

        res.json({
            status: "success",
            data: rows.map(mapRequestRow),
            pagination: {
                page,
                limit,
                totalItems: total,
                totalPages: Math.ceil(total / limit) || 0,
            },
        });
    } catch (e) {
        if (isMissingActivationTableError(e)) {
            return res.json({
                status: "success",
                data: [],
                pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0 },
            });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * GET /api/admin/activation-requests/:id
 */
export const getActivationRequestById = async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ message: "Invalid request id." });
        }

        const rows = selectRowArray(
            await pool.query(
                `SELECT r.*, u.name AS user_name, u.email AS user_email,
                        a.name AS reviewed_by_name
                 FROM user_activation_requests r
                 JOIN users u ON u.id = r.user_id
                 LEFT JOIN users a ON a.id = r.reviewed_by
                 WHERE r.id = ?`,
                [id]
            )
        );
        if (!rows.length) {
            return res.status(404).json({ message: "Activation request not found." });
        }

        res.json({ status: "success", data: mapRequestRow(rows[0]) });
    } catch (e) {
        if (isMissingActivationTableError(e)) {
            return res.status(404).json({ message: "Activation request not found." });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * PATCH /api/admin/activation-requests/:id
 * Body: { action: "approve" | "reject", admin_note? }
 */
export const reviewActivationRequest = async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ message: "Invalid request id." });
        }

        const action = String(req.body?.action ?? "").toLowerCase();
        if (action !== "approve" && action !== "reject") {
            return res.status(400).json({
                message: 'action must be "approve" or "reject".',
            });
        }

        const adminNote =
            req.body?.admin_note !== undefined && req.body?.admin_note !== null
                ? String(req.body.admin_note).trim() || null
                : null;

        const adminId = num(req.user?.id);

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const rows = selectRowArray(
                await conn.query(
                    `SELECT r.*, u.name AS user_name, u.email AS user_email
                     FROM user_activation_requests r
                     JOIN users u ON u.id = r.user_id
                     WHERE r.id = ? FOR UPDATE`,
                    [id]
                )
            );
            if (!rows.length) {
                await conn.rollback();
                return res.status(404).json({ message: "Activation request not found." });
            }

            const row = rows[0];
            if (row.status !== ACTIVATION_STATUS.PENDING) {
                await conn.rollback();
                return res.status(400).json({
                    message: `Request is already ${row.status}.`,
                    status: row.status,
                });
            }

            const targetUserId = num(row.user_id);
            const userLabel = row.user_name || row.user_email || `User #${targetUserId}`;
            const newStatus =
                action === "approve"
                    ? ACTIVATION_STATUS.APPROVED
                    : ACTIVATION_STATUS.REJECTED;

            await conn.query(
                `UPDATE user_activation_requests
                 SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [newStatus, adminNote, adminId, id]
            );

            if (action === "approve") {
                await conn.query("UPDATE users SET is_active = 1 WHERE id = ?", [targetUserId]);
                const msg = adminNote
                    ? `Your activation request was approved. Note: ${adminNote}`
                    : "Your activation request was approved. Your account is now active.";
                await createNotification(
                    targetUserId,
                    null,
                    ACTIVATION_NOTIFY.APPROVED,
                    msg,
                    conn
                );
            } else {
                const msg = adminNote
                    ? `Your activation request was rejected. Reason: ${adminNote}`
                    : "Your activation request was rejected. You may submit a new request.";
                await createNotification(
                    targetUserId,
                    null,
                    ACTIVATION_NOTIFY.REJECTED,
                    msg,
                    conn
                );
            }

            await conn.commit();

            const userEmail = String(row.user_email ?? "").trim();
            if (userEmail) {
                sendActivationRequestReviewEmail(userEmail, {
                    name: row.user_name,
                    action,
                    adminNote,
                }).catch((err) =>
                    console.error("Activation review email failed:", err.message)
                );
            }

            const updated = selectRowArray(
                await pool.query(
                    `SELECT r.*, u.name AS user_name, u.email AS user_email,
                            a.name AS reviewed_by_name
                     FROM user_activation_requests r
                     JOIN users u ON u.id = r.user_id
                     LEFT JOIN users a ON a.id = r.reviewed_by
                     WHERE r.id = ?`,
                    [id]
                )
            )[0];

            res.json({
                status: "success",
                message:
                    action === "approve"
                        ? `${userLabel}'s account has been activated.`
                        : `${userLabel}'s activation request was rejected.`,
                data: mapRequestRow(updated),
                user_activated: action === "approve",
            });
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
    } catch (e) {
        if (isMissingActivationTableError(e)) {
            return res.status(503).json({
                message: "Run Schema.sql user_activation_requests upgrade, then retry.",
                code: "SCHEMA_MISSING_user_activation_requests",
            });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * GET /api/admin/activation-requests/pending-count
 */
export const getPendingActivationCount = async (req, res) => {
    try {
        const rows = selectRowArray(
            await pool.query(
                `SELECT COUNT(*) AS pending_count FROM user_activation_requests WHERE status = ?`,
                [ACTIVATION_STATUS.PENDING]
            )
        );
        res.json({ pending_count: num(rows[0]?.pending_count) });
    } catch (e) {
        if (isMissingActivationTableError(e)) {
            return res.json({ pending_count: 0 });
        }
        res.status(500).json({ error: e.message });
    }
};
