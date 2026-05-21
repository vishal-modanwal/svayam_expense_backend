/**
 * One-time / anytime: ensure 4 default categories + current month budgets @ 5000.
 * Usage: node scripts/seed-default-categories-budgets.js
 * Future months: cron on 1st (copy previous month else DEFAULT_CATEGORY_BUDGET_AMOUNT).
 */
import { pool } from '../src/db/index.js';
import { DEFAULT_CATEGORY_NAMES } from '../src/constants/defaultCategories.js';
import { ARCHIVED_NO } from '../src/utils/categoryArchive.js';
import { resolveDefaultBudgetAmount } from '../src/utils/rolloverDefaultCategoryBudgets.js';

const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));

async function main() {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const amount = resolveDefaultBudgetAmount();

    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const categoryResults = [];
        for (const name of DEFAULT_CATEGORY_NAMES) {
            const active = await conn.query(
                `SELECT id FROM categories WHERE name = ? AND archived = ? LIMIT 1`,
                [name, ARCHIVED_NO]
            );
            const activeRows = Array.isArray(active) ? active : [];
            let categoryId;
            let action = 'existing';

            if (activeRows.length) {
                categoryId = num(activeRows[0].id);
            } else {
                const ins = await conn.query(
                    `INSERT INTO categories (name, description, archived) VALUES (?, NULL, ?)`,
                    [name, ARCHIVED_NO]
                );
                const meta = Array.isArray(ins) ? ins[0] : ins;
                categoryId = num(meta.insertId);
                action = 'created';
            }

            const existingBudget = await conn.query(
                `SELECT id FROM monthly_budgets
                 WHERE category_id = ? AND month = ? AND year = ? AND archived = ?
                 LIMIT 1`,
                [categoryId, month, year, ARCHIVED_NO]
            );
            const budgetRows = Array.isArray(existingBudget) ? existingBudget : [];
            let budgetAction = 'skipped_exists';

            if (!budgetRows.length) {
                await conn.query(
                    `INSERT INTO monthly_budgets
                     (category_id, month, year, allocated_amount, currency, created_by, archived)
                     VALUES (?, ?, ?, ?, 'INR', NULL, ?)`,
                    [categoryId, month, year, amount, ARCHIVED_NO]
                );
                budgetAction = 'created_5000';
            }

            categoryResults.push({
                name,
                category_id: categoryId,
                category_action: action,
                budget_action: budgetAction,
            });
        }

        await conn.commit();
        console.log(
            JSON.stringify(
                {
                    ok: true,
                    period: { month, year },
                    default_amount: amount,
                    categories: categoryResults,
                    note: 'Later months handled by cron (copy previous else default).',
                },
                null,
                2
            )
        );
    } catch (err) {
        if (conn) await conn.rollback();
        console.error('Seed failed:', err.message);
        process.exitCode = 1;
    } finally {
        if (conn) conn.release();
        await pool.end();
    }
}

main();
