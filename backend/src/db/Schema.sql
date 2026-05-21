-- =========================================================
-- DATABASE: Svayam_Expense_Tracker
-- FINAL SCHEMA WITH DUAL VERIFICATION & HIERARCHICAL BUDGETS
-- =========================================================
CREATE DATABASE IF NOT EXISTS Svayam_Expense_Tracker;
USE Svayam_Expense_Tracker;

-- 1. USERS TABLE
-- Handles: Step-by-step Verification, Dual-Login (Email/Phone), and Status Control
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100),
    email VARCHAR(150) UNIQUE NOT NULL,
    mobile_no VARCHAR(15) UNIQUE NULL, -- Initially NULL during Step 1 of registration
    password VARCHAR(255),
    role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
    
    -- Verification Status
    is_verified_email TINYINT(1) DEFAULT 0,
    is_active TINYINT(1) DEFAULT 0, -- Active only after both verifications
    
    -- Security & OTP
    otp_code VARCHAR(6) DEFAULT NULL,
    otp_expiry DATETIME DEFAULT NULL,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 1b. REGISTRATION PENDING (OTP only — full user row created on POST /api/auth/register)
CREATE TABLE registration_pending (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(150) NOT NULL,
    otp_code VARCHAR(6) NULL DEFAULT NULL,
    otp_expiry DATETIME NULL DEFAULT NULL,
    email_verified_at DATETIME NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_registration_pending_email (email)
);

-- 2. CATEGORIES MASTER
-- archived: 'no' = live; 'yes' = history only (name unchanged)
CREATE TABLE categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    archived ENUM('yes', 'no') NOT NULL DEFAULT 'no',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_categories_archived (archived),
    INDEX idx_categories_name_active (name, archived)
);

-- 3. MONTHLY BUDGETS
CREATE TABLE monthly_budgets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category_id INT NOT NULL,
    month TINYINT NOT NULL,      -- 1 to 12
    year SMALLINT NOT NULL,      -- e.g., 2026
    allocated_amount DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    currency VARCHAR(10) DEFAULT 'INR',
    archived ENUM('yes', 'no') NOT NULL DEFAULT 'no',
    created_by INT,              -- Admin ID who set this budget
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    UNIQUE KEY unique_budget_period (category_id, month, year),
    INDEX idx_monthly_budgets_archived (archived)
);

-- 3a. USER ACTIVATION REQUESTS (inactive user → admin approve/reject)
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
);

-- 3b. USER MONTHLY BUDGETS (optional per user; no row = category budget only)
-- Spent is derived from expenses (standard, archived=no) for that user/month/year.
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
);

-- 4. EXPENSES TABLE
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
    INDEX idx_expenses_deleted_at (deleted_at)
);

-- =========================================================
-- INDEXES (MariaDB)
-- =========================================================
CREATE INDEX idx_users_role_active ON users (role, is_active);
CREATE INDEX idx_expenses_user_exp_date ON expenses (user_id, expense_date);
CREATE INDEX idx_expenses_category_type_exp_date ON expenses (category_id, expense_type, expense_date);
CREATE INDEX idx_expenses_user_budget_spent ON expenses (user_id, expense_type, archived, expense_date);

-- 5. ANALYTICS VIEW (live rows only)
CREATE OR REPLACE VIEW category_summary AS
SELECT 
    mb.category_id,
    c.name AS category_name,
    mb.month,
    mb.year,
    mb.allocated_amount AS budget,
    COALESCE(SUM(CASE WHEN e.expense_type = 'standard' AND e.archived = 'no' THEN e.amount ELSE 0 END), 0) AS total_spent,
    (mb.allocated_amount - COALESCE(SUM(CASE WHEN e.expense_type = 'standard' AND e.archived = 'no' THEN e.amount ELSE 0 END), 0)) AS balance,
    ROUND((COALESCE(SUM(CASE WHEN e.expense_type = 'standard' AND e.archived = 'no' THEN e.amount ELSE 0 END), 0) / mb.allocated_amount) * 100, 2) AS usage_percentage
