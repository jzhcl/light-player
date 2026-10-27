import { useCallback } from 'react'
import { isOk } from '@shared/result'
import { useUpdateStore } from '@renderer/store'
import { invokeResult } from '@renderer/lib/ipc'
import { message } from '@renderer/lib/message'


export function useUpdate() {
    const state = useUpdateStore((s) => s.state)
    const progress = useUpdateStore((s) => s.progress)

    const run = useCallback(async (channel: string) => {
        const r = await invokeResult<null>(channel)
        if (!isOk(r)) message.error(r.error)
    }, [])

    const check = useCallback(() => void run('update:check'), [run])
    const download = useCallback(() => void run('update:download'), [run])
    const install = useCallback(() => void run('update:install'), [run])

    return { state, progress, check, download, install }
}
