import { Suspense, useMemo } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AppLink } from '@renderer/components/ui/AppLink'
import { ScrollArea } from '@renderer/components/ui/ScrollArea'
import { usePlugins } from '@renderer/features/plugin/usePlugin'

interface NavItem {
    id: string
    name: string
    path: string
}

// 程序内置设置页导航
const SETTING_SECTIONS: NavItem[] = [
    { id: 'general', name: '常规', path: '/settings/general' },
    { id: 'appearance', name: '外观', path: '/settings/appearance' },
    { id: 'desktopLyric', name: '桌面歌词', path: '/settings/desktopLyric' },
    { id: 'local-download', name: '本地与下载', path: '/settings/local-download' },
    { id: 'hotkey', name: '快捷键', path: '/settings/hotkey' },
    { id: 'plugin', name: '插件', path: '/settings/plugin' },
    { id: 'about', name: '关于', path: '/settings/about' },
]

export function Settings() {
    const location = useLocation()
    const plugins = usePlugins()

    // 仅「已激活且声明了 container==='settings' 的视图」的插件，标签为插件名
    const pluginSettingsItems = useMemo<NavItem[]>(
        () =>
            plugins
                .filter(
                    (p) =>
                        p.enabled && (p.views ?? []).some((v) => v.container === 'settings'),
                )
                .map((p) => ({
                    id: `plugin-settings-${p.id}`,
                    name: p.name,
                    path: `/settings/plugin-settings/${p.id}`,
                })),
        [plugins],
    )

    const hasPluginGroup = pluginSettingsItems.length > 0

    return (
        <div className="settings">
            <nav className="settings-nav" aria-label="设置导航">
                <ScrollArea
                    className="settings-nav-scroll-wrap"
                    scrollClassName="settings-nav-scroll"
                    thumbClassName="settings-nav-scroll-thumb"
                    trigger="hover"
                    autoHide
                    hideDelay={800}
                    deps={[pluginSettingsItems.length]}
                >
                    <ul className="settings-nav-list">
                        {SETTING_SECTIONS.map((s) => (
                            <li key={s.id} className="settings-nav-item-wrap">
                                <AppLink
                                    to={s.path}
                                    draggable={false}
                                    className={({ isActive }) =>
                                        isActive ? 'settings-nav-item is-active' : 'settings-nav-item'
                                    }
                                >
                                    {s.name}
                                </AppLink>
                            </li>
                        ))}
                        {/* 两组之间的分割线：仅当存在插件设置组时才渲染 */}
                        {hasPluginGroup && (
                            <li key="__divider" className="settings-nav-divider" aria-hidden="true" />
                        )}
                        {pluginSettingsItems.map((s) => (
                            <li key={s.id} className="settings-nav-item-wrap">
                                <AppLink
                                    to={s.path}
                                    draggable={false}
                                    className={({ isActive }) =>
                                        isActive ? 'settings-nav-item is-active' : 'settings-nav-item'
                                    }
                                >
                                    {s.name}
                                </AppLink>
                            </li>
                        ))}
                    </ul>
                </ScrollArea>
            </nav>
            <main className="settings-content">
                {/* 页面级标题只给读屏：各子页的分组标题是 h2，缺 h1 会让大纲从 h2 起跳 */}
                <h1 className="sr-only">设置</h1>
                <ScrollArea
                    className="settings-scroll-wrap"
                    scrollClassName="settings-scroll"
                    thumbClassName="settings-scroll-thumb"
                    trigger="hover"
                    autoHide
                    hideDelay={800}
                    deps={[location.pathname]}
                >
                    {/* 设置子页为懒加载，加载期间仅内容区短暂空白 */}
                    <Suspense fallback={null}>
                        <Outlet />
                    </Suspense>
                </ScrollArea>
            </main>
        </div>
    )
}
