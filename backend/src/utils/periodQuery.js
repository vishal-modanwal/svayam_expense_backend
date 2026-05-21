/**
 * Shared month/year query parsing for period-scoped list and summary APIs.
 * Defaults to current calendar month when params omitted.
 */
export function resolvePeriodFromQuery(query = {}) {
    const now = new Date();
    const hasMonth = query.month !== undefined && query.month !== "";
    const hasYear = query.year !== undefined && query.year !== "";

    if (hasMonth !== hasYear) {
        return {
            error: "Provide both month and year query params, or omit both for the current period.",
        };
    }

    const month = hasMonth
        ? parseInt(String(query.month), 10)
        : now.getMonth() + 1;
    const year = hasYear
        ? parseInt(String(query.year), 10)
        : now.getFullYear();

    if (!Number.isFinite(month) || month < 1 || month > 12) {
        return { error: "month must be 1–12." };
    }
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
        return { error: "year must be between 2000 and 2100." };
    }

    return { month, year };
}

/** Append expense_date period filter (alias `e`). */
export function appendExpensePeriodSql(clauses, params, month, year) {
    clauses.push("MONTH(e.expense_date) = ?", "YEAR(e.expense_date) = ?");
    params.push(month, year);
}
