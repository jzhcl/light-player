/**
 * 主进程默认设置工厂
 */
export function getDefaultMainSettings(): LP.MainSetting {
    return {
        'mainWindow.bounds': {
            width: 1200,
            height: 800,
            x: 'center',
            y: 'center',
        },
        'desktopLyricWindow.bounds': {
            width: 1000,
            height: 300,
            x: 'center',
            y: 'center',
        },
        'window.closeToTray': true,
        'window.backgroundMaterial': 'none',
        'application.debug.enable': false,
    }
}

/** 已知主进程设置键（用于遍历与类型推导）。 */
export type MainSettingKey = keyof LP.MainSetting
