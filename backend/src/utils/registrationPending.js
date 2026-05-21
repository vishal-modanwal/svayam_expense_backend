/** Pending signups — no row in `users` until POST /register succeeds. */

export function isMissingRegistrationPendingTableError(err) {
    const msg = String(err?.message ?? "");
    return (
        (err?.errno === 1146 || err?.code === "ER_NO_SUCH_TABLE") &&
        /registration_pending/i.test(msg)
    );
}

export function normalizeEmail(email) {
    return String(email ?? "").trim().toLowerCase();
}
