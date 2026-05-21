/**
 * Blocks inactive non-admin users from app features (expenses, budget, etc.).
 * Inactive users may still use profile status + activation-request routes.
 */
export const requireActiveUser = (req, res, next) => {
    if (req.user?.role === "admin") return next();
    const active = Number(req.user?.is_active) === 1;
    if (active) return next();
    return res.status(403).json({
        message:
            "Your account is inactive. Submit an activation request from your profile or contact an administrator.",
        code: "ACCOUNT_INACTIVE",
        activity_status: "inactive",
    });
};
