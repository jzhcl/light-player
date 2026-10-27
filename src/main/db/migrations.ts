import { log } from '@main/log'
import type { DatabaseApi } from './index'

const modules = import.meta.glob('./migrations/*.sql', {
    eager: true,
    query: '?raw',
    import: 'default',
}) as Record<string, string>

interface Migration {
    name: string
    sql: string
}

const migrations: Migration[] = Object.keys(modules)
    .sort()
    .map((path) => ({
        name: path.slice(path.lastIndexOf('/') + 1),
        sql: modules[path],
    }))

const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
)`

/** 依次应用一批迁移，每个迁移包在独立事务里 */
function applyMigrations(db: DatabaseApi, pending: Migration[]): void {
    if (pending.length === 0) return

    const startedAt = Date.now()

    for (const m of pending) {
        db.exec('BEGIN')
        try {
            db.exec(m.sql)
            db.create('schema_migrations', { name: m.name })
            db.exec('COMMIT')
            log.info(`[migrate] 已应用 ${m.name}`)
        } catch (err) {
            db.exec('ROLLBACK')
            const message = err instanceof Error ? err.message : String(err)
            const stack = err instanceof Error ? (err.stack ?? message) : message
            log.error(`[migrate] ${m.name} 失败，已回滚\n${stack}`)
            throw new Error(`数据库迁移失败: ${m.name}: ${message}`)
        }
    }

    log.info(
        `[migrate] 本次启动应用 ${pending.length} 个迁移（${Date.now() - startedAt}ms）：` +
            pending.map((m) => m.name).join(', '),
    )
}

/** 执行全部未应用的迁移。每个迁移包在独立事务中，失败回滚并 throw */
export function runMigrations(db: DatabaseApi): void {
    db.exec(SCHEMA_MIGRATIONS_DDL)
    const applied = new Set(db.query('SELECT name FROM schema_migrations').map((r) => r.name as string))

    const pending = migrations.filter((m) => !applied.has(m.name))
    if (pending.length === 0) return

    applyMigrations(db, pending)
}
