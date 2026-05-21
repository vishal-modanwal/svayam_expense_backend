import { selectRowArray } from "./mariaRows.js";
import { ARCHIVED_NO } from "./categoryArchive.js";
import { createNotification } from "./notifications.js";

export const USER_BUDGET_EXCEEDED_TYPE = "user_budget_exceeded";

export const monthYearFromExpenseDate = (d) => {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return { month: null, year: null };
    return { month: dt.getMonth() + 1, year: dt.getFullYear() };
};

export async function fetchUserMonthlyBudgetRow(conn, userId, month, year) {
    const rows = selectRowArray(
        await conn.query(
            `SELECT id, user_id, month, year, allocated_amount, currency,
                    exceeded_at, exceeded_notified_at, created_by, created_at, updated_at
             FROM user_monthly_budgets
             WHERE user_id = ? AND month = ? AND year = ?`,
            [userId, month, year]
        )
    );
    return rows[0] ?? null;
}

export async function sumUserStandardSpent(conn, userId, month, year, excludeExpenseId = null) {
    let sql = `SELECT COALESCE(SUM(amount), 0) AS total_spent
               FROM expenses
               WHERE user_id = ? AND expense_type = 'standard' AND archived = ?
                 AND MONTH(expense_date) = ? AND YEAR(expense_date) = ?`;
    const params = [userId, ARCHIVED_NO, month, year];
    if (excludeExpenseId != null) {
        sql += " AND id <> ?";
        params.push(excludeExpenseId);
    }
    const rows = selectRowArray(await conn.query(sql, params));
    return parseFloat(String(rows[0]?.total_spent ?? 0)) || 0;
}

const parseAggNum = (v) => parseFloat(String(v ?? 0)) || 0;
const parseAggCount = (v) =>
    typeof v === "bigint" ? Number(v) : Number(v ?? 0);

/**
 * Admin summary: only users with a user_monthly_budgets row for the period.
 * Spend = their standard non-archived expenses; effective remaining = sum of max(0, cap − spend).
 */
export async function fetchUserBudgetsPeriodSummary(conn, month, year) {
    const rows = selectRowArray(
        await conn.query(
            `SELECT
                COALESCE(SUM(b.allocated_amount), 0) AS total_allocated,
                COUNT(*) AS users_with_budget_count,
                COUNT(CASE WHEN COALESCE(e.spent, 0) > b.allocated_amount THEN 1 END) AS users_over_budget_count,
                COUNT(CASE WHEN b.exceeded_at IS NOT NULL THEN 1 END) AS users_exceeded_flag_count,
                COALESCE(SUM(COALESCE(e.spent, 0)), 0) AS total_spent,
                COALESCE(SUM(GREATEST(0, b.allocated_amount - COALESCE(e.spent, 0))), 0) AS effective_remaining_total,
                COALESCE(SUM(GREATEST(0, COALESCE(e.spent, 0) - b.allocated_amount)), 0) AS over_budget_total,
                COALESCE(SUM(b.allocated_amount - COALESCE(e.spent, 0)), 0) AS raw_remaining_total,
                COALESCE(SUM(COALESCE(e.expense_record_count, 0)), 0) AS expense_record_count
             FROM user_monthly_budgets b
             LEFT JOIN (
                SELECT user_id,
                       COALESCE(SUM(amount), 0) AS spent,
                       COUNT(*) AS expense_record_count
                FROM expenses
                WHERE expense_type = 'standard' AND archived = ?
                  AND MONTH(expense_date) = ? AND YEAR(expense_date) = ?
                GROUP BY user_id
             ) e ON e.user_id = b.user_id
             WHERE b.month = ? AND b.year = ?`,
            [ARCHIVED_NO, month, year, month, year]
        )
    );
    const r = rows[0] ?? {};
    const totalAllocated = parseAggNum(r.total_allocated);
    const totalSpent = parseAggNum(r.total_spent);
    return {
        total_allocated: totalAllocated,
        total_spent: totalSpent,
        effective_remaining_total: parseAggNum(r.effective_remaining_total),
        over_budget_total: parseAggNum(r.over_budget_total),
        raw_remaining_total: parseAggNum(r.raw_remaining_total),
        users_with_budget_count: parseAggCount(r.users_with_budget_count),
        users_over_budget_count: parseAggCount(r.users_over_budget_count),
        users_exceeded_flag_count: parseAggCount(r.users_exceeded_flag_count),
        expense_record_count: parseAggCount(r.expense_record_count),
        overall_usage_percent: totalAllocated
            ? ((totalSpent / totalAllocated) * 100).toFixed(2)
            : "0.00",
    };
}

export function buildUserBudgetPayload(budgetRow, spent) {
    if (!budgetRow) {
        return {
            budget_mode: "category_only",
            user_monthly_budget: null,
        };
    }
    const allocated = parseFloat(String(budgetRow.allocated_amount ?? 0));
    const remaining = allocated - spent;
    return {
        budget_mode: "user",
        user_monthly_budget: {
            id: typeof budgetRow.id === "bigint" ? Number(budgetRow.id) : budgetRow.id,
            user_id: typeof budgetRow.user_id === "bigint" ? Number(budgetRow.user_id) : budgetRow.user_id,
            month: budgetRow.month,
            year: budgetRow.year,
            allocated_amount: allocated,
            currency: budgetRow.currency || "INR",
            spent,
            remaining,
            exceeded: spent > allocated,
            exceeded_at: budgetRow.exceeded_at ?? null,
        },
    };
}

