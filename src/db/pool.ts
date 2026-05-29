import mysql from 'mysql2/promise'

export function isMysqlConfigured(): boolean {
  return Boolean(
    process.env.MYSQL_HOST?.trim() &&
      process.env.MYSQL_USER?.trim() &&
      process.env.MYSQL_DATABASE?.trim(),
  )
}

let pool: mysql.Pool | null = null

export function getPool(): mysql.Pool {
  if (!isMysqlConfigured()) {
    throw new Error('MySQL is not configured (set MYSQL_HOST, MYSQL_USER, MYSQL_DATABASE in .env)')
  }

  if (!pool) {
    const useSSL = process.env.MYSQL_SSL === 'true'
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD ?? '',
      database: process.env.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
      timezone: 'Z',
      ...(useSSL ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } } : {}),
    })
  }

  return pool
}

export async function testMysqlConnection(): Promise<boolean> {
  const p = getPool()
  await p.query('SELECT 1')
  return true
}
