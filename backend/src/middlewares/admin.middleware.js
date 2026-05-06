/**
 * ADMIN ONLY MIDDLEWARE
 * Purpose: Restrict access to admin-only features (e.g., setting master budgets).
 */
export const adminOnly = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ message: "Access denied. Admin resources only." });
    }
};