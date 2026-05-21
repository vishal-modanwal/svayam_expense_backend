import { createNotification } from "./notifications.js";
import { sendUserAccountActivatedEmail } from "./emailService.js";
import { ACTIVATION_NOTIFY } from "./activationRequest.js";

/**
 * In-app notification + email after admin activates a user account.
 */
export async function notifyUserAccountActivated(user, adminNote = null) {
    const userId = typeof user.id === "bigint" ? Number(user.id) : user.id;
    const email = String(user.email ?? "").trim();
    const name = user.name || user.email || `User #${userId}`;

    const msg = adminNote
        ? `Your account has been activated. Note: ${adminNote}`
        : "Your account has been activated. You can now sign in and add expenses.";

    await createNotification(userId, null, ACTIVATION_NOTIFY.ACCOUNT_ACTIVATED, msg);

    if (email) {
        sendUserAccountActivatedEmail(email, { name, adminNote }).catch((err) =>
            console.error("Account activated email failed:", err.message)
        );
    }
}
