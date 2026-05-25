-- Run in Hostinger phpMyAdmin: select your database, open SQL tab, paste and run.

CREATE TABLE IF NOT EXISTS stock_requests (
  id VARCHAR(80) NOT NULL,
  item_id VARCHAR(80) NOT NULL,
  variant_id VARCHAR(80) NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  sku VARCHAR(128) NOT NULL DEFAULT '',
  requested_by VARCHAR(128) NOT NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  stock_lines LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL,
  reviewed_at DATETIME NULL,
  reviewed_by VARCHAR(128) NULL,
  rejection_reason TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_status (status),
  KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
