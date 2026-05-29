-- Migration 002: add 'cancelled' to stock_requests status enum
-- Run in Hostinger phpMyAdmin: select your database, open SQL tab, paste and run.

ALTER TABLE stock_requests
  MODIFY COLUMN status ENUM('pending', 'approved', 'rejected', 'cancelled')
  NOT NULL DEFAULT 'pending';