async function notifyAdminsUserBudgetExceeded(conn, { subjectUserId, month, year, allocated, spent, currency }) {
    const userRows = selectRowArray(
        await conn.query("SELECT name, email FROM users WHERE id = ?", [subjectUserId])
    );
    const subjectName = userRows[0]?.name || userRows[0]?.email || `User #${subjectUserId}`;
    const periodLabel = new Date(year, month - 1, 1).toLocaleString("en-US", {
        month: "long",
        year: "numeric",
    });
    const overBy = (spent - allocated).toFixed(2);
    const message = `${subjectName}'s ${periodLabel} budget exceeded (allocated ₹${allocated} ${currency || "INR"}, spent ₹${spent.toFixed(2)}, over by ₹${overBy}).`;

    const adminRows = selectRowArray(
        await conn.query(
            `SELECT id FROM users WHERE role = 'admin' AND is_active = 1`
        )
    );
    for (const admin of adminRows) {
        const adminId = typeof admin.id === "bigint" ? Number(admin.id) : admin.id;
        await createNotification(adminId, null, USER_BUDGET_EXCEEDED_TYPE, message, conn);
    }
}

/**
 * Recompute spent vs cap; set/clear exceed flags; notify admins once per exceed cycle.
 * @returns {Promise<object>} buildUserBudgetPayload result
 */
export async function syncUserBudgetAfterExpenseChange(conn, { userId, expenseDate, expenseType }) {
    if (String(expenseType || "standard").toLowerCase() !== "standard") {
        return buildUserBudgetPayload(null, 0);
    }

    const { month, year } = monthYearFromExpenseDate(expenseDate);
    if (month == null) return buildUserBudgetPayload(null, 0);

    const budgetRow = await fetchUserMonthlyBudgetRow(conn, userId, month, year);
    if (!budgetRow) return buildUserBudgetPayload(null, 0);

    const spent = await sumUserStandardSpent(conn, userId, month, year);
    const allocated = parseFloat(String(budgetRow.allocated_amount ?? 0));
    const budgetId = typeof budgetRow.id === "bigint" ? Number(budgetRow.id) : budgetRow.id;

    if (spent > allocated) {
        if (!budgetRow.exceeded_at) {
            await conn.query(
                `UPDATE user_monthly_budgets SET exceeded_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [budgetId]
            );
            budgetRow.exceeded_at = new Date();
        }
        if (!budgetRow.exceeded_notified_at) {
            await notifyAdminsUserBudgetExceeded(conn, {
                subjectUserId: userId,
                month,
                year,
                allocated,
                spent,
                currency: budgetRow.currency,
            });
            await conn.query(
                `UPDATE user_monthly_budgets SET exceeded_notified_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [budgetId]
            );
        }
    } else {
        await conn.query(
            `UPDATE user_monthly_budgets
             SET exceeded_at = NULL, exceeded_notified_at = NULL
             WHERE id = ?`,
            [budgetId]
        );
        budgetRow.exceeded_at = null;
        budgetRow.exceeded_notified_at = null;
    }

    return buildUserBudgetPayload(budgetRow, spent);
}

/** Non-blocking after HTTP commit */
export function fireUserBudgetSync(poolConn, params) {
    const conn = poolConn;
    (async () => {
        const c = await conn.getConnection();
        try {
            await c.beginTransaction();
            await syncUserBudgetAfterExpenseChange(c, params);
            await c.commit();
        } catch (err) {
            await c.rollback();
            console.error("User monthly budget sync failed:", err.message);
        } finally {
            c.release();
        }
    })();
}

export function isClearUserBudgetsOnRolloverEnabled() {
    const v = String(process.env.CRON_CLEAR_USER_BUDGETS ?? "true")
        .trim()
        .toLowerCase();
    return v !== "false" && v !== "0" && v !== "no";
}

/**
 * Remove all per-user caps for a calendar month so every user is in category_only mode.
 * Does not touch other months. Idempotent.
 */
export async function clearUserMonthlyBudgetsForPeriod(conn, options = {}) {
    const now = new Date();
    const month = options.month ?? now.getMonth() + 1;
    const year = options.year ?? now.getFullYear();

    const result = await conn.query(
        `DELETE FROM user_monthly_budgets WHERE month = ? AND year = ?`,
        [month, year]
    );
    const removed =
        typeof result?.affectedRows === "number"
            ? result.affectedRows
            : Number(result?.affectedRows ?? 0);

    return {
        month,
        year,
        user_budget_rows_removed: removed,
        budget_mode: "not_assigned",
        message:
            "All user monthly caps cleared for this period; expenses use category budgets only.",
    };
}

export function isMissingUserBudgetTableError(err) {
    const msg = String(err?.message ?? "");
    return (
        (err?.errno === 1146 || err?.code === "ER_NO_SUCH_TABLE") &&
        /user_monthly_budgets/i.test(msg)
    );
}
