import { invokeResult } from '../ipc'


/** 执行任意 SQL（DDL/多语句）。 */
export async function dbExec(sql: string): Promise<Result<boolean>> {
    return invokeResult<boolean>('db:exec', sql)
}

/** 执行查询 SQL，返回行数组（键已转驼峰，JSON 字段已解析）。`T` 由调用方按 SQL 指定。 */
export async function dbQuery<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Result<T[]>> {
    return invokeResult<T[]>('db:query', sql, params ?? [])
}

/** 执行写 SQL（INSERT/UPDATE/DELETE），返回受影响行数。 */
export async function dbExecute(sql: string, params?: unknown[]): Promise<Result<number>> {
    return invokeResult<number>('db:execute', sql, params ?? [])
}

/** 按条件查单条记录（无匹配时 `value` 为 null）。`T` 由调用方按表指定。 */
export async function dbFind<T = Record<string, unknown>>(
    table: string,
    conditions?: Record<string, unknown>,
): Promise<Result<T | null>> {
    return invokeResult<T | null>('db:find', table, conditions ?? {})
}

/** 插入新记录。 */
export async function dbCreate(table: string, data: Record<string, unknown>): Promise<Result<boolean>> {
    return invokeResult<boolean>('db:create', table, data)
}

/** 批量插入记录。 */
export async function dbCreateMany(table: string, rows: Record<string, unknown>[]): Promise<Result<number>> {
    return invokeResult<number>('db:createMany', table, rows)
}

/** 按条件更新记录。 */
export async function dbUpdate(
    table: string,
    conditions: Record<string, unknown>,
    data: Record<string, unknown>,
): Promise<Result<boolean>> {
    return invokeResult<boolean>('db:update', table, conditions, data)
}

/** 先查后写：存在则更新，不存在则合并 conditions+data 插入。 */
export async function dbUpsert(
    table: string,
    conditions: Record<string, unknown>,
    data: Record<string, unknown>,
): Promise<Result<boolean>> {
    return invokeResult<boolean>('db:upsert', table, conditions, data)
}

/** 按条件删除记录，返回删除行数。 */
export async function dbDelete(table: string, conditions: Record<string, unknown>): Promise<Result<number>> {
    return invokeResult<number>('db:delete', table, conditions)
}
