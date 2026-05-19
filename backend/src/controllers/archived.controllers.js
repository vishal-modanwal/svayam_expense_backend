import { pool } from "../db/index.js";
import { selectRowArray, isMissingArchivedColumnError } from "../utils/mariaRows.js";
import {
    archivedCategoryWhere,
    archivedBudgetWhere,
    archivedExpenseWhere,
    activeExpenseWhere,
} from "../utils/categoryArchive.js";
import { isArchivedYes } from "../utils/archiveCategory.js";
import { restoreArchivedExpenseById } from "../utils/expenseArchive.js";
import { createNotification } from "../utils/notifications.js";
import { fireUserBudgetSync } from "../utils/userMonthlyBudget.js";

const num = (v) => (typeof v === "bigint" ? Number(v) : Number(v || 0));

const mapArchivedCategoryRow = (row) => ({
    id: num(row.id),
    name: row.name,
    description: row.description ?? null,
    created_at: row.created_at,
    archived: true,
    category_status: "history_only",
});

/**
 * GET /api/admin/archived/categories — same data as GET /api/category/archived
 */
export const getArchivedCategories = async (req, res) => {
    try {
        const rows = selectRowArray(
            await pool.query(
                `SELECT id, name, description, created_at, archived
                 FROM categories
                 WHERE ${archivedCategoryWhere("categories")}
                 ORDER BY created_at DESC, id DESC`
            )
        );
        res.json({
            status: "success",
            scope: "archived",
            data: rows.map(mapArchivedCategoryRow),
        });
    } catch (e) {
        if (isMissingArchivedColumnError(e)) {
            return res.json({ status: "success", scope: "archived", data: [] });
        }
        res.status(500).json({ error: e.message });
    }
};

const mapArchivedExpenseRow = (row) => ({
    id: num(row.id),
    title: row.title,
    amount: Number(row.amount),
    currency: row.currency,
    expense_type: row.expense_type,
    expense_date: row.expense_date,
    payment_method: row.payment_method,
    vendor: row.vendor,
    receipt_path: row.receipt_path ?? null,
    description: row.expense_description ?? row.description ?? null,
    notes: row.expense_description ?? row.description ?? null,
    created_at: row.created_at,
    user_id: num(row.user_id),
    user_name: row.user_name,
    category_id: num(row.category_id),
    category_name: row.category_name,
    archived: true,
    category_status: "history_only",
    archive_reason: row.archive_reason ?? null,
    deleted_at: row.deleted_at ?? null,
    deleted_by: row.deleted_by != null ? num(row.deleted_by) : null,
    deleted_by_name: row.deleted_by_name ?? null,
});

const buildArchivedExpenseQuery = (extraClauses, extraParams) => {
    const clauses = [archivedExpenseWhere("e")];
    const params = [...extraParams];
    if (extraClauses.length) {
        clauses.push(...extraClauses);
    }
    const whereSql = `WHERE ${clauses.join(" AND ")}`;
    return { whereSql, params };
};

/**
 * GET /api/admin/archived/expenses — all archived expenses
 */
