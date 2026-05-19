import { pool } from "../db/index.js";
import { selectRowArray, isMissingArchivedColumnError } from "../utils/mariaRows.js";
import {
    activeCategoryWhere,
    activeBudgetWhere,
    activeExpenseWhere,
    activeExpenseCategoryExists,
    ARCHIVED_NO,
    ARCHIVED_YES,
} from "../utils/categoryArchive.js";
import { archiveCategoryCascade } from "../utils/archiveCategory.js";

/** True when (year, month) is strictly before the current calendar month (same rule as budget create). */
const isPastBudgetPeriod = (year, month) => {
    const d = new Date();
    const curM = d.getMonth() + 1;
    const curY = d.getFullYear();
    return year < curY || (year === curY && month < curM);
};

/**
 * TOGGLE USER ACTIVE STATUS (Admin Only)
 * Purpose: Enable or disable a user account.
 */
export const toggleUserStatus = async (req, res) => {
    const { id } = req.params; // Jis user ka status badalna hai

    try {
        // SQL logic: is_active = NOT is_active status ko flip kar deta hai
        const result = await pool.query(
            "UPDATE users SET is_active = NOT is_active WHERE id = ?",
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        // Updated status fetch karein confirmation ke liye
        const updatedUser = await pool.query(
            "SELECT id, name, is_active FROM users WHERE id = ?",
            [id]
        );

        res.json({ 
            message: `User status updated successfully.`,
            user: updatedUser[0]
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};


/**
 * CREATE CATEGORY AND SET BUDGET (Atomic Flow)
 */
export const createCategoryWithBudget = async (req, res) => {
    const { name, description, month, year, allocated_amount, currency } = req.body;
    const admin_id = req.user.id;

    // Past date constraint
    if (isPastBudgetPeriod(year, month)) {
        return res.status(400).json({ message: "Past months are not allowed for budgeting." });
    }

    let connection;
    try {
        // Transaction 
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const dup = selectRowArray(
            await connection.query(
                "SELECT id FROM categories WHERE name = ? AND archived = ? LIMIT 1",
                [name, ARCHIVED_NO]
            )
        );
        if (dup.length > 0) {
            await connection.rollback();
            return res.status(400).json({ message: "This category already exists." });
        }

        // Step 1: Create Category
        const catResult = await connection.query(
            "INSERT INTO categories (name, description, archived) VALUES (?, ?, ?)",
            [name, description, ARCHIVED_NO]
        );
        const result = Array.isArray(catResult) ? catResult[0] : catResult;
        const category_id = result.insertId;

        // Step 2: Set Monthly Budget for this new category
        await connection.query(
            `INSERT INTO monthly_budgets (category_id, month, year, allocated_amount, currency, created_by, archived)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [category_id, month, year, allocated_amount, currency || "INR", admin_id, ARCHIVED_NO]
        );

        // Sab sahi raha toh commit karein
        await connection.commit();

        res.status(201).json({
            message: "Category and Budget created successfully!",
            data: { category_id : category_id.toString(), name, month, year, allocated_amount }
        });

    } catch (error) {
        if (connection) await connection.rollback(); // Error aane par rollback karein
        
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: "This category already exists." });
        }
        res.status(500).json({ error: error.message });
    } finally {
        if (connection) connection.release();
    }
};

/**
 * GET TOTAL BUDGET SUMMARY (dashboard cards — current calendar month/year)
 * Budget: allocated sum. Expenses / remaining: standard-type only. Extra: extra-type sum/count.
 */
const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));

export const getTotalBudgetsSummary = async (req, res) => {
    try {
        const activeCat = activeCategoryWhere("c");
        const activeBud = activeBudgetWhere("b");
        const activeExp = activeExpenseCategoryExists("e");
        const sql = `
            SELECT
                (SELECT COALESCE(SUM(b.allocated_amount), 0) FROM monthly_budgets b
                 INNER JOIN categories c ON c.id = b.category_id AND ${activeCat}
                 WHERE b.month = MONTH(CURRENT_DATE()) AND b.year = YEAR(CURRENT_DATE()) AND ${activeBud}) AS total_allocated,
                (SELECT COUNT(*) FROM monthly_budgets b
                 INNER JOIN categories c ON c.id = b.category_id AND ${activeCat}
                 WHERE b.month = MONTH(CURRENT_DATE()) AND b.year = YEAR(CURRENT_DATE()) AND ${activeBud}) AS budget_category_count,

                (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e
                 WHERE e.expense_type = 'standard'
                 AND MONTH(e.expense_date) = MONTH(CURRENT_DATE())
                 AND YEAR(e.expense_date) = YEAR(CURRENT_DATE())
                 AND ${activeExp}) AS total_spent,
                (SELECT COUNT(*) FROM expenses e
                 WHERE e.expense_type = 'standard'
                 AND MONTH(e.expense_date) = MONTH(CURRENT_DATE())
                 AND YEAR(e.expense_date) = YEAR(CURRENT_DATE())
                 AND ${activeExp}) AS expense_record_count,

                (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e
                 WHERE e.expense_type = 'extra'
                 AND MONTH(e.expense_date) = MONTH(CURRENT_DATE())
                 AND YEAR(e.expense_date) = YEAR(CURRENT_DATE())
                 AND ${activeExp}) AS extra_total_spent,
                (SELECT COUNT(*) FROM expenses e
                 WHERE e.expense_type = 'extra'
                 AND MONTH(e.expense_date) = MONTH(CURRENT_DATE())
                 AND YEAR(e.expense_date) = YEAR(CURRENT_DATE())
                 AND ${activeExp}) AS extra_transaction_count,

                (SELECT COUNT(*) FROM (
                    SELECT
                        (b.allocated_amount - COALESCE(SUM(CASE WHEN e.expense_type = 'standard' AND e.archived = 'no' THEN e.amount ELSE 0 END), 0)) AS rem
                    FROM monthly_budgets b
                    INNER JOIN categories c ON c.id = b.category_id AND ${activeCat}
                    LEFT JOIN expenses e ON e.category_id = b.category_id
                        AND e.archived = 'no'
                        AND MONTH(e.expense_date) = b.month
                        AND YEAR(e.expense_date) = b.year
                    WHERE b.month = MONTH(CURRENT_DATE()) AND b.year = YEAR(CURRENT_DATE()) AND ${activeBud}
                    GROUP BY b.id, b.allocated_amount
                    HAVING rem > 0
                ) t) AS categories_with_remaining_count
        `;

        const result = await pool.query(sql);
        const data = result[0] || {};

        const allocated = num(data.total_allocated);
        const spent = Number(num(data.total_spent));
        const extraSpent = Number(num(data.extra_total_spent));
        const remaining = allocated - spent;

        const budgetCategoryCount = num(data.budget_category_count);
        const expenseRecordCount = num(data.expense_record_count);
        const extraTx = num(data.extra_transaction_count);
        const categoriesWithRemaining = num(data.categories_with_remaining_count);
        const stdTx = expenseRecordCount;

        const month = new Date().getMonth() + 1;
        const year = new Date().getFullYear();

        const cards = {
            budget: {
                id: "budget",
                label: "Budget",
                amount: allocated,
                transaction_count: budgetCategoryCount,
                transaction_label: "Budget categories (this month)"
            },
            expenses: {
                id: "expenses",
                label: "Expenses",
                amount: spent,
                transaction_count: expenseRecordCount,
                transaction_label: "Standard expense records (this month)"
            },
            remaining: {
                id: "remaining",
                label: "Remaining",
                amount: remaining,
                transaction_count: categoriesWithRemaining,
                transaction_label: "Categories with available budget"
            },
            extra: {
                id: "extra",
                label: "Extra expenses",
                amount: extraSpent,
                transaction_count: extraTx,
                transaction_label: "Extra-type transactions"
            }
        };

        const summary = {
            scope: "active",
            total_allocated: allocated,
            total_spent: spent,
            remaining_total: remaining,
            extra_total_spent: extraSpent,
            overall_usage_hike: allocated ? ((spent / allocated) * 100).toFixed(2) : "0.00",
            standard_transaction_count: stdTx,
            extra_transaction_count: extraTx,
            budget_category_count: budgetCategoryCount,
            expense_record_count: expenseRecordCount,
            categories_with_available_budget: categoriesWithRemaining
        };

        res.json({
            status: "success",
            month,
            year,
            cards,
            summary
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * GET ALL USERS DETAILS (Admin Only)
 * Returns user profile fields + expense aggregates.
 * Query: page (default 1), limit (default 10, max 100); search — matches name, email, or mobile (substring);
 * is_active (1/0 or true/false); sortBy: created_at|name|email|mobile_no|total_expenses|expense_record_count|is_active; order asc|desc.
 */
export const getUsersDetails = async (req, res) => {
    try {
        const { search = "", is_active, sortBy = "created_at", order = "desc" } = req.query;
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
        const offset = (page - 1) * limit;

        const where = [];
        const params = [];
        const searchTrim = String(search ?? "").trim();

        if (searchTrim !== "") {
            where.push("(u.name LIKE ? OR u.email LIKE ? OR COALESCE(u.mobile_no, '') LIKE ?)");
            const q = `%${searchTrim}%`;
            params.push(q, q, q);
        }

        if (is_active !== undefined) {
            const activeVal = String(is_active).toLowerCase();
            if (activeVal === "1" || activeVal === "true") {
                where.push("u.is_active = 1");
            } else if (activeVal === "0" || activeVal === "false") {
                where.push("u.is_active = 0");
            } else {
                return res.status(400).json({ message: "is_active must be 1/0 or true/false" });
            }
        }

        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const sortable = {
            created_at: "u.created_at",
            name: "u.name",
            email: "u.email",
            mobile_no: "u.mobile_no",
            total_expenses: "total_expenses",
            expense_record_count: "expense_record_count",
            is_active: "u.is_active"
        };
        const orderBy = sortable[String(sortBy)] || sortable.created_at;
        const orderDir = String(order).toLowerCase() === "asc" ? "ASC" : "DESC";

        const sql = `
            SELECT
                u.id,
                u.name,
                u.email,
                u.mobile_no,
                u.is_active,
                COALESCE(SUM(e.amount), 0) AS total_expenses,
                COUNT(e.id) AS expense_record_count
            FROM users u
            LEFT JOIN expenses e ON e.user_id = u.id AND ${activeExpenseWhere("e")}
            ${whereSql}
            GROUP BY u.id, u.name, u.email, u.mobile_no, u.is_active, u.created_at
            ORDER BY ${orderBy} ${orderDir}, u.id DESC
            LIMIT ? OFFSET ?
        `;

        const rows = await pool.query(sql, [...params, limit, offset]);
        const list = Array.isArray(rows) ? rows : [];
        const data = list.map((row) => ({
            id: num(row.id),
            name: row.name,
            email: row.email,
            mobile_no: row.mobile_no,
            is_active: Boolean(num(row.is_active)),
            activity_status: num(row.is_active) === 1 ? "active" : "inactive",
            total_expenses: Number(row.total_expenses),
            expense_record_count: num(row.expense_record_count)
        }));

        const countSql = `
            SELECT COUNT(*) AS total_users
            FROM users u
            ${whereSql}
        `;
        const countRows = await pool.query(countSql, params);
        const totalUsers = num(countRows?.[0]?.total_users);
        const columns = [
            { key: "name", label: "Name" },
            { key: "email", label: "Email" },
            { key: "mobile_no", label: "Mobile Number" },
            { key: "activity_status", label: "Activity Status" },
            { key: "total_expenses", label: "Total Expenses" },
            { key: "expense_record_count", label: "Expense Records" }
        ];

        res.json({
            status: "success",
            total_users: totalUsers,
            search: searchTrim || undefined,
            column_count: columns.length,
            columns,
            pagination: {
                page,
                limit,
                total_records: totalUsers,
                total_pages: Math.ceil(totalUsers / limit) || 0
            },
            sorting: {
                sort_by: Object.keys(sortable).includes(String(sortBy)) ? String(sortBy) : "created_at",
                order: orderDir.toLowerCase()
            },
            data
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};


/**
 * GET BUDGET DETAILS (category-wise, schema-aligned)
 * - Per monthly_budgets row: category name + description, allocated amount, spent (standard only), remaining.
 * - Active categories only (archived: GET /api/admin/archived/budgets).
 * - Query: month, year (defaults current). search — category name substring (like expense list).
 * - page (default 1), limit (default 10, max 100).
 * - sortBy: latest | budget_id | category_name | allocated_amount | total_spent | remaining_amount | usage_percentage
 *   (default latest = newest monthly_budgets row first). order: asc | desc (default desc).
 * - Use returned budget_id for PUT/DELETE /api/admin/budget/:id
 */
export const getCategoryWiseBudgets = async (req, res) => {
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
            `COALESCE(SUM(CASE WHEN e.expense_type = 'standard' AND ${activeExpenseWhere("e")} THEN e.amount ELSE 0 END), 0)`;
        const sortMap = {
            latest: "b.id",
            budget_id: "b.id",
            category_name: "c.name",
            allocated_amount: "b.allocated_amount",
            total_spent: stdSum,
            remaining_amount: `(b.allocated_amount - ${stdSum})`,
            usage_percentage: `CASE WHEN b.allocated_amount > 0 THEN ROUND((${stdSum} / b.allocated_amount) * 100, 2) ELSE 0 END`
        };
        const sortKeyRaw = String(req.query.sortBy ?? "latest").trim();
        const sortKey = Object.keys(sortMap).includes(sortKeyRaw) ? sortKeyRaw : "latest";
        const orderDir = String(req.query.order).toLowerCase() === "asc" ? "ASC" : "DESC";
        const orderBySql = `${sortMap[sortKey]} ${orderDir}, b.id DESC`;

        const whereParts = ["b.month = ?", "b.year = ?"];
        const baseParams = [month, year];
        if (search) {
            whereParts.push("c.name LIKE ?");
            baseParams.push(`%${search}%`);
        }

        const buildWhere = (withActiveFilter) => {
            const parts = [...whereParts];
            if (withActiveFilter) {
                parts.push(activeCategoryWhere("c"), activeBudgetWhere("b"));
            }
            return parts.join(" AND ");
        };

        const dataSql = (whereSql) => `
            SELECT 
                b.id AS budget_id,
                b.category_id,
                c.name AS category_name,
                c.description AS category_description,
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
                END AS usage_percentage,
                COUNT(CASE WHEN e.expense_type = 'standard' AND e.archived = 'no' THEN 1 END) AS standard_transaction_count,
                COUNT(CASE WHEN e.expense_type = 'extra' AND e.archived = 'no' THEN 1 END) AS extra_transaction_count
            FROM monthly_budgets b
            JOIN categories c ON c.id = b.category_id
            LEFT JOIN expenses e ON e.category_id = b.category_id 
                AND MONTH(e.expense_date) = b.month 
                AND YEAR(e.expense_date) = b.year
            WHERE ${whereSql}
            GROUP BY b.id, b.category_id, c.name, c.description, b.month, b.year, b.allocated_amount, b.currency, b.archived
            ORDER BY ${orderBySql}
            LIMIT ? OFFSET ?
        `;

        const whereSql = buildWhere(true);
        const countRaw = await pool.query(
            `SELECT COUNT(*) AS total_records FROM monthly_budgets b
             JOIN categories c ON c.id = b.category_id WHERE ${whereSql}`,
            baseParams
        );
        const totalRecords = num(selectRowArray(countRaw)[0]?.total_records);
        const rows = await pool.query(dataSql(whereSql), [...baseParams, limit, offset]);
        const list = selectRowArray(rows);
        const data = list.map((row) => ({
            budget_id: num(row.budget_id),
            category_id: num(row.category_id),
            category_name: row.category_name,
            category_description: row.category_description ?? null,
            month: num(row.month),
            year: num(row.year),
            allocated_amount: Number(row.allocated_amount),
            currency: row.currency,
            total_spent: Number(row.total_spent),
            remaining_amount: Number(row.remaining_amount),
            usage_percentage: Number(row.usage_percentage),
            standard_transaction_count: num(row.standard_transaction_count),
            extra_transaction_count: num(row.extra_transaction_count),
            category_archived: false,
            category_status: "active",
        }));

        const monthName = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long' });

        res.json({
            status: "success",
            scope: "active",
            month,
            year,
            month_name: monthName,
            search: search || undefined,
            pagination: {
                page,
                limit,
                total_records: totalRecords,
                total_pages: Math.ceil(totalRecords / limit) || 0
            },
            sorting: {
                sort_by: sortKey,
                order: orderDir.toLowerCase()
            },
            data
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * GET EXPENSE TABLE DATA FOR ADMIN DASHBOARD (role/type wise)
 * Query:
 * - view=users | users-inactive | admins | admins-extra (required)
 *   — users: role user + is_active; users-inactive: role user + inactive; admins: role admin; admins-extra: admin + extra
 * - page (default 1), limit (default 10, max 100)
 * - sortBy=expense_date|amount|created_at (default expense_date)
 * - order=asc|desc (default desc)
 */
export const getDashboardExpensesByView = async (req, res) => {
    try {
        const { view } = req.query;
        const allowedViews = new Set(["users", "users-inactive", "admins", "admins-extra"]);
        if (!allowedViews.has(String(view || "").trim())) {
            return res.status(400).json({
                message: "Invalid view. Use one of: users, users-inactive, admins, admins-extra"
            });
        }

        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
        const offset = (page - 1) * limit;

        const sortMap = {
            expense_date: "e.expense_date",
            amount: "e.amount",
            created_at: "e.created_at"
        };
        const sortBy = sortMap[String(req.query.sortBy)] || sortMap.expense_date;
        const orderDir = String(req.query.order).toLowerCase() === "asc" ? "ASC" : "DESC";

        const where = [];
        const params = [];

        if (view === "users") {
            where.push("u.role = ?");
            where.push("u.is_active = 1");
            params.push("user");
        } else if (view === "users-inactive") {
            where.push("u.role = ?");
            where.push("u.is_active = 0");
            params.push("user");
        } else if (view === "admins") {
            where.push("u.role = ?");
            params.push("admin");
        } else if (view === "admins-extra") {
            where.push("u.role = ?");
            where.push("e.expense_type = ?");
            params.push("admin", "extra");
        }

        const baseWhere = where.join(" AND ");
        const buildDashSql = () => {
            const liveFilter = ` AND ${activeCategoryWhere("c")} AND ${activeExpenseWhere("e")}`;
            return `
            SELECT
                e.id,
                e.title,
                e.amount,
                e.currency,
                e.expense_type,
                e.expense_date,
                e.payment_method,
                e.vendor,
                e.receipt_path,
                e.description AS expense_description,
                e.created_at,
                u.id AS user_id,
                u.name AS user_name,
                u.email AS user_email,
                u.role AS user_role,
                u.is_active AS user_is_active,
                c.id AS category_id,
                c.name AS category_name
            FROM expenses e
            JOIN users u ON u.id = e.user_id
            JOIN categories c ON c.id = e.category_id
            WHERE ${baseWhere}${liveFilter}
            ORDER BY ${sortBy} ${orderDir}, e.id DESC
            LIMIT ? OFFSET ?
        `;
        };

        const rows = await pool.query(buildDashSql(), [...params, limit, offset]);
        const countRaw = await pool.query(
            `SELECT COUNT(*) AS total_records FROM expenses e
             JOIN users u ON u.id = e.user_id
             JOIN categories c ON c.id = e.category_id
             WHERE ${baseWhere} AND ${activeCategoryWhere("c")} AND ${activeExpenseWhere("e")}`,
            params
        );
        const totalRecords = num(selectRowArray(countRaw)?.[0]?.total_records);
        const list = selectRowArray(rows);

        res.json({
            status: "success",
            scope: "active",
            view,
            pagination: {
                page,
                limit,
                total_records: totalRecords,
                total_pages: Math.ceil(totalRecords / limit)
            },
            sorting: {
                sort_by: Object.keys(sortMap).includes(String(req.query.sortBy)) ? String(req.query.sortBy) : "expense_date",
                order: orderDir.toLowerCase()
            },
            data: list.map((row) => ({
                id: num(row.id),
                title: row.title,
                amount: Number(row.amount),
                currency: row.currency,
                expense_type: row.expense_type,
                expense_date: row.expense_date,
                payment_method: row.payment_method,
                vendor: row.vendor,
                receipt_path: row.receipt_path ?? null,
                description: row.expense_description ?? null,
                notes: row.expense_description ?? null,
                created_at: row.created_at,
                user: {
                    id: num(row.user_id),
                    name: row.user_name,
                    email: row.user_email,
                    role: row.user_role,
                    is_active: Boolean(num(row.user_is_active)),
                    activity_status: num(row.user_is_active) === 1 ? "active" : "inactive"
                },
                category: {
                    id: num(row.category_id),
                    name: row.category_name,
                    archived: false,
                    category_status: "active",
                }
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * UPDATE a monthly budget row (allocated_amount / currency).
 * Path: monthly_budgets.id (budget_id from GET budget-details).
 * Rules: not for closed past months; allocated cannot fall below standard spend already recorded;
 * currency cannot change if any expense exists for that category in that month.
 */
export const updateBudget = async (req, res) => {
    const budgetId = parseInt(req.params.id, 10);
    if (!Number.isFinite(budgetId)) {
        return res.status(400).json({ message: "Invalid budget id" });
    }

    const { allocated_amount, currency } = req.body;
    if (allocated_amount === undefined || allocated_amount === null || allocated_amount === "") {
        return res.status(400).json({ message: "allocated_amount is required" });
    }
    const alloc = Number(allocated_amount);
    if (!Number.isFinite(alloc) || alloc < 0) {
        return res.status(400).json({ message: "allocated_amount must be a non-negative number" });
    }

    try {
        const preRows = await pool.query(
            `SELECT
                b.id,
                b.month,
                b.year,
                b.archived AS budget_archived,
                b.currency AS existing_currency,
                c.archived AS category_archived,
                COALESCE(SUM(CASE WHEN e.expense_type = 'standard' AND e.archived = 'no' THEN e.amount ELSE 0 END), 0) AS standard_spent,
                COUNT(e.id) AS expense_row_count
            FROM monthly_budgets b
            JOIN categories c ON c.id = b.category_id
            LEFT JOIN expenses e ON e.category_id = b.category_id
                AND MONTH(e.expense_date) = b.month
                AND YEAR(e.expense_date) = b.year
            WHERE b.id = ?
            GROUP BY b.id, b.month, b.year, b.currency, b.archived, c.archived`,
            [budgetId]
        );
        const preList = selectRowArray(preRows);
        const pre = preList[0];
        if (!pre) {
            return res.status(404).json({ message: "Budget not found" });
        }
        if (pre.category_archived === ARCHIVED_YES || pre.budget_archived === ARCHIVED_YES) {
            return res.status(400).json({
                message: "Cannot update an archived budget. Use archived history APIs.",
                category_status: "history_only",
            });
        }

        const y = num(pre.year);
        const m = num(pre.month);
        if (isPastBudgetPeriod(y, m)) {
            return res.status(400).json({ message: "Cannot update budget for a past month." });
        }

        const standardSpent = Number(num(pre.standard_spent));
        if (alloc < standardSpent) {
            return res.status(400).json({
                message:
                    "allocated_amount cannot be less than standard expenses already recorded for this category and month.",
                standard_spent: standardSpent
            });
        }

        const wantsCurrency =
            currency !== undefined && currency !== null && String(currency).trim() !== "";
        const newCur = wantsCurrency ? String(currency).trim().slice(0, 10) : null;
        const existingCur = String(pre.existing_currency || "INR").trim();
        if (wantsCurrency && newCur !== existingCur && num(pre.expense_row_count) > 0) {
            return res.status(400).json({
                message:
                    "Cannot change currency while expenses exist for this category in this month. Reconcile or move entries first."
            });
        }

        const fields = ["allocated_amount = ?"];
        const params = [alloc];
        if (wantsCurrency) {
            fields.push("currency = ?");
            params.push(newCur);
        }
        params.push(budgetId);

        const result = await pool.query(
            `UPDATE monthly_budgets SET ${fields.join(", ")} WHERE id = ? AND archived = ?`,
            [...params, ARCHIVED_NO]
        );
        const affected = typeof result?.affectedRows === "number" ? result.affectedRows : 0;
        if (affected === 0) {
            return res.status(404).json({ message: "Budget not found" });
        }

        const rows = await pool.query(
            `SELECT 
                b.id AS budget_id,
                b.category_id,
                c.name AS category_name,
                b.month,
                b.year,
                b.allocated_amount,
                b.currency,
                COALESCE(SUM(CASE WHEN e.expense_type = 'standard' AND e.archived = 'no' THEN e.amount ELSE 0 END), 0) AS total_spent,
                (b.allocated_amount - COALESCE(SUM(CASE WHEN e.expense_type = 'standard' AND e.archived = 'no' THEN e.amount ELSE 0 END), 0)) AS remaining_amount
            FROM monthly_budgets b
            JOIN categories c ON c.id = b.category_id
            LEFT JOIN expenses e ON e.category_id = b.category_id 
                AND MONTH(e.expense_date) = b.month 
                AND YEAR(e.expense_date) = b.year
            WHERE b.id = ?
            GROUP BY b.id, b.category_id, c.name, b.month, b.year, b.allocated_amount, b.currency`,
            [budgetId]
        );
        const rowArr = selectRowArray(rows);
        const row = rowArr[0];
        if (!row) {
            return res.json({
                status: "success",
                message: "Budget updated successfully",
                data: { budget_id: budgetId }
            });
        }

        res.json({
            status: "success",
            message: "Budget updated successfully",
            data: {
                budget_id: num(row.budget_id),
                category_id: num(row.category_id),
                category_name: row.category_name,
                category_archived: false,
                category_status: "active",
                month: num(row.month),
                year: num(row.year),
                allocated_amount: Number(row.allocated_amount),
                currency: row.currency,
                total_spent: Number(row.total_spent),
                remaining_amount: Number(row.remaining_amount)
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * ARCHIVE a monthly budget row (monthly_budgets.id → archived=yes).
 * If no active budgets remain for that category and no active expenses, archives the whole category (cascade).
 * Rules: not for closed past months; blocked if any active expense exists for that category in that month.
 */
export const deleteBudget = async (req, res) => {
    const budgetId = parseInt(req.params.id, 10);
    if (!Number.isFinite(budgetId)) {
        return res.status(400).json({ message: "Invalid budget id" });
    }

    try {
        const existing = selectRowArray(
            await pool.query(
                `SELECT
                b.id,
                b.category_id,
                b.month,
                b.year,
                b.archived AS budget_archived,
                SUM(CASE WHEN e.archived = 'no' THEN 1 ELSE 0 END) AS expense_row_count
            FROM monthly_budgets b
            LEFT JOIN expenses e ON e.category_id = b.category_id
                AND MONTH(e.expense_date) = b.month
                AND YEAR(e.expense_date) = b.year
            WHERE b.id = ?
            GROUP BY b.id, b.category_id, b.month, b.year, b.archived`,
                [budgetId]
            )
        );
        if (existing.length === 0) {
            return res.status(404).json({ message: "Budget not found" });
        }

        const meta = existing[0];
        if (meta.budget_archived === ARCHIVED_YES) {
            return res.status(400).json({ message: "Budget is already archived." });
        }
        const y = num(meta.year);
        const m = num(meta.month);
        if (isPastBudgetPeriod(y, m)) {
            return res.status(400).json({ message: "Cannot delete budget for a past month." });
        }
        if (num(meta.expense_row_count) > 0) {
            return res.status(400).json({
                message:
                    "Cannot delete this budget while expenses exist for this category in this month. Remove or reassign those expenses first.",
                expense_count: num(meta.expense_row_count)
            });
        }

        await pool.query(
            `UPDATE monthly_budgets SET archived = ? WHERE id = ? AND archived = ?`,
            [ARCHIVED_YES, budgetId, ARCHIVED_NO]
        );

        const categoryId = num(meta.category_id);
        let categoryArchived = false;
        let categoryRetainedReason = null;

        const remainingBudgets = selectRowArray(
            await pool.query(
                `SELECT COUNT(*) AS cnt FROM monthly_budgets WHERE category_id = ? AND archived = ?`,
                [categoryId, ARCHIVED_NO]
            )
        );
        const budgetCountLeft = num(remainingBudgets[0]?.cnt);

        if (budgetCountLeft === 0) {
            const linkedExpenses = selectRowArray(
                await pool.query(
                    `SELECT id FROM expenses WHERE category_id = ? AND archived = ? LIMIT 1`,
                    [categoryId, ARCHIVED_NO]
                )
            );
            if (linkedExpenses.length > 0) {
                categoryRetainedReason =
                    "Category kept active: non-archived expenses still exist for this category.";
            } else {
                const conn = await pool.getConnection();
                try {
                    await conn.beginTransaction();
                    const actorId = Number(req.user?.id);
                    await archiveCategoryCascade(
                        conn,
                        categoryId,
                        Number.isFinite(actorId) ? actorId : null
                    );
                    await conn.commit();
                    categoryArchived = true;
                } catch (e) {
                    await conn.rollback();
                    if (isMissingArchivedColumnError(e)) {
                        categoryRetainedReason =
                            "Category not archived: run Schema.sql archived upgrade. Budget was still archived.";
                    } else {
                        throw e;
                    }
                } finally {
                    conn.release();
                }
            }
        }

        const payload = {
            status: "success",
            message: categoryArchived
                ? "Budget archived; category archived successfully"
                : "Budget archived successfully",
            archived: {
                budget_id: budgetId,
                category_id: categoryId,
                month: num(meta.month),
                year: num(meta.year),
            },
            category_archived: categoryArchived,
        };
        if (categoryRetainedReason) {
            payload.category_retained_reason = categoryRetainedReason;
        }
        res.json(payload);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};