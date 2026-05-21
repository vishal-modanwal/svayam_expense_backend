export const ACTIVATION_STATUS = {
    PENDING: "pending",
    APPROVED: "approved",
    REJECTED: "rejected",
    CANCELLED: "cancelled",
};

export const ACTIVATION_NOTIFY = {
    SUBMITTED: "activation_request_submitted",
    APPROVED: "activation_request_approved",
    REJECTED: "activation_request_rejected",
    NEW_USER_REGISTERED: "new_user_registered",
    ACCOUNT_ACTIVATED: "account_activated",
};

export const REGISTRATION_ACTIVATION_MESSAGE =
    "New account registration — pending admin activation.";

export function isMissingActivationTableError(err) {
    const msg = String(err?.message ?? "");
    return (
        (err?.errno === 1146 || err?.code === "ER_NO_SUCH_TABLE") &&
        /user_activation_requests/i.test(msg)
    );
}

/** Create pending row (e.g. on register or profile submit). */
export async function createPendingActivationRequest(
    conn,
    userId,
    message = null
) {
    const msg =
        message != null && String(message).trim()
            ? String(message).trim()
            : REGISTRATION_ACTIVATION_MESSAGE;

    const result = await conn.query(
        `INSERT INTO user_activation_requests (user_id, status, message)
         VALUES (?, ?, ?)`,
        [userId, ACTIVATION_STATUS.PENDING, msg]
    );

    const id = result.insertId;
    return typeof id === "bigint" ? Number(id) : id;
}

/** Mark pending requests approved when admin activates user outside activation-requests API. */
export async function resolvePendingActivationRequestsAsApproved(
    conn,
    userId,
    reviewedBy,
    adminNote = null
) {
    const note =
        adminNote != null && String(adminNote).trim()
            ? String(adminNote).trim()
            : "Account activated by administrator.";

    await conn.query(
        `UPDATE user_activation_requests
         SET status = ?,
             admin_note = COALESCE(?, admin_note),
             reviewed_by = ?,
             reviewed_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND status = ?`,
        [
            ACTIVATION_STATUS.APPROVED,
            note,
            reviewedBy ?? null,
            userId,
            ACTIVATION_STATUS.PENDING,
        ]
    );
}

/** Cancel pending requests when admin deactivates a user */
export async function cancelPendingActivationRequests(conn, userId) {
    await conn.query(
        `UPDATE user_activation_requests
         SET status = ?, admin_note = COALESCE(admin_note, 'Cancelled: account deactivated by admin.')
         WHERE user_id = ? AND status = ?`,
        [ACTIVATION_STATUS.CANCELLED, userId, ACTIVATION_STATUS.PENDING]
    );
}
