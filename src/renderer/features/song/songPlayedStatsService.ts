import { incrementPlayedCount } from '@renderer/lib/db'
import { isOk } from '@shared/result'
import { eventBus } from "@renderer/lib/eventBus";
import { LP_EVENT } from "@shared/event";


/** 记录一次播放。失败仅记日志，不影响播放流程 */
export async function recordPlay(songId: string): Promise<void> {
    const r = await incrementPlayedCount(songId)
    if (!isOk(r)) {
        return
    }
    eventBus.emit(LP_EVENT['STATS.PLAYED_COUNT_UPDATED'], songId)
}
