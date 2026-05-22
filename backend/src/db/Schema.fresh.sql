-- =========================================================
-- Svayam Expense Tracker — FRESH INSTALL (final schema only)
-- Database: Svayam_Expense_Tracker
--
-- Use on a new server or after DROP (full reset):
--   DROP DATABASE IF EXISTS Svayam_Expense_Tracker;
--   mysql -u root -p < Schema.fresh.sql
--
-- No ALTER blocks. All tables utf8mb4 (₹, Hindi, emoji safe).
-- Equivalent to Schema.sql final state for backend APIs.
-- After install: cron handles future months (4 defaults: copy prev else 5000).
-- =========================================================

CREATE DATABASE IF NOT EXISTS Svayam_Expense_Tracker
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE Svayam_Expense_Tracker;

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------
-- 1. USERS
-- ---------------------------------------------------------
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100),
    email VARCHAR(150) UNIQUE NOT NULL,
    mobile_no VARCHAR(15) UNIQUE NULL,
    password VARCHAR(255),
    role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
    is_verified_email TINYINT(1) DEFAULT 0,
    is_active TINYINT(1) DEFAULT 0,
    otp_code VARCHAR(6) DEFAULT NULL,
    otp_expiry DATETIME DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_role_active (role, is_active)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------
-- 1b. REGISTRATION PENDING (OTP before full register)
-- ---------------------------------------------------------
CREATE TABLE registration_pending (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(150) NOT NULL,
    otp_code VARCHAR(6) NULL DEFAULT NULL,
    otp_expiry DATETIME NULL DEFAULT NULL,
    email_verified_at DATETIME NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_registration_pending_email (email)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------
-- 2. CATEGORIES
-- archived: no = active; yes = history only
-- ---------------------------------------------------------
CREATE TABLE categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    archived ENUM('yes', 'no') NOT NULL DEFAULT 'no',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_categories_archived (archived),
    INDEX idx_categories_name_active (name, archived)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------
-- 3. MONTHLY BUDGETS (per category, per month/year)
-- ---------------------------------------------------------
CREATE TABLE monthly_budgets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category_id INT NOT NULL,
    month TINYINT NOT NULL,
    year SMALLINT NOT NULL,
    allocated_amount DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    currency VARCHAR(10) DEFAULT 'INR',
    archived ENUM('yes', 'no') NOT NULL DEFAULT 'no',
    created_by INT NULL,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE KEY unique_budget_period (category_id, month, year),
    INDEX idx_monthly_budgets_archived (archived),
    INDEX idx_monthly_budgets_period (year, month)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------
-- 3a. USER ACTIVATION REQUESTS
-- ---------------------------------------------------------
CREATE TABLE user_activation_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    status ENUM('pending', 'approved', 'rejected', 'cancelled') NOT NULL DEFAULT 'pending',
    message TEXT NULL,
    admin_note TEXT NULL,
    reviewed_by INT NULL,
    reviewed_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_activation_requests_user (user_id),
    INDEX idx_activation_requests_status (status),
    INDEX idx_activation_requests_created (created_at)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------
-- 3b. USER MONTHLY BUDGETS (optional per-user cap)
-- ---------------------------------------------------------
CREATE TABLE user_monthly_budgets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    month TINYINT NOT NULL,
    year SMALLINT NOT NULL,
    allocated_amount DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    exceeded_at DATETIME NULL DEFAULT NULL,
    exceeded_notified_at DATETIME NULL DEFAULT NULL,
    created_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE KEY unique_user_budget_period (user_id, month, year),
    INDEX idx_user_monthly_budgets_period (year, month),
    INDEX idx_user_monthly_budgets_user (user_id)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------
-- 4. EXPENSES
-- ---------------------------------------------------------
CREATE TABLE expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    category_id INT NOT NULL,
    user_id INT NOT NULL,
    amount DECIMAL(15, 2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'INR',
    payment_method ENUM('Cash', 'Card', 'UPI', 'Net Banking', 'Others') NOT NULL,
    vendor VARCHAR(255),
    receipt_path VARCHAR(255) DEFAULT NULL,
    description TEXT,
    expense_type ENUM('standard', 'extra') DEFAULT 'standard',
    archived ENUM('yes', 'no') NOT NULL DEFAULT 'no',
    archive_reason ENUM('category_archived', 'user_deleted', 'admin_deleted') NULL DEFAULT NULL,
    deleted_at DATETIME NULL DEFAULT NULL,
    deleted_by INT NULL DEFAULT NULL,
    expense_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_expenses_archived (archived),
    INDEX idx_expenses_archive_reason (archive_reason),
    INDEX idx_expenses_deleted_at (deleted_at),
    INDEX idx_expenses_user_exp_date (user_id, expense_date),
    INDEX idx_expenses_category_type_exp_date (category_id, expense_type, expense_date),
    INDEX idx_expenses_user_budget_spent (user_id, expense_type, archived, expense_date)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------
-- 5. NOTIFICATIONS
-- ---------------------------------------------------------
CREATE TABLE notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    expense_id INT NULL,
    type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE SET NULL,
    INDEX idx_notifications_user (user_id),
    INDEX idx_notifications_read (user_id, is_read)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------
-- ANALYTICS VIEW (live rows only)
-- ---------------------------------------------------------
CREATE OR REPLACE VIEW category_summary AS
SELECT
    mb.category_id,
    c.name AS category_name,
    mb.month,
    mb.year,
    mb.allocated_amount AS budget,
    COALESCE(SUM(CASE WHEN e.expense_type = 'standard' AND e.archived = 'no' THEN e.amount ELSE 0 END), 0) AS total_spent,
    (mb.allocated_amount - COALESCE(SUM(CASE WHEN e.expense_type = 'standard' AND e.archived = 'no' THEN e.amount ELSE 0 END), 0)) AS balance,
    ROUND(
        (COALESCE(SUM(CASE WHEN e.expense_type = 'standard' AND e.archived = 'no' THEN e.amount ELSE 0 END), 0) / NULLIF(mb.allocated_amount, 0)) * 100,
        2
    ) AS usage_percentage
FROM monthly_budgets mb
JOIN categories c ON mb.category_id = c.id AND c.archived = 'no'
LEFT JOIN expenses e ON mb.category_id = e.category_id
    AND e.archived = 'no'
    AND mb.month = MONTH(e.expense_date)
    AND mb.year = YEAR(e.expense_date)
WHERE mb.archived = 'no'
GROUP BY mb.id, mb.category_id, c.name, mb.month, mb.year, mb.allocated_amount;

-- =========================================================
-- SEED DATA (fresh install)
-- =========================================================

-- Super Admin (password: bcrypt hash — change after first login in production)
INSERT INTO users (name, email, mobile_no, password, role, is_active, is_verified_email)
VALUES (
    'Super Admin',
    'admin@svayam.com',
    '9999999999',
    '$2b$10$6uVSrlrInAkWIS46V8TGrus/fUVtLV5xbuzB58x6EDIF8QXOyzoAa',
    'admin',
    1,
    1
);

-- Four default categories (cron also ensures these each month)
INSERT INTO categories (name, description, archived) VALUES
    ('Marketing', NULL, 'no'),
    ('IT Infrastructure', NULL, 'no'),
    ('Food', NULL, 'no'),
    ('Office Supplies', NULL, 'no');

-- Current calendar month: Rs 5000 budget per default category (run date = MONTH/YEAR)
INSERT INTO monthly_budgets (category_id, month, year, allocated_amount, currency, created_by, archived)
SELECT c.id, MONTH(CURDATE()), YEAR(CURDATE()), 5000.00, 'INR', NULL, 'no'
FROM categories c
WHERE c.archived = 'no'
  AND c.name IN ('Marketing', 'IT Infrastructure', 'Food', 'Office Supplies');

-- =========================================================
-- END Schema.fresh.sql
-- =========================================================
