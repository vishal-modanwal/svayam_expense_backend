/**
 * Table column metadata for frontend grids (labels + keys + DB mapping).
 * Data rows come from existing list APIs; these endpoints only describe columns.
 */

const respond = (res, table, tableLabel, columns) => {
    res.json({
        status: "success",
        table,
        table_label: tableLabel,
        column_count: columns.length,
        columns
    });
};

/** Admin user list — columns align with `users` table (Schema.sql). */
export const getUserTableMeta = (_req, res) => {
    respond(res, "users", "Users", [
        { key: "id", label: "ID", db_column: "users.id" },
        { key: "name", label: "Name", db_column: "users.name" },
        { key: "email", label: "Email", db_column: "users.email" },
        { key: "mobile_no", label: "Mobile No.", db_column: "users.mobile_no" },
        { key: "is_active", label: "Is Active", db_column: "users.is_active" },
        { key: "created_at", label: "Created At", db_column: "users.created_at" }
    ]);
};

/**
 * Expense list rows (GET /api/expense/my-expenses | /all | /search).
 * Keys match SELECT e.*, user_name, category_name — use `category_name` / `user_name` for display.
 */
export const getExpenseTableMeta = (_req, res) => {
    respond(res, "expenses", "Expenses", [
        { key: "id", label: "ID", db_column: "expenses.id" },
        { key: "title", label: "Title", db_column: "expenses.title" },
        { key: "category_name", label: "Category", db_column: "categories.name" },
        { key: "user_name", label: "User", db_column: "users.name" },
        { key: "amount", label: "Amount", db_column: "expenses.amount" },
        { key: "currency", label: "Currency", db_column: "expenses.currency" },
        { key: "payment_method", label: "Payment Method", db_column: "expenses.payment_method" },
        { key: "vendor", label: "Vendor", db_column: "expenses.vendor" },
        { key: "receipt_path", label: "Receipt", db_column: "expenses.receipt_path" },
        { key: "expense_type", label: "Type", db_column: "expenses.expense_type" },
        { key: "expense_date", label: "Expense Date", db_column: "expenses.expense_date" },
        { key: "description", label: "Description", db_column: "expenses.description" },
        { key: "created_at", label: "Created At", db_column: "expenses.created_at" }
    ]);
};

/** Budget breakdown rows (GET /api/admin/budget-details) — keys match that API. */
export const getBudgetTableMeta = (_req, res) => {
    respond(res, "budgets", "Monthly budgets", [
        { key: "budget_id", label: "Budget ID", db_column: "monthly_budgets.id" },
        { key: "category_id", label: "Category ID", db_column: "monthly_budgets.category_id" },
        { key: "category_name", label: "Category", db_column: "categories.name" },
        { key: "category_description", label: "Category description", db_column: "categories.description" },
        { key: "month", label: "Month", db_column: "monthly_budgets.month" },
        { key: "year", label: "Year", db_column: "monthly_budgets.year" },
        { key: "allocated_amount", label: "Allocated Amount", db_column: "monthly_budgets.allocated_amount" },
        { key: "currency", label: "Currency", db_column: "monthly_budgets.currency" },
        { key: "total_spent", label: "Total Spent (standard)", db_column: "SUM(standard expenses)" },
        { key: "remaining_amount", label: "Remaining", db_column: "allocated - standard_spent" },
        { key: "usage_percentage", label: "Usage %", db_column: "computed" },
        { key: "standard_transaction_count", label: "Standard Txns", db_column: "COUNT(standard)" },
        { key: "extra_transaction_count", label: "Extra Txns", db_column: "COUNT(extra)" }
    ]);
};
