import { ipcMain } from 'electron'
import { parseFile } from 'music-metadata'
import { fail, ok } from '@shared/result'
import type { AppContext } from '@main/app'

export function registerOtherHandlers(_ctx: AppContext): void {
    ipcMain.handle('parseAudioMetadata', async (_e, filePath: string) => {
        try {
            const meta = await parseFile(filePath)
            const common: Record<string, unknown> = { ...meta.common }
            if (common.picture && Array.isArray(common.picture)) {
                common.picture = common.picture.map((p) => ({
                    data: p.data,
                    format: p.format ?? '',
                    type: (p.type as string) ?? '',
                }))
            }
            return ok({ common, format: { ...meta.format } })
        } catch (err) {
            return fail((err as Error).message)
        }
    })
}