export const getArchivedExpenses = async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 100);
        const offset = (page - 1) * limit;
        const orderDir = String(req.query.order ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
        const sortMap = {
            expense_date: "e.expense_date",
            amount: "e.amount",
            created_at: "e.created_at",
        };
        const sortKey = String(req.query.sortBy ?? "expense_date").trim();
        const sortCol = sortMap[sortKey] || sortMap.expense_date;

        const extraClauses = [];
        const extraParams = [];

        const search = String(req.query.search ?? "").trim();
        if (search) {
            extraClauses.push("(e.title LIKE ? OR e.vendor LIKE ? OR c.name LIKE ?)");
            extraParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (req.query.category_id) {
            const cid = parseInt(req.query.category_id, 10);
            if (!Number.isFinite(cid)) {
                return res.status(400).json({ message: "Invalid category_id" });
            }
            extraClauses.push("e.category_id = ?");
            extraParams.push(cid);
        }
        if (req.query.user_id) {
            const uid = parseInt(req.query.user_id, 10);
            if (!Number.isFinite(uid)) {
                return res.status(400).json({ message: "Invalid user_id" });
            }
            extraClauses.push("e.user_id = ?");
            extraParams.push(uid);
        }
        const month = parseInt(req.query.month, 10);
        const year = parseInt(req.query.year, 10);
        if (Number.isFinite(month) && Number.isFinite(year)) {
            extraClauses.push("MONTH(e.expense_date) = ? AND YEAR(e.expense_date) = ?");
            extraParams.push(month, year);
        }

        const { whereSql, params } = buildArchivedExpenseQuery(extraClauses, extraParams);

        const countSql = `
            SELECT COUNT(*) AS total
            FROM expenses e
            JOIN categories c ON c.id = e.category_id
            JOIN users u ON u.id = e.user_id
            ${whereSql}
        `;
        const dataSql = `
            SELECT
                e.id, e.title, e.category_id, e.user_id, e.amount, e.currency,
                e.payment_method, e.vendor, e.receipt_path,
                e.description AS expense_description,
                e.expense_date, e.expense_type, e.created_at, e.archived,
                e.archive_reason, e.deleted_at, e.deleted_by,
                u.name AS user_name, c.name AS category_name,
                du.name AS deleted_by_name
            FROM expenses e
            JOIN categories c ON c.id = e.category_id
            JOIN users u ON u.id = e.user_id
            LEFT JOIN users du ON du.id = e.deleted_by
            ${whereSql}
            ORDER BY ${sortCol} ${orderDir}, e.id DESC
            LIMIT ? OFFSET ?
        `;

        const total = num(selectRowArray(await pool.query(countSql, params))[0]?.total);
        const rows = selectRowArray(await pool.query(dataSql, [...params, limit, offset]));

        res.json({
            status: "success",
            scope: "archived",
            data: rows.map(mapArchivedExpenseRow),
            pagination: {
                page,
                limit,
                totalItems: total,
                totalPages: Math.ceil(total / limit) || 0,
            },
            sorting: {
                sort_by: Object.keys(sortMap).includes(sortKey) ? sortKey : "expense_date",
                order: orderDir.toLowerCase(),
            },
        });
    } catch (e) {
        if (isMissingArchivedColumnError(e)) {
            return res.json({
                status: "success",
                scope: "archived",
                data: [],
                pagination: { page: 1, limit: 15, totalItems: 0, totalPages: 0 },
            });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * GET /api/expense/my-expenses/archived — logged-in user's archived expenses only
 */
export const getMyArchivedExpenses = async (req, res) => {
    try {
        const uid = num(req.user?.id);
        if (!Number.isFinite(uid)) {
            return res.status(401).json({ message: "Invalid user session" });
        }

        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 100);
        const offset = (page - 1) * limit;
        const orderDir = String(req.query.order ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
        const sortMap = {
            expense_date: "e.expense_date",
            amount: "e.amount",
            created_at: "e.created_at",
        };
        const sortKey = String(req.query.sortBy ?? "expense_date").trim();
        const sortCol = sortMap[sortKey] || sortMap.expense_date;

        const extraClauses = ["e.user_id = ?"];
        const extraParams = [uid];

        const search = String(req.query.search ?? "").trim();
        if (search) {
            extraClauses.push("(e.title LIKE ? OR e.vendor LIKE ?)");
            extraParams.push(`%${search}%`, `%${search}%`);
        }
        if (req.query.category_id) {
            const cid = parseInt(req.query.category_id, 10);
            if (!Number.isFinite(cid)) {
                return res.status(400).json({ message: "Invalid category_id" });
            }
            extraClauses.push("e.category_id = ?");
            extraParams.push(cid);
        }

        const { whereSql, params } = buildArchivedExpenseQuery(extraClauses, extraParams);

        const countSql = `
            SELECT COUNT(*) AS total FROM expenses e
            JOIN categories c ON c.id = e.category_id
            ${whereSql}
        `;
        const dataSql = `
            SELECT
                e.id, e.title, e.category_id, e.user_id, e.amount, e.currency,
                e.payment_method, e.vendor, e.receipt_path,
                e.description AS expense_description,
                e.expense_date, e.expense_type, e.created_at, e.archived,
                e.archive_reason, e.deleted_at, e.deleted_by,
                c.name AS category_name,
                du.name AS deleted_by_name
            FROM expenses e
            JOIN categories c ON c.id = e.category_id
            LEFT JOIN users du ON du.id = e.deleted_by
            ${whereSql}
            ORDER BY ${sortCol} ${orderDir}, e.id DESC
            LIMIT ? OFFSET ?
        `;

        const total = num(selectRowArray(await pool.query(countSql, params))[0]?.total);
        const rows = selectRowArray(await pool.query(dataSql, [...params, limit, offset]));

        res.json({
            status: "success",
            scope: "archived",
            data: rows.map((row) => ({
                ...mapArchivedExpenseRow({ ...row, user_name: req.user?.name }),
                user_id: uid,
            })),
            pagination: {
                page,
                limit,
                totalItems: total,
                totalPages: Math.ceil(total / limit) || 0,
            },
            sorting: {
                sort_by: Object.keys(sortMap).includes(sortKey) ? sortKey : "expense_date",
                order: orderDir.toLowerCase(),
            },
        });
    } catch (e) {
        if (isMissingArchivedColumnError(e)) {
            return res.json({
                status: "success",
                scope: "archived",
                data: [],
                pagination: { page: 1, limit: 15, totalItems: 0, totalPages: 0 },
            });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * PATCH /api/admin/archived/expenses/:id/restore — admin restores a soft-archived expense.
 */
export const restoreArchivedExpense = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
        return res.status(400).json({ message: "Invalid expense id." });
    }

    try {
        const rows = selectRowArray(
            await pool.query(
                `SELECT e.id, e.user_id, e.amount, e.category_id, e.archived, e.archive_reason,
                        e.expense_date, e.expense_type,
                        c.archived AS category_archived, c.name AS category_name
                 FROM expenses e
                 JOIN categories c ON c.id = e.category_id
                 WHERE e.id = ?`,
                [id]
            )
        );
        if (!rows.length) {
            return res.status(404).json({ message: "Expense not found." });
        }
        const row = rows[0];
        if (!isArchivedYes(row.archived)) {
            return res.status(400).json({ message: "Expense is not archived." });
        }
        if (isArchivedYes(row.category_archived)) {
            return res.status(400).json({
                message:
                    "Cannot restore expense while its category is archived. Restore or unarchive the category first.",
                category_status: "history_only",
            });
        }

        const ownerId = num(row.user_id);
        const amount = Number(row.amount);
        const category_name = row.category_name ?? "category";
        const actorId = num(req.user?.id);
        const actorLabel =
            req.user?.name || req.user?.email || `User #${actorId}`;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const affected = await restoreArchivedExpenseById(conn, id);
            if (affected === 0) {
                await conn.rollback();
                return res.status(404).json({ message: "Expense not found or not archived." });
            }
            await createNotification(
                ownerId,
                id,
                "expense_restored",
                `${actorLabel} restored expense #${id} of ₹${amount} in ${category_name}`,
                conn
            );
            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

        fireUserBudgetSync(pool, {
            userId: ownerId,
            expenseDate: row.expense_date,
            expenseType: row.expense_type || "standard",
        });

        res.json({
            message: "Expense restored successfully.",
            expenseId: id,
            archived: false,
        });
    } catch (e) {
        if (isMissingArchivedColumnError(e)) {
            return res.status(503).json({
                message: "Run Schema.sql expense audit upgrade, then retry.",
                code: "SCHEMA_MISSING_archived",
            });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * Shared archived budgets list (admin: all; user route uses same handler).
 * GET /api/admin/archived/budgets | GET /api/category/archived/budgets
 */
export const getArchivedBudgets = async (req, res) => {
    try {
        const now = new Date();
        let month = parseInt(req.query.month, 10);
        let year = parseInt(req.query.year, 10);
        if (!Number.isFinite(month) || month < 1 || month > 12) {
            month = now.getMonth() + 1;
        }
        if (!Number.isFinite(year) || year < 2000 || year > 2100) {
            year = now.getFullYear();
        }

        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
        const offset = (page - 1) * limit;
        const search = String(req.query.search ?? "").trim();

        const stdSum =
            "COALESCE(SUM(CASE WHEN e.expense_type = 'standard' AND " +
            activeExpenseWhere("e") +
            " THEN e.amount ELSE 0 END), 0)";
        const whereParts = [
            "b.month = ?",
            "b.year = ?",
            archivedBudgetWhere("b"),
        ];
        const baseParams = [month, year];
        if (search) {
            whereParts.push("c.name LIKE ?");
            baseParams.push(`%${search}%`);
        }
        const whereSql = whereParts.join(" AND ");

        const countSql = `
            SELECT COUNT(*) AS total_records
            FROM monthly_budgets b
            JOIN categories c ON c.id = b.category_id
            WHERE ${whereSql}
        `;
        const dataSql = `
            SELECT
                b.id AS budget_id,
                b.category_id,
                c.name AS category_name,
                c.description AS category_description,
                b.month,
                b.year,
                b.allocated_amount,
                b.currency,
                b.archived,
                ${stdSum} AS total_spent,
                (b.allocated_amount - ${stdSum}) AS remaining_amount,
                CASE
                    WHEN b.allocated_amount > 0
                    THEN ROUND((${stdSum} / b.allocated_amount) * 100, 2)
                    ELSE 0
                END AS usage_percentage
            FROM monthly_budgets b
            JOIN categories c ON c.id = b.category_id
            LEFT JOIN expenses e ON e.category_id = b.category_id
                AND MONTH(e.expense_date) = b.month
                AND YEAR(e.expense_date) = b.year
            WHERE ${whereSql}
            GROUP BY b.id, b.category_id, c.name, c.description, b.month, b.year, b.allocated_amount, b.currency, b.archived
            ORDER BY c.name ASC, b.id DESC
            LIMIT ? OFFSET ?
        `;

        const totalRecords = num(selectRowArray(await pool.query(countSql, baseParams))[0]?.total_records);
        const list = selectRowArray(await pool.query(dataSql, [...baseParams, limit, offset]));

        res.json({
            status: "success",
            scope: "archived",
            month,
            year,
            note: "Historical only — not included in live dashboard totals.",
            pagination: {
                page,
                limit,
                total_records: totalRecords,
                total_pages: Math.ceil(totalRecords / limit) || 0,
            },
            data: list.map((row) => ({
                budget_id: num(row.budget_id),
                category_id: num(row.category_id),
                category_name: row.category_name,
                category_description: row.category_description ?? null,
                archived: true,
                category_status: "history_only",
                month: num(row.month),
                year: num(row.year),
                allocated_amount: Number(row.allocated_amount),
                currency: row.currency,
                total_spent: Number(row.total_spent),
                remaining_amount: Number(row.remaining_amount),
                usage_percentage: Number(row.usage_percentage),
            })),
        });
    } catch (e) {
        if (isMissingArchivedColumnError(e)) {
            return res.json({
                status: "success",
                scope: "archived",
                data: [],
                pagination: { page: 1, limit: 10, total_records: 0, total_pages: 0 },
            });
        }
        res.status(500).json({ error: e.message });
    }
};
