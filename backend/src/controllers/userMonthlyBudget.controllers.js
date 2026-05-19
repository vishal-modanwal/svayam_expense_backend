import { pool } from "../db/index.js";
import { selectRowArray } from "../utils/mariaRows.js";
import {
    fetchUserMonthlyBudgetRow,
    sumUserStandardSpent,
    buildUserBudgetPayload,
    syncUserBudgetAfterExpenseChange,
    isMissingUserBudgetTableError,
} from "../utils/userMonthlyBudget.js";

const num = (v) => (typeof v === "bigint" ? Number(v) : Number(v || 0));

const fetchBudgetDetailById = async (id) => {
    const rows = selectRowArray(
        await pool.query(
            `SELECT b.*, u.name AS user_name, u.email AS user_email
             FROM user_monthly_budgets b
             JOIN users u ON u.id = b.user_id
             WHERE b.id = ?`,
            [id]
        )
    );
    return rows[0] ?? null;
};

const mapBudgetListRow = async (row) => {
    const userId = num(row.user_id);
    const month = row.month;
    const year = row.year;
    const spent = await sumUserStandardSpent(pool, userId, month, year);
    const allocated = parseFloat(String(row.allocated_amount ?? 0));
    return {
        id: num(row.id),
        user_id: userId,
        user_name: row.user_name ?? null,
        user_email: row.user_email ?? null,
        month,
        year,
        allocated_amount: allocated,
        currency: row.currency || "INR",
        spent,
        remaining: allocated - spent,
        exceeded: spent > allocated,
        exceeded_at: row.exceeded_at ?? null,
        exceeded_notified_at: row.exceeded_notified_at ?? null,
        created_by: row.created_by != null ? num(row.created_by) : null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
};

/**
 * POST /api/admin/user-budgets — create or replace budget for user + month + year
 * Body: { user_id, month, year, allocated_amount, currency? }
 */
export const upsertUserMonthlyBudget = async (req, res) => {
    try {
        const user_id = parseInt(String(req.body.user_id ?? ""), 10);
        const month = parseInt(String(req.body.month ?? ""), 10);
        const year = parseInt(String(req.body.year ?? ""), 10);
        const allocated_amount = parseFloat(String(req.body.allocated_amount ?? ""));
        const currency = String(req.body.currency ?? "INR").trim() || "INR";

        if (!Number.isFinite(user_id) || !Number.isFinite(month) || month < 1 || month > 12) {
            return res.status(400).json({ message: "Valid user_id and month (1–12) are required." });
        }
        if (!Number.isFinite(year) || year < 2000 || year > 2100) {
            return res.status(400).json({ message: "Valid year is required." });
        }
        if (!Number.isFinite(allocated_amount) || allocated_amount < 0) {
            return res.status(400).json({ message: "allocated_amount must be a non-negative number." });
        }

        const userCheck = selectRowArray(
            await pool.query("SELECT id, role FROM users WHERE id = ?", [user_id])
        );
        if (!userCheck.length) {
            return res.status(404).json({ message: "User not found." });
        }

        const adminId = num(req.user?.id);
        const existing = await fetchUserMonthlyBudgetRow(pool, user_id, month, year);

        let budgetId;
        if (existing) {
            budgetId = num(existing.id);
            await pool.query(
                `UPDATE user_monthly_budgets
                 SET allocated_amount = ?, currency = ?, created_by = ?,
                     exceeded_at = NULL, exceeded_notified_at = NULL
                 WHERE id = ?`,
                [allocated_amount, currency, adminId, budgetId]
            );
        } else {
            const ins = await pool.query(
                `INSERT INTO user_monthly_budgets
                 (user_id, month, year, allocated_amount, currency, created_by)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [user_id, month, year, allocated_amount, currency, adminId]
            );
            budgetId = num(ins.insertId);
        }

        const conn = await pool.getConnection();
        let payload;
        try {
            await conn.beginTransaction();
            payload = await syncUserBudgetAfterExpenseChange(conn, {
                userId: user_id,
                expenseDate: new Date(year, month - 1, 1),
                expenseType: "standard",
            });
            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

        res.status(existing ? 200 : 201).json({
            message: existing ? "User monthly budget updated." : "User monthly budget created.",
            ...payload,
        });
    } catch (e) {
        if (isMissingUserBudgetTableError(e)) {
            return res.status(503).json({
                message: "Run Schema.sql user_monthly_budgets upgrade, then retry.",
                code: "SCHEMA_MISSING_user_monthly_budgets",
            });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * GET /api/admin/user-budgets?month=&year=&user_id=&page=&limit=
 */
export const listUserMonthlyBudgets = async (req, res) => {
    try {
        const now = new Date();
        const month = parseInt(String(req.query.month ?? now.getMonth() + 1), 10);
        const year = parseInt(String(req.query.year ?? now.getFullYear()), 10);
        const page = Math.max(parseInt(String(req.query.page ?? "1"), 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 100);
        const offset = (page - 1) * limit;

        const clauses = ["1=1"];
        const params = [];

        if (Number.isFinite(month) && month >= 1 && month <= 12) {
            clauses.push("b.month = ?");
            params.push(month);
        }
        if (Number.isFinite(year)) {
            clauses.push("b.year = ?");
            params.push(year);
        }
        if (req.query.user_id !== undefined && req.query.user_id !== "") {
            const uid = parseInt(String(req.query.user_id), 10);
            if (!Number.isFinite(uid)) {
                return res.status(400).json({ message: "Invalid user_id." });
            }
            clauses.push("b.user_id = ?");
            params.push(uid);
        }

        const whereSql = `WHERE ${clauses.join(" AND ")}`;

        const total = num(
            selectRowArray(
                await pool.query(
                    `SELECT COUNT(*) AS total FROM user_monthly_budgets b ${whereSql}`,
                    params
                )
            )[0]?.total
        );

        const rows = selectRowArray(
            await pool.query(
                `SELECT b.*, u.name AS user_name, u.email AS user_email
                 FROM user_monthly_budgets b
                 JOIN users u ON u.id = b.user_id
                 ${whereSql}
                 ORDER BY b.year DESC, b.month DESC, u.name ASC
                 LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            )
        );

        const data = await Promise.all(rows.map(mapBudgetListRow));

        res.json({
            status: "success",
            data,
            pagination: {
                page,
                limit,
                totalItems: total,
                totalPages: Math.ceil(total / limit) || 0,
            },
        });
    } catch (e) {
        if (isMissingUserBudgetTableError(e)) {
            return res.json({
                status: "success",
                data: [],
                pagination: { page: 1, limit: 50, totalItems: 0, totalPages: 0 },
            });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * GET /api/admin/user-budgets/:id
 */
export const getUserMonthlyBudgetById = async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ message: "Invalid budget id." });
        }

        const row = await fetchBudgetDetailById(id);
        if (!row) {
            return res.status(404).json({ message: "User monthly budget not found." });
        }

        res.json({
            status: "success",
            data: await mapBudgetListRow(row),
        });
    } catch (e) {
        if (isMissingUserBudgetTableError(e)) {
            return res.status(503).json({
                message: "Run Schema.sql user_monthly_budgets upgrade, then retry.",
                code: "SCHEMA_MISSING_user_monthly_budgets",
            });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * PUT /api/admin/user-budgets/:id
 * Body: { allocated_amount, currency? }
 */
export const updateUserMonthlyBudgetById = async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ message: "Invalid budget id." });
        }

        const row = await fetchBudgetDetailById(id);
        if (!row) {
            return res.status(404).json({ message: "User monthly budget not found." });
        }

        const allocated_amount = parseFloat(String(req.body.allocated_amount ?? ""));
        const currency =
            req.body.currency !== undefined
                ? String(req.body.currency).trim() || "INR"
                : row.currency || "INR";

        if (!Number.isFinite(allocated_amount) || allocated_amount < 0) {
            return res.status(400).json({ message: "allocated_amount must be a non-negative number." });
        }

        const adminId = num(req.user?.id);
        const user_id = num(row.user_id);
        const month = row.month;
        const year = row.year;

        await pool.query(
            `UPDATE user_monthly_budgets
             SET allocated_amount = ?, currency = ?, created_by = ?,
                 exceeded_at = NULL, exceeded_notified_at = NULL
             WHERE id = ?`,
            [allocated_amount, currency, adminId, id]
        );

        const conn = await pool.getConnection();
        let payload;
        try {
            await conn.beginTransaction();
            payload = await syncUserBudgetAfterExpenseChange(conn, {
                userId: user_id,
                expenseDate: new Date(year, month - 1, 1),
                expenseType: "standard",
            });
            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

        res.json({
            message: "User monthly budget updated.",
            ...payload,
        });
    } catch (e) {
        if (isMissingUserBudgetTableError(e)) {
            return res.status(503).json({
                message: "Run Schema.sql user_monthly_budgets upgrade, then retry.",
                code: "SCHEMA_MISSING_user_monthly_budgets",
            });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * DELETE /api/admin/user-budgets/:id
 */
export const deleteUserMonthlyBudget = async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ message: "Invalid budget id." });
        }
        const result = await pool.query("DELETE FROM user_monthly_budgets WHERE id = ?", [id]);
        const affected = typeof result?.affectedRows === "number" ? result.affectedRows : 0;
        if (affected === 0) {
            return res.status(404).json({ message: "User monthly budget not found." });
        }
        res.json({ message: "User monthly budget removed. Category budget rules apply for this user." });
    } catch (e) {
        if (isMissingUserBudgetTableError(e)) {
            return res.status(503).json({
                message: "Run Schema.sql user_monthly_budgets upgrade, then retry.",
                code: "SCHEMA_MISSING_user_monthly_budgets",
            });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * GET /api/profile/monthly-budget?month=&year=
 */
export const getMyMonthlyBudget = async (req, res) => {
    try {
        const uid = num(req.user?.id);
        if (!Number.isFinite(uid)) {
            return res.status(401).json({ message: "Invalid user session." });
        }

        const now = new Date();
        const month = parseInt(String(req.query.month ?? now.getMonth() + 1), 10);
        const year = parseInt(String(req.query.year ?? now.getFullYear()), 10);

        const budgetRow = await fetchUserMonthlyBudgetRow(pool, uid, month, year);
        if (!budgetRow) {
            return res.json({
                status: "success",
                ...buildUserBudgetPayload(null, 0),
            });
        }

        const spent = await sumUserStandardSpent(pool, uid, month, year);
        res.json({
            status: "success",
            ...buildUserBudgetPayload(budgetRow, spent),
        });
    } catch (e) {
        if (isMissingUserBudgetTableError(e)) {
            return res.json({
                status: "success",
                budget_mode: "category_only",
                user_monthly_budget: null,
            });
        }
        res.status(500).json({ error: e.message });
    }
};
