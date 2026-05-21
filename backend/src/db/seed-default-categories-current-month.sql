-- Idempotent: 4 default categories + current calendar month budget @ 5000 each.
-- Safe to re-run. Future months: monthly cron (copy previous month else 5000).
-- Run after Schema.sql (archived columns exist).

-- 1) Categories (active)
INSERT INTO categories (name, description, archived)
SELECT 'Marketing', NULL, 'no' FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM categories WHERE name = 'Marketing' AND archived = 'no'
);

INSERT INTO categories (name, description, archived)
SELECT 'IT Infrastructure', NULL, 'no' FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM categories WHERE name = 'IT Infrastructure' AND archived = 'no'
);

INSERT INTO categories (name, description, archived)
SELECT 'Food', NULL, 'no' FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM categories WHERE name = 'Food' AND archived = 'no'
);

INSERT INTO categories (name, description, archived)
SELECT 'Office Supplies', NULL, 'no' FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM categories WHERE name = 'Office Supplies' AND archived = 'no'
);

-- 2) Budgets for current month (SERVER date = MONTH/YEAR at run time)
INSERT INTO monthly_budgets (category_id, month, year, allocated_amount, currency, created_by, archived)
SELECT c.id, MONTH(CURDATE()), YEAR(CURDATE()), 5000.00, 'INR', NULL, 'no'
FROM categories c
WHERE c.archived = 'no'
  AND c.name IN ('Marketing', 'IT Infrastructure', 'Food', 'Office Supplies')
  AND NOT EXISTS (
      SELECT 1 FROM monthly_budgets b
      WHERE b.category_id = c.id
        AND b.month = MONTH(CURDATE())
        AND b.year = YEAR(CURDATE())
        AND b.archived = 'no'
  );
