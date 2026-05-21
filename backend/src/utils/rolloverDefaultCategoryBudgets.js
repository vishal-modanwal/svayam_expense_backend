import { selectRowArray } from "./mariaRows.js";
import { ARCHIVED_NO, ARCHIVED_YES } from "./categoryArchive.js";
import { DEFAULT_CATEGORY_NAMES } from "../constants/defaultCategories.js";

const num = (v) => (typeof v === "bigint" ? Number(v) : Number(v || 0));

export function previousMonthYear(month, year) {
    const m = Number(month);
    const y = Number(year);
    if (m === 1) return { month: 12, year: y - 1 };
    return { month: m - 1, year: y };
}

export function resolveDefaultBudgetAmount() {
    const raw = process.env.DEFAULT_CATEGORY_BUDGET_AMOUNT ?? "5000";
    const n = parseFloat(String(raw));
    return Number.isFinite(n) && n >= 0 ? n : 5000;
}

/**
 * Ensure a default category exists (active). Restores archived row or inserts new.
 * @returns {{ categoryId: number, action: "existing" | "reactivated" | "created" }}
 */
async function ensureDefaultCategory(conn, name) {
    const active = selectRowArray(
        await conn.query(
            `SELECT id FROM categories WHERE name = ? AND archived = ? LIMIT 1`,
            [name, ARCHIVED_NO]
        )
    );
    if (active.length) {
        return { categoryId: num(active[0].id), action: "existing" };
    }

    const archived = selectRowArray(
        await conn.query(
            `SELECT id FROM categories WHERE name = ? AND archived = ? ORDER BY id DESC LIMIT 1`,
            [name, ARCHIVED_YES]
        )
    );
    if (archived.length) {
        const categoryId = num(archived[0].id);
        await conn.query(`UPDATE categories SET archived = ? WHERE id = ?`, [
            ARCHIVED_NO,
            categoryId,
        ]);
        return { categoryId, action: "reactivated" };
    }

    const ins = await conn.query(
        `INSERT INTO categories (name, description, archived) VALUES (?, NULL, ?)`,
        [name, ARCHIVED_NO]
    );
    return { categoryId: num(ins.insertId), action: "created" };
}

/**
 * Create monthly_budgets for fixed default categories if missing for target month/year.
 * Amount: previous month's allocated_amount, else DEFAULT_CATEGORY_BUDGET_AMOUNT (5000).
 * Idempotent: never updates an existing row for that period.
 *
 * @param {import("mariadb").PoolConnection} conn
 * @param {{ month?: number, year?: number }} [options]
 */
export async function rolloverDefaultCategoryBudgets(conn, options = {}) {
    const now = new Date();
    const month = options.month ?? now.getMonth() + 1;
    const year = options.year ?? now.getFullYear();
    const defaultAmount = resolveDefaultBudgetAmount();
    const { month: prevMonth, year: prevYear } = previousMonthYear(month, year);

    const result = {
        month,
        year,
        default_amount: defaultAmount,
        previous_period: { month: prevMonth, year: prevYear },
        categories_ensured: [],
        created: [],
        skipped: [],
        errors: [],
    };

    for (const name of DEFAULT_CATEGORY_NAMES) {
        try {
            const { categoryId, action: categoryAction } = await ensureDefaultCategory(
                conn,
                name
            );
            if (categoryAction !== "existing") {
                result.categories_ensured.push({
                    category_name: name,
                    category_id: categoryId,
                    action: categoryAction,
                });
            }

            const existing = selectRowArray(
                await conn.query(
                    `SELECT id FROM monthly_budgets
                     WHERE category_id = ? AND month = ? AND year = ? AND archived = ?
                     LIMIT 1`,
                    [categoryId, month, year, ARCHIVED_NO]
                )
            );
            if (existing.length) {
                result.skipped.push({
                    category_id: categoryId,
                    category_name: name,
                    budget_id: num(existing[0].id),
                    reason: "budget_already_exists",
                    category_action: categoryAction,
                });
                continue;
            }

            const prevRows = selectRowArray(
                await conn.query(
                    `SELECT allocated_amount, currency FROM monthly_budgets
                     WHERE category_id = ? AND month = ? AND year = ? AND archived = ?
                     LIMIT 1`,
                    [categoryId, prevMonth, prevYear, ARCHIVED_NO]
                )
            );

            const fromPrevious = prevRows.length > 0;
            const allocated_amount = fromPrevious
                ? parseFloat(String(prevRows[0].allocated_amount ?? 0)) || defaultAmount
                : defaultAmount;
            const currency = fromPrevious
                ? String(prevRows[0].currency || "INR").trim() || "INR"
                : "INR";

            const ins = await conn.query(
                `INSERT INTO monthly_budgets
                 (category_id, month, year, allocated_amount, currency, created_by, archived)
                 VALUES (?, ?, ?, ?, ?, NULL, ?)`,
                [categoryId, month, year, allocated_amount, currency, ARCHIVED_NO]
            );

            result.created.push({
                category_id: categoryId,
                category_name: name,
                budget_id: num(ins.insertId),
                allocated_amount,
                currency,
                source: fromPrevious ? "previous_month" : "default",
                category_action: categoryAction,
            });
        } catch (err) {
            if (err?.errno === 1062 || err?.code === "ER_DUP_ENTRY") {
                result.skipped.push({
                    category_name: name,
                    reason: "duplicate_race",
                });
                continue;
            }
            result.errors.push({
                category_name: name,
                code: "insert_failed",
                message: String(err?.message ?? err),
            });
        }
    }

    return result;
}
