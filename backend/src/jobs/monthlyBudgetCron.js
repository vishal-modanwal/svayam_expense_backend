import cron from "node-cron";
import { pool } from "../db/index.js";
import { rolloverDefaultCategoryBudgets } from "../utils/rolloverDefaultCategoryBudgets.js";
import {
    clearUserMonthlyBudgetsForPeriod,
    isClearUserBudgetsOnRolloverEnabled,
    isMissingUserBudgetTableError,
} from "../utils/userMonthlyBudget.js";

let scheduledTask = null;
let runInProgress = false;

export function isDefaultBudgetCronEnabled() {
    const v = String(process.env.CRON_DEFAULT_BUDGET_ENABLED ?? "true")
        .trim()
        .toLowerCase();
    return v !== "false" && v !== "0" && v !== "no";
}

/**
 * Run rollover inside a DB transaction. Safe to call from cron or manual trigger.
 */
export async function executeDefaultBudgetRollover(options = {}) {
    if (runInProgress) {
        return {
            status: "skipped",
            reason: "job_already_running",
        };
    }

    runInProgress = true;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const now = new Date();
        const period = {
            month: options.month ?? now.getMonth() + 1,
            year: options.year ?? now.getFullYear(),
        };

        let user_budget_clear;
        if (isClearUserBudgetsOnRolloverEnabled()) {
            try {
                user_budget_clear = await clearUserMonthlyBudgetsForPeriod(
                    connection,
                    period
                );
            } catch (err) {
                if (isMissingUserBudgetTableError(err)) {
                    user_budget_clear = {
                        ...period,
                        user_budget_rows_removed: 0,
                        budget_mode: "not_assigned",
                        skipped: true,
                        reason: "table_missing",
                    };
                } else {
                    throw err;
                }
            }
        } else {
            user_budget_clear = {
                ...period,
                skipped: true,
                reason: "CRON_CLEAR_USER_BUDGETS_disabled",
            };
        }

        const category_rollover = await rolloverDefaultCategoryBudgets(
            connection,
            period
        );

        await connection.commit();
        return {
            status: "success",
            data: {
                period,
                user_budget_clear,
                category_rollover,
            },
        };
    } catch (err) {
        if (connection) await connection.rollback();
        console.error("[cron] monthly budget job failed:", err.message);
        return { status: "error", message: err.message };
    } finally {
        if (connection) connection.release();
        runInProgress = false;
    }
}

/**
 * Register node-cron: 1st of every month 00:05 (configurable).
 */
export function startMonthlyBudgetCron() {
    if (!isDefaultBudgetCronEnabled()) {
        console.log("[cron] default budget rollover disabled (CRON_DEFAULT_BUDGET_ENABLED)");
        return null;
    }

    const schedule =
        String(process.env.CRON_BUDGET_SCHEDULE ?? "5 0 1 * *").trim() || "5 0 1 * *";
    const timezone = String(process.env.CRON_TIMEZONE ?? "Asia/Kolkata").trim();

    if (!cron.validate(schedule)) {
        console.error(
            `[cron] invalid CRON_BUDGET_SCHEDULE "${schedule}" — job not started`
        );
        return null;
    }

    if (scheduledTask) {
        scheduledTask.stop();
    }

    scheduledTask = cron.schedule(
        schedule,
        async () => {
            console.log("[cron] starting monthly job (user caps clear + default category budgets)…");
            const outcome = await executeDefaultBudgetRollover();
            console.log("[cron] monthly budget job finished:", JSON.stringify(outcome));
        },
        { timezone }
    );

    console.log(
        `[cron] default 4-category budgets scheduled (${schedule}, tz=${timezone}); copy prev month else ${process.env.DEFAULT_CATEGORY_BUDGET_AMOUNT ?? "5000"}`
    );
    return scheduledTask;
}

export function stopMonthlyBudgetCron() {
    if (scheduledTask) {
        scheduledTask.stop();
        scheduledTask = null;
    }
}