FROM monthly_budgets mb
JOIN categories c ON mb.category_id = c.id AND c.archived = 'no'
LEFT JOIN expenses e ON mb.category_id = e.category_id 
    AND e.archived = 'no'
    AND mb.month = MONTH(e.expense_date) 
    AND mb.year = YEAR(e.expense_date)
WHERE mb.archived = 'no'
GROUP BY mb.id;

-- =========================================================
-- INITIAL SEED DATA
-- =========================================================
INSERT INTO users (name, email, mobile_no, password, role, is_active, is_verified_email) 
VALUES ('Super Admin', 'admin@svayam.com', '9999999999', '$2b$10$6uVSrlrInAkWIS46V8TGrus/fUVtLV5xbuzB58x6EDIF8QXOyzoAa', 'admin', 1, 1);

INSERT INTO categories (name) VALUES ('Marketing'), ('IT Infrastructure'), ('Food'), ('Office Supplies');

-- =========================================================
-- IDEMPOTENT UPGRADE: archived yes/no on categories, budgets, expenses
-- Migrates legacy deleted_at → archived = 'yes' when present.
-- MariaDB: ADD COLUMN IF NOT EXISTS 10.0.2+; CREATE INDEX IF NOT EXISTS 10.5.2+
-- =========================================================
ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS archived ENUM('yes', 'no') NOT NULL DEFAULT 'no' AFTER description;

ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL DEFAULT NULL;

UPDATE categories SET archived = 'yes' WHERE archived = 'no' AND deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_categories_archived ON categories (archived);

ALTER TABLE monthly_budgets
    ADD COLUMN IF NOT EXISTS archived ENUM('yes', 'no') NOT NULL DEFAULT 'no' AFTER currency;

CREATE INDEX IF NOT EXISTS idx_monthly_budgets_archived ON monthly_budgets (archived);

UPDATE monthly_budgets b
INNER JOIN categories c ON c.id = b.category_id
SET b.archived = 'yes'
WHERE c.archived = 'yes' AND b.archived = 'no';

ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS archived ENUM('yes', 'no') NOT NULL DEFAULT 'no' AFTER expense_type;

CREATE INDEX IF NOT EXISTS idx_expenses_archived ON expenses (archived);

UPDATE expenses e
INNER JOIN categories c ON c.id = e.category_id
SET e.archived = 'yes'
WHERE c.archived = 'yes' AND e.archived = 'no';

ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS archive_reason ENUM('category_archived', 'user_deleted', 'admin_deleted') NULL DEFAULT NULL AFTER archived;

ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL DEFAULT NULL AFTER archive_reason;

ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS deleted_by INT NULL DEFAULT NULL AFTER deleted_at;

CREATE INDEX IF NOT EXISTS idx_expenses_archive_reason ON expenses (archive_reason);
CREATE INDEX IF NOT EXISTS idx_expenses_deleted_at ON expenses (deleted_at);

UPDATE expenses
SET archive_reason = 'category_archived',
    deleted_at = COALESCE(deleted_at, created_at)
WHERE archived = 'yes' AND archive_reason IS NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  user_id    INT REFERENCES users(id) ON DELETE CASCADE,
  expense_id INT REFERENCES expenses(id) ON DELETE SET NULL,
  type       VARCHAR(50) NOT NULL,
  message    TEXT NOT NULL,
  is_read    BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now()
);

-- =========================================================
-- IDEMPOTENT UPGRADE: per-user monthly budgets
-- =========================================================
CREATE TABLE IF NOT EXISTS user_monthly_budgets (
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
);

CREATE INDEX IF NOT EXISTS idx_expenses_user_budget_spent ON expenses (user_id, expense_type, archived, expense_date);

-- =========================================================
-- IDEMPOTENT UPGRADE: user activation requests (inactive → admin review)
-- =========================================================
CREATE TABLE IF NOT EXISTS registration_pending (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(150) NOT NULL,
    otp_code VARCHAR(6) NULL DEFAULT NULL,
    otp_expiry DATETIME NULL DEFAULT NULL,
    email_verified_at DATETIME NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_registration_pending_email (email)
);

CREATE TABLE IF NOT EXISTS user_activation_requests (
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
);
