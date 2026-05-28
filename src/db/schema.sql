-- Run in Hostinger phpMyAdmin: select your database, open SQL tab, paste and run.

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) NOT NULL,
  username VARCHAR(64) NOT NULL,
  email VARCHAR(255) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'operator') NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_username (username),
  UNIQUE KEY uq_email (email),
  KEY idx_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_requests (
  id VARCHAR(80) NOT NULL,
  item_id VARCHAR(80) NOT NULL,
  variant_id VARCHAR(80) NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  sku VARCHAR(128) NOT NULL DEFAULT '',
  store_id VARCHAR(80) NOT NULL,
  store_name VARCHAR(255) NOT NULL,
  old_stock INT NOT NULL,
  old_stock_synced TINYINT(1) NOT NULL DEFAULT 0,
  new_stock INT NOT NULL,
  requested_by VARCHAR(128) NOT NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  stock_lines LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL,
  reviewed_at DATETIME NULL,
  reviewed_by VARCHAR(128) NULL,
  rejection_reason TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_status (status),
  KEY idx_created_at (created_at),
  KEY idx_store_id (store_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
