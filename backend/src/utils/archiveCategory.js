import { ARCHIVED_YES, ARCHIVED_NO } from "./categoryArchive.js";
import { softArchiveExpensesByCategory } from "./expenseArchive.js";

/**
 * Mark category and all linked budgets/expenses as archived (history only).
 * @param {import("mariadb").PoolConnection} conn
 * @param {number} categoryId
 * @param {number|null} [deletedByUserId] — admin who triggered archive (expense audit)
 */
export async function archiveCategoryCascade(conn, categoryId, deletedByUserId = null) {
    await conn.query(
        `UPDATE categories SET archived = ? WHERE id = ? AND archived = ?`,
        [ARCHIVED_YES, categoryId, ARCHIVED_NO]
    );
    await conn.query(
        `UPDATE monthly_budgets SET archived = ? WHERE category_id = ? AND archived = ?`,
        [ARCHIVED_YES, categoryId, ARCHIVED_NO]
    );
    await softArchiveExpensesByCategory(conn, categoryId, deletedByUserId);
}

export function isArchivedYes(value) {
    return String(value).toLowerCase() === ARCHIVED_YES;
}

/**
 * Permanently remove category and all linked expenses; monthly_budgets removed via FK CASCADE.
 * @returns {{ expenses_deleted: number, budgets_deleted: number }}
 */
export async function hardDeleteCategoryCascade(conn, categoryId) {
    const expenseResult = await conn.query(
        "DELETE FROM expenses WHERE category_id = ?",
        [categoryId]
    );
    const expensesDeleted =
        typeof expenseResult?.affectedRows === "number"
            ? expenseResult.affectedRows
            : 0;

    const budgetResult = await conn.query(
        "DELETE FROM monthly_budgets WHERE category_id = ?",
        [categoryId]
    );
    const budgetsDeleted =
        typeof budgetResult?.affectedRows === "number"
            ? budgetResult.affectedRows
            : 0;

    const catResult = await conn.query("DELETE FROM categories WHERE id = ?", [
        categoryId,
    ]);
    const categoriesDeleted =
        typeof catResult?.affectedRows === "number" ? catResult.affectedRows : 0;

    if (categoriesDeleted === 0) {
        const err = new Error("Category not found");
        err.statusCode = 404;
        throw err;
    }

    return { expenses_deleted: expensesDeleted, budgets_deleted: budgetsDeleted };
}
