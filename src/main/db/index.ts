import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { PATHS } from '@main/constants/paths'
import { runMigrations } from './migrations'

export interface DatabaseApi {
    /** 执行任意 SQL（DDL/多语句） */
    exec(sql: string): void

    /** 执行查询 SQL */
    query(sql: string, params?: unknown[]): Record<string, unknown>[]

    /** 执行写 SQL */
    execute(sql: string, params?: unknown[]): number

    /** 按条件查单条记录，无匹配返回 null。 */
    find(table: string, conditions?: Record<string, unknown>): Record<string, unknown> | null

    /** 插入新记录，成功返回 true。 */
    create(table: string, data: Record<string, unknown>): boolean

    /** 批量插入记录（同一事务），返回插入行数。所有行的列以首行为准。 */
    createMany(table: string, rows: Record<string, unknown>[]): number

    /** 按条件更新记录，成功返回 true。 */
    update(table: string, conditions: Record<string, unknown>, data: Record<string, unknown>): boolean

    /** 先查后写：存在则更新，不存在则合并 conditions+data 插入。 */
    upsert(table: string, conditions: Record<string, unknown>, data: Record<string, unknown>): boolean

    /** 按条件删除记录，返回删除行数。 */
    delete(table: string, conditions: Record<string, unknown>): number

    /** 关闭数据库连接。 */
    close(): void
}

function toSnake(s: string): string {
    return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

function toCamel(s: string): string {
    return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function mapKeys(obj: Record<string, unknown>, fn: (k: string) => string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [fn(k), v]))
}

function convertValue(value: unknown): SQLInputValue {
    if (value === null || value === undefined) return null
    if (typeof value === 'string' || typeof value === 'number') return value
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'object') return JSON.stringify(value)
    return null
}

function parseValue(value: unknown): unknown {
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
        try {
            const parsed = JSON.parse(value) as unknown
            if (typeof parsed === 'object' && parsed !== null) return parsed
        } catch {
            // 非 JSON 字符串，原样返回
        }
    }
    return value
}

export function createDatabase(): DatabaseApi {
    const dbPath = PATHS.getDatabase()
    // node:sqlite 不会自动创建父目录，必须先确保 db 目录存在
    mkdirSync(dirname(dbPath), { recursive: true })
    const sqlite = new DatabaseSync(dbPath)
    sqlite.exec('PRAGMA journal_mode = WAL')

    // 行结果：下划线→驼峰 + JSON 字段解析
    const rowToCamel = (row: Record<string, unknown>): Record<string, unknown> => {
        const converted: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(row)) converted[toCamel(k)] = parseValue(v)
        return converted
    }

    // WHERE 子句：conditions 每个键生成 `snake = ?`，返回子句与位置参数
    const buildWhere = (conditions: Record<string, unknown>): { clauses: string[]; values: SQLInputValue[] } => {
        const clauses: string[] = []
        const values: SQLInputValue[] = []
        for (const [k, v] of Object.entries(conditions)) {
            clauses.push(`${toSnake(k)} = ?`)
            values.push(convertValue(v))
        }
        return { clauses, values }
    }

    const api: DatabaseApi = {
        exec(sql) {
            sqlite.exec(sql)
        },

        query(sql, params = []) {
            const rows = sqlite.prepare(sql).all(...params.map(convertValue)) as Record<string, unknown>[]
            return rows.map(rowToCamel)
        },

        execute(sql, params = []) {
            const info = sqlite.prepare(sql).run(...params.map(convertValue))
            return Number(info.changes)
        },

        find(table, conditions = {}) {
            const { clauses, values } = buildWhere(conditions)
            const sql = `SELECT *
                         FROM ${table} ${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
                         LIMIT 1`
            const row = sqlite.prepare(sql).get(...values) as Record<string, unknown> | undefined
            return row ? rowToCamel(row) : null
        },

        create(table, data) {
            const snake = mapKeys(data, toSnake)
            const cols = Object.keys(snake)
            const sql = `INSERT INTO ${table} (${cols.join(',')})
                         VALUES (${cols.map(() => '?').join(',')})`
            const info = sqlite.prepare(sql).run(...Object.values(snake).map(convertValue))
            return info.changes > 0
        },

        createMany(table, rows) {
            if (rows.length === 0) return 0
            const cols = Object.keys(mapKeys(rows[0], toSnake))
            const placeholders = `(${cols.map(() => '?').join(',')})`
            const sql = `INSERT INTO ${table} (${cols.join(',')})
                         VALUES ${rows.map(() => placeholders).join(',')}`
            const params: SQLInputValue[] = []
            for (const row of rows) {
                const snake = mapKeys(row, toSnake)
                for (const c of cols) params.push(convertValue(snake[c]))
            }
            const info = sqlite.prepare(sql).run(...params)
            return Number(info.changes)
        },

        update(table, conditions, data) {
            const set = mapKeys(data, toSnake)
            const setCols = Object.keys(set)
            if (setCols.length === 0) return false
            const { clauses, values } = buildWhere(conditions)
            const sql = `UPDATE ${table}
                         SET ${setCols.map((c) => `${c} = ?`).join(',')}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`
            const info = sqlite.prepare(sql).run(...Object.values(set).map(convertValue), ...values)
            return info.changes > 0
        },

        upsert(table, conditions, data) {
            const existing = api.find(table, conditions)
            if (existing) return api.update(table, conditions, data)
            return api.create(table, { ...conditions, ...data })
        },

        delete(table, conditions) {
            if (Object.keys(conditions).length === 0) return 0
            const { clauses, values } = buildWhere(conditions)
            const sql = `DELETE
                         FROM ${table}
                         WHERE ${clauses.join(' AND ')}`
            const info = sqlite.prepare(sql).run(...values)
            return Number(info.changes)
        },

        close() {
            sqlite.close()
        },
    }

    return api
}


export const db = createDatabase()

export function initDatabase(): void {
    runMigrations(db)
}
