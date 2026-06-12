import { getPool, isMysqlConfigured } from './pool.js'
import { migrateStockRequestsBranchColumns } from './migrateStockRequests.js'

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh VARCHAR(512) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    KEY idx_user_id (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS users (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS stock_requests (
    id VARCHAR(80) NOT NULL,
    item_id VARCHAR(80) NOT NULL,
    variant_id VARCHAR(80) NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    sku VARCHAR(128) NOT NULL DEFAULT '',
    store_id VARCHAR(80) NOT NULL,
    store_name VARCHAR(255) NOT NULL,
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS transfer_requests (
    id VARCHAR(80) NOT NULL,
    item_id VARCHAR(80) NOT NULL,
    variant_id VARCHAR(80) NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    sku VARCHAR(128) NOT NULL DEFAULT '',
    from_store_id VARCHAR(80) NOT NULL,
    from_store_name VARCHAR(255) NOT NULL,
    to_store_id VARCHAR(80) NOT NULL,
    to_store_name VARCHAR(255) NOT NULL,
    quantity INT NOT NULL,
    requested_by VARCHAR(128) NOT NULL,
    status ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
    created_at DATETIME NOT NULL,
    reviewed_at DATETIME NULL,
    reviewed_by VARCHAR(128) NULL,
    rejection_reason TEXT NULL,
    PRIMARY KEY (id),
    KEY idx_status (status),
    KEY idx_created_at (created_at),
    KEY idx_item_id (item_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS price_history (
    id VARCHAR(80) NOT NULL,
    item_id VARCHAR(80) NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    store_id VARCHAR(80) NOT NULL,
    store_name VARCHAR(255) NOT NULL,
    old_price DECIMAL(12,2) NULL,
    new_price DECIMAL(12,2) NOT NULL,
    changed_by VARCHAR(128) NOT NULL,
    created_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    KEY idx_item_id (item_id),
    KEY idx_created_at (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS created_items (
    id VARCHAR(80) NOT NULL,
    item_id VARCHAR(80) NOT NULL DEFAULT '',
    item_name VARCHAR(255) NOT NULL,
    sku VARCHAR(128) NOT NULL DEFAULT '',
    category_id VARCHAR(80) NULL,
    cost DECIMAL(12,2) NULL,
    default_price DECIMAL(12,2) NULL,
    track_stock TINYINT(1) NOT NULL DEFAULT 0,
    sold_by_weight TINYINT(1) NOT NULL DEFAULT 0,
    stores_json LONGTEXT NULL,
    created_by VARCHAR(128) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    KEY idx_item_id (item_id),
    KEY idx_created_at (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
]

export async function initDatabaseSchema(): Promise<void> {
  if (!isMysqlConfigured()) return

  const pool = getPool()
  for (const statement of SCHEMA_STATEMENTS) {
    await pool.query(statement)
  }

  await migrateStockRequestsBranchColumns()
}
