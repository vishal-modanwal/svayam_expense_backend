import { pool } from '../db/index.js';
import { sendBudget90PercentAlert } from './emailService.js';

const THRESHOLD_PCT = 90;

/** Normalize mariadb `pool.query` / `connection.query` row array shape */
const asRows = (raw) => {
    if (!raw) return [];
    if (Array.isArray(raw) && raw.length && Array.isArray(raw[0])) return raw[0];
    return Array.isArray(raw) ? raw : [];
};

const monthYearFromDate = (d) => {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return { month: null, year: null };
    return { month: dt.getMonth() + 1, year: dt.getFullYear() };
};

const bucketKey = (categoryId, month, year) => `${categoryId}|${month}|${year}`;

/**
 * Standard-spend contribution of one expense row toward a (category, month, year) budget bucket.
 */
const contributionToBucket = (amount, expenseType, categoryId, expenseDate, bucket) => {
    if (String(expenseType).toLowerCase() !== 'standard') return 0;
    const { month, year } = monthYearFromDate(expenseDate);
    if (month == null || Number(categoryId) !== Number(bucket.categoryId)) return 0;
    if (month !== bucket.month || year !== bucket.year) return 0;
    return Number(amount) || 0;
};

/**
 * After a standard expense changes totals, if usage crosses from below 90% to at/above 90%, email all admins.
 * Fire-and-forget from HTTP handlers; errors are logged only.
 */
export async function notifyAdminsIfStandardBudgetCrossed90(poolConn, params) {
    const {
        categoryId,
        expenseDate,
        previousStandardSpentInBucket,
        newStandardSpentInBucket,
        allocatedAmount,
        currency
    } = params;

    const alloc = Number(allocatedAmount);
    const prev = Number(previousStandardSpentInBucket);
    const next = Number(newStandardSpentInBucket);

    if (!Number.isFinite(alloc) || alloc <= 0) return;
    if (!Number.isFinite(prev) || !Number.isFinite(next)) return;

    const oldPct = (prev / alloc) * 100;
    const newPct = (next / alloc) * 100;
    if (oldPct >= THRESHOLD_PCT || newPct < THRESHOLD_PCT) return;

    const { month, year } = monthYearFromDate(expenseDate);
    if (month == null) return;

    const catRaw = await poolConn.query('SELECT name FROM categories WHERE id = ?', [categoryId]);
    const catRows = asRows(catRaw);
    const categoryName = catRows[0]?.name ?? 'Category';

    const adminRaw = await poolConn.query(
        `SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND email != ''`
    );
    const adminRows = asRows(adminRaw);
    const emails = [...new Set(adminRows.map((r) => String(r.email).trim()).filter(Boolean))];
    if (!emails.length) {
        console.warn('Budget 90% alert: no admin emails found.');
        return;
    }

    const periodLabel = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const remaining = Math.max(alloc - next, 0);

    await sendBudget90PercentAlert(emails, {
        categoryName,
        periodLabel,
        month,
        year,
        allocated: alloc,
        spent: next,
        remaining,
        usagePercent: Math.min(100, Math.round(newPct * 100) / 100),
        currency: currency || 'INR'
    });
}

/**
 * For update: recompute affected budget buckets and notify on 90% crossing.
 * @param {object} nextFields — parsed `{ amount, category_id, expense_type }` after update.
 */
export async function notifyAfterExpenseUpdateIfNeeded(existingRow, nextFields, poolConn) {
    const oldAmount = Number(existingRow.amount);
    const oldCat = Number(existingRow.category_id);
    const oldType = String(existingRow.expense_type || 'standard');
    const expenseDate = existingRow.expense_date;

    const newAmount = Number(nextFields.amount);
    const newCat = Number(nextFields.category_id);
    const newType = String(nextFields.expense_type || 'standard');

    if (!Number.isFinite(oldAmount) || !Number.isFinite(newAmount)) return;
    if (!Number.isFinite(oldCat) || !Number.isFinite(newCat)) return;

    const buckets = new Map();
    const addBucket = (categoryId, expenseDate) => {
        const { month, year } = monthYearFromDate(expenseDate);
        if (month == null) return;
        const key = bucketKey(categoryId, month, year);
        if (!buckets.has(key)) buckets.set(key, { categoryId, month, year });
    };

    addBucket(oldCat, expenseDate);
    addBucket(newCat, expenseDate);

    for (const bucket of buckets.values()) {
        const sumRaw = await poolConn.query(
            `SELECT COALESCE(SUM(amount), 0) AS total_spent
             FROM expenses
             WHERE category_id = ? AND expense_type = 'standard'
               AND MONTH(expense_date) = ? AND YEAR(expense_date) = ?`,
            [bucket.categoryId, bucket.month, bucket.year]
        );
        const sumRows = asRows(sumRaw);
        const newSpent = Number(sumRows[0]?.total_spent ?? 0);

        const oldContrib = contributionToBucket(oldAmount, oldType, oldCat, expenseDate, bucket);
        const newContrib = contributionToBucket(newAmount, newType, newCat, expenseDate, bucket);
        const oldSpent = newSpent - newContrib + oldContrib;

        const budRaw = await poolConn.query(
            `SELECT allocated_amount, currency FROM monthly_budgets
             WHERE category_id = ? AND month = ? AND year = ?`,
            [bucket.categoryId, bucket.month, bucket.year]
        );
        const budRows = asRows(budRaw);
        const bud = budRows[0];
        if (!bud) continue;

        const allocatedAmount = Number(bud.allocated_amount);
        const currency = bud.currency;

        await notifyAdminsIfStandardBudgetCrossed90(poolConn, {
            categoryId: bucket.categoryId,
            expenseDate,
            previousStandardSpentInBucket: oldSpent,
            newStandardSpentInBucket: newSpent,
            allocatedAmount,
            currency
        });
    }
}

/** Non-blocking wrapper */
export function fireBudget90Alert(poolConn, params) {
    notifyAdminsIfStandardBudgetCrossed90(poolConn, params).catch((err) =>
        console.error('Budget 90% email notify failed:', err.message)
    );
}

export function fireBudget90AlertAfterUpdate(existingRow, nextFields) {
    notifyAfterExpenseUpdateIfNeeded(existingRow, nextFields, pool).catch((err) =>
        console.error('Budget 90% email notify (update) failed:', err.message)
    );
}
