import type { AppContext } from '../app'
import { registerWindowHandlers } from './window'
import { registerDbHandlers } from './db'
import { registerDownloadHandlers } from './download'
import { registerLogHandlers } from './log'
import { registerFileHandlers } from './file'
import { registerHotkeyHandlers } from './hotkey'
import { registerPluginHandlers } from './plugin'
import { registerSettingsHandlers } from './settings'
import { registerAudioHandlers } from './audio'
import { registerAppHandlers } from './app'
import { registerTrayHandlers } from './tray'
import { registerMessageHandlers } from './message'
import { registerUpdateHandlers } from './update'


export function registerIpcHandlers(ctx: AppContext): void {
    registerWindowHandlers(ctx)
    registerDbHandlers(ctx)
    registerDownloadHandlers(ctx)
    registerLogHandlers(ctx)
    registerFileHandlers(ctx)
    registerHotkeyHandlers(ctx)
    registerPluginHandlers(ctx)
    registerSettingsHandlers(ctx)
    registerAudioHandlers(ctx)
    registerAppHandlers(ctx)
    registerTrayHandlers(ctx)
    registerMessageHandlers()
    registerUpdateHandlers(ctx)
}
