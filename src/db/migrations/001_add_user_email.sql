-- Run once if users table already exists WITHOUT email column (phpMyAdmin → SQL).

ALTER TABLE users
  ADD COLUMN email VARCHAR(255) NULL AFTER username;

UPDATE users SET email = CONCAT(username, '@local.placeholder') WHERE email IS NULL OR email = '';

ALTER TABLE users
  MODIFY COLUMN email VARCHAR(255) NOT NULL,
  ADD UNIQUE KEY uq_email (email);
