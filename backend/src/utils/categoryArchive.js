/** SQL fragments for active vs archived categories (`categories.deleted_at`). */

export const activeCategoryWhere = (alias = "c") => `${alias}.deleted_at IS NULL`;

export const archivedCategoryWhere = (alias = "c") => `${alias}.deleted_at IS NOT NULL`;

/** Expense row belongs to an active category (for subqueries without category join). */
export const activeExpenseCategoryExists = (expenseAlias = "e") =>
    `EXISTS (SELECT 1 FROM categories c WHERE c.id = ${expenseAlias}.category_id AND c.deleted_at IS NULL)`;

export const archivedExpenseCategoryExists = (expenseAlias = "e") =>
    `EXISTS (SELECT 1 FROM categories c WHERE c.id = ${expenseAlias}.category_id AND c.deleted_at IS NOT NULL)`;
