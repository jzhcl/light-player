import { updateSong as dbUpdateSong } from '@renderer/lib/db'
import { eventBus, LP_EVENT } from '@renderer/lib/eventBus'
import { isOk } from '@shared/result'

/**
 * 更新歌曲元数据：写 DB 后 emit `SONG.UPDATED`。
 *
 * 任何修改歌曲字段的地方都应走这里，
 */
export async function updateSong(songId: string, patch: Partial<LP.Song>): Promise<Result<boolean>> {
    const r = await dbUpdateSong(songId, patch)
    if (!isOk(r)) return r
    eventBus.emit(LP_EVENT['SONG.UPDATED'], { id: songId, patch })
    return r
}
