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

-- 2. CATEGORIES MASTER
-- Master table for expense categories defined by Admin[cite: 1]
CREATE TABLE categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL DEFAULT NULL,
    INDEX idx_categories_deleted_at (deleted_at)
);

-- 3. MONTHLY BUDGETS
-- Stores category-wise budget limits for each month and year[cite: 1]
CREATE TABLE monthly_budgets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category_id INT NOT NULL,
    month TINYINT NOT NULL,      -- 1 to 12
    year SMALLINT NOT NULL,      -- e.g., 2026
    allocated_amount DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    currency VARCHAR(10) DEFAULT 'INR',
    created_by INT,              -- Admin ID who set this budget[cite: 1]
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    UNIQUE KEY unique_budget_period (category_id, month, year)
);

-- 4. EXPENSES TABLE
-- Tracks standard (in-budget) vs extra (out-of-budget) transactions[cite: 1]
CREATE TABLE expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    category_id INT NOT NULL,
    user_id INT NOT NULL, 
    amount DECIMAL(15, 2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'INR',
    payment_method ENUM('Cash', 'Card', 'UPI', 'Net Banking', 'Others') NOT NULL,
    vendor VARCHAR(255),
    receipt_path VARCHAR(255) DEFAULT NULL, -- Path for OCR processing[cite: 1]
    description TEXT,
    
    -- 'standard' follows budget, 'extra' is admin-authorized[cite: 1]
    expense_type ENUM('standard', 'extra') DEFAULT 'standard',
    
    expense_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- =========================================================
-- INDEXES (MariaDB) — list/join/budget filters; LIKE '%..%' still limited
-- =========================================================
-- Admin dashboard slices: role + is_active on users
CREATE INDEX idx_users_role_active ON users (role, is_active);

-- My-expenses + ordering: user_id + expense_date; optional category_id filter uses user_id prefix
CREATE INDEX idx_expenses_user_exp_date ON expenses (user_id, expense_date);

-- Budget sums & category-scoped reads: category + type + date range
CREATE INDEX idx_expenses_category_type_exp_date ON expenses (category_id, expense_type, expense_date);

-- 5. ANALYTICS VIEW
-- Real-time calculation for WebSocket threshold (80%) alerts[cite: 1]
CREATE VIEW category_summary AS
SELECT 
    mb.category_id,
    c.name AS category_name,
    mb.month,
    mb.year,
    mb.allocated_amount AS budget,
    COALESCE(SUM(CASE WHEN e.expense_type = 'standard' THEN e.amount ELSE 0 END), 0) AS total_spent,
    (mb.allocated_amount - COALESCE(SUM(CASE WHEN e.expense_type = 'standard' THEN e.amount ELSE 0 END), 0)) AS balance,
    ROUND((COALESCE(SUM(CASE WHEN e.expense_type = 'standard' THEN e.amount ELSE 0 END), 0) / mb.allocated_amount) * 100, 2) AS usage_percentage
FROM monthly_budgets mb
JOIN categories c ON mb.category_id = c.id
LEFT JOIN expenses e ON mb.category_id = e.category_id 
    AND mb.month = MONTH(e.expense_date) 
    AND mb.year = YEAR(e.expense_date)
GROUP BY mb.id;

-- =========================================================
-- INITIAL SEED DATA
-- =========================================================
-- Note: Passwords must be hashed in the backend using bcrypt[cite: 1]
INSERT INTO users (name, email, mobile_no, password, role, is_active, is_verified_email) 
VALUES ('Super Admin', 'admin@svayam.com', '9999999999', '$2b$10$6uVSrlrInAkWIS46V8TGrus/fUVtLV5xbuzB58x6EDIF8QXOyzoAa', 'admin', 1, 1);

INSERT INTO categories (name) VALUES ('Marketing'), ('IT Infrastructure'), ('Travel'), ('Office Supplies');

-- =========================================================
-- IDEMPOTENT UPGRADE: categories soft-delete (same DDL as `categories` above)
-- Legacy DBs missing deleted_at: this block adds column + index. Re-run safe on fresh DBs too.
-- ADD COLUMN IF NOT EXISTS: MariaDB 10.0.2+. CREATE INDEX IF NOT EXISTS: MariaDB 10.5.2+
-- (older MariaDB: run ALTER manually if needed; skip CREATE INDEX if idx already exists).
-- =========================================================
ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL DEFAULT NULL AFTER created_at;

CREATE INDEX IF NOT EXISTS idx_categories_deleted_at ON categories (deleted_at);


CREATE TABLE notifications (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  user_id    INT REFERENCES users(id) ON DELETE CASCADE,
  expense_id INT REFERENCES expenses(id) ON DELETE SET NULL,
  type       VARCHAR(50) NOT NULL,
  message    TEXT NOT NULL,
  is_read    BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now()
);