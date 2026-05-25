# Hostinger MySQL setup (phpMyAdmin)

Pending stock requests are stored in MySQL when `MYSQL_*` is set in `.env`.

## 1. Create database in hPanel

1. Log in to **Hostinger hPanel**
2. **Websites** → your site → **Databases** → **MySQL Databases**
3. Create a new database (e.g. `u123456_loyverse`)
4. Create a database user and password; assign user to the database (All Privileges)

Note the four values:

| Variable | Example |
|----------|---------|
| `MYSQL_HOST` | `localhost` (if Node runs on same Hostinger server) or hostname from hPanel |
| `MYSQL_USER` | `u123456_admin` |
| `MYSQL_PASSWORD` | (your password) |
| `MYSQL_DATABASE` | `u123456_loyverse` |

## 2. phpMyAdmin (optional)

1. hPanel → **phpMyAdmin** → select your database
2. **Import** or **SQL** tab
3. Paste contents of `src/db/schema.sql` and run

The API also runs `CREATE TABLE IF NOT EXISTS` on startup, so this step is optional.

## 3. Backend `.env` on Hostinger

```env
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=u123456_admin
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=u123456_loyverse
```

Redeploy/restart the Node app after saving `.env`.

## 4. Verify

```http
GET https://your-api-domain/health
```

Expect:

```json
{
  "ok": true,
  "stockRequestsStorage": "mysql",
  "mysqlConfigured": true
}
```

## 5. Staff + admin on different devices

Both apps call the **same API URL**. Pending rows live in **Hostinger MySQL**, not in the browser — any device sees the same queue.

## Local dev against Hostinger MySQL

1. hPanel → **Remote MySQL** → allow your home IP
2. Use the remote host (not `localhost`) in `.env`
3. Or use local MySQL / skip `MYSQL_*` for in-memory fallback only
