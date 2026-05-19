/** SQL fragments for active vs archived rows (`archived` ENUM yes/no). */

export const ARCHIVED_NO = "no";
export const ARCHIVED_YES = "yes";

export const activeCategoryWhere = (alias = "c") => `${alias}.archived = '${ARCHIVED_NO}'`;
export const archivedCategoryWhere = (alias = "c") => `${alias}.archived = '${ARCHIVED_YES}'`;

export const activeBudgetWhere = (alias = "b") => `${alias}.archived = '${ARCHIVED_NO}'`;
export const archivedBudgetWhere = (alias = "b") => `${alias}.archived = '${ARCHIVED_YES}'`;

export const activeExpenseWhere = (alias = "e") => `${alias}.archived = '${ARCHIVED_NO}'`;
export const archivedExpenseWhere = (alias = "e") => `${alias}.archived = '${ARCHIVED_YES}'`;

/** Live expense counts/sums: row and category must be active. */
export const activeExpenseCategoryExists = (expenseAlias = "e") =>
    `EXISTS (SELECT 1 FROM categories c WHERE c.id = ${expenseAlias}.category_id AND c.archived = '${ARCHIVED_NO}') AND ${expenseAlias}.archived = '${ARCHIVED_NO}'`;

export const archivedExpenseCategoryExists = (expenseAlias = "e") =>
    `${expenseAlias}.archived = '${ARCHIVED_YES}'`;

/** JOIN … ON … AND fragments for list queries */
export const activeBudgetJoinCategory = (b = "b", c = "c") =>
    `JOIN categories ${c} ON ${c}.id = ${b}.category_id AND ${activeCategoryWhere(c)} AND ${activeBudgetWhere(b)}`;

export const activeExpenseJoinCategory = (e = "e", c = "c") =>
    `JOIN categories ${c} ON ${c}.id = ${e}.category_id AND ${activeCategoryWhere(c)} AND ${activeExpenseWhere(e)}`;
