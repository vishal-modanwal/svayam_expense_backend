import { pool } from "../db/index.js";
import { selectRowArray, isMissingDeletedAtColumnError } from "../utils/mariaRows.js";
import { archivedCategoryWhere } from "../utils/categoryArchive.js";

const num = (v) => (typeof v === "bigint" ? Number(v) : Number(v || 0));

const mapArchivedCategoryRow = (row) => ({
    id: num(row.id),
    name: row.name,
    description: row.description ?? null,
    created_at: row.created_at,
    archived_at: row.deleted_at,
    archived: true,
    category_status: "history_only",
});

/**
 * GET /api/admin/archived/categories
 */
export const getArchivedCategories = async (req, res) => {
    try {
        const rows = selectRowArray(
            await pool.query(
                `SELECT id, name, description, created_at, deleted_at
                 FROM categories
                 WHERE ${archivedCategoryWhere("categories")}
                 ORDER BY deleted_at DESC, id DESC`
            )
        );
        res.json({
            status: "success",
            scope: "archived",
            data: rows.map(mapArchivedCategoryRow),
        });
    } catch (e) {
        if (isMissingDeletedAtColumnError(e)) {
            return res.json({ status: "success", scope: "archived", data: [] });
        }
        res.status(500).json({ error: e.message });
    }
};

/**
 * GET /api/admin/archived/expenses
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

        const clauses = [archivedCategoryWhere("c")];
        const params = [];

        const search = String(req.query.search ?? "").trim();
        if (search) {
            clauses.push("(e.title LIKE ? OR e.vendor LIKE ? OR c.name LIKE ?)");
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (req.query.category_id) {
            const cid = parseInt(req.query.category_id, 10);
            if (!Number.isFinite(cid)) {
                return res.status(400).json({ message: "Invalid category_id" });
            }
            clauses.push("e.category_id = ?");
            params.push(cid);
        }
        if (req.query.user_id) {
            const uid = parseInt(req.query.user_id, 10);
            if (!Number.isFinite(uid)) {
                return res.status(400).json({ message: "Invalid user_id" });
            }
            clauses.push("e.user_id = ?");
            params.push(uid);
        }
        const month = parseInt(req.query.month, 10);
        const year = parseInt(req.query.year, 10);
        if (Number.isFinite(month) && Number.isFinite(year)) {
            clauses.push("MONTH(e.expense_date) = ? AND YEAR(e.expense_date) = ?");
            params.push(month, year);
        }

        const whereSql = `WHERE ${clauses.join(" AND ")}`;
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
                e.expense_date, e.expense_type, e.created_at,
                u.name AS user_name, c.name AS category_name, c.deleted_at AS category_archived_at
            FROM expenses e
            JOIN categories c ON c.id = e.category_id
            JOIN users u ON u.id = e.user_id
            ${whereSql}
            ORDER BY ${sortCol} ${orderDir}, e.id DESC
            LIMIT ? OFFSET ?
        `;

        const countRows = selectRowArray(await pool.query(countSql, params));
        const total = num(countRows[0]?.total);
        const rows = selectRowArray(await pool.query(dataSql, [...params, limit, offset]));

        res.json({
            status: "success",
            scope: "archived",
            data: rows.map((row) => ({
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
                category_status: "history_only",
                category_archived_at: row.category_archived_at,
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
        if (isMissingDeletedAtColumnError(e)) {
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
 * GET /api/admin/archived/budgets — historical budgets for archived categories only (read-only).
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
            "COALESCE(SUM(CASE WHEN e.expense_type = 'standard' THEN e.amount ELSE 0 END), 0)";
        const whereParts = ["b.month = ?", "b.year = ?", archivedCategoryWhere("c")];
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
                c.deleted_at AS category_archived_at,
                b.month,
                b.year,
                b.allocated_amount,
                b.currency,
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
            GROUP BY b.id, b.category_id, c.name, c.description, c.deleted_at, b.month, b.year, b.allocated_amount, b.currency
            ORDER BY c.deleted_at DESC, c.name ASC, b.id DESC
            LIMIT ? OFFSET ?
        `;

        const countRows = selectRowArray(await pool.query(countSql, baseParams));
        const totalRecords = num(countRows[0]?.total_records);
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
                category_archived_at: row.category_archived_at,
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
        if (isMissingDeletedAtColumnError(e)) {
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
