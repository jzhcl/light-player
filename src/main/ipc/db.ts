import { ipcMain } from 'electron'
import { inspect } from 'node:util'
import { failWithLog, ok } from '@shared/result'
import { db } from '../db'
import { log } from '@main/log'

/** 结构化参数 → 日志文本 */
const show = (value: unknown): string =>
    typeof value === 'string'
        ? value
        : inspect(value, { depth: 5, breakLength: 100, maxArrayLength: 50 })

const dbFail = (op: string, detail: string, err: unknown) => failWithLog(log, 'db', op, detail, err)

export function registerDbHandlers(_ctx: unknown): void {
    ipcMain.handle('db:exec', (_e, sql: string) => {
        try {
            db.exec(sql)
            return ok(true)
        } catch (err) {
            return dbFail('exec', `sql:\n${sql}`, err)
        }
    })

    ipcMain.handle('db:query', (_e, sql: string, params: unknown[] = []) => {
        try {
            return ok(db.query(sql, params))
        } catch (err) {
            return dbFail('query', `sql:\n${sql}\nparams: ${show(params)}`, err)
        }
    })

    ipcMain.handle('db:execute', (_e, sql: string, params: unknown[] = []) => {
        try {
            return ok(db.execute(sql, params))
        } catch (err) {
            return dbFail('execute', `sql:\n${sql}\nparams: ${show(params)}`, err)
        }
    })

    ipcMain.handle('db:find', (_e, table: string, conditions: Record<string, unknown> = {}) => {
        try {
            return ok(db.find(table, conditions))
        } catch (err) {
            return dbFail('find', `table: ${table}\nconditions: ${show(conditions)}`, err)
        }
    })

    ipcMain.handle('db:create', (_e, table: string, data: Record<string, unknown>) => {
        try {
            return ok(db.create(table, data))
        } catch (err) {
            return dbFail('create', `table: ${table}\ndata: ${show(data)}`, err)
        }
    })

    ipcMain.handle('db:createMany', (_e, table: string, rows: Record<string, unknown>[]) => {
        try {
            return ok(db.createMany(table, rows))
        } catch (err) {
            return dbFail('createMany', `table: ${table}\nrows(${rows.length}): ${show(rows)}`, err)
        }
    })

    ipcMain.handle('db:update', (_e, table: string, conditions: Record<string, unknown>, data: Record<string, unknown>) => {
        try {
            return ok(db.update(table, conditions, data))
        } catch (err) {
            return dbFail('update', `table: ${table}\nconditions: ${show(conditions)}\ndata: ${show(data)}`, err)
        }
    })

    ipcMain.handle('db:upsert', (_e, table: string, conditions: Record<string, unknown>, data: Record<string, unknown>) => {
        try {
            return ok(db.upsert(table, conditions, data))
        } catch (err) {
            return dbFail('upsert', `table: ${table}\nconditions: ${show(conditions)}\ndata: ${show(data)}`, err)
        }
    })

    ipcMain.handle('db:delete', (_e, table: string, conditions: Record<string, unknown>) => {
        try {
            return ok(db.delete(table, conditions))
        } catch (err) {
            return dbFail('delete', `table: ${table}\nconditions: ${show(conditions)}`, err)
        }
    })
}
