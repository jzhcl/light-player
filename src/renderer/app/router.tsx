import { lazy } from 'react'
import { createHashRouter, Navigate } from 'react-router-dom'
import { App } from './App'
import { Settings } from '@renderer/features/settings/Settings'
import { SearchPage } from '@renderer/features/search/SearchPage'
import { LikedPage } from '@renderer/features/liked/LikedPage'
import { PlaylistPage } from '@renderer/features/playlist/PlaylistPage'
import { LocalDownloadPage } from '@renderer/features/local/LocalDownloadPage'
import { RecentPage } from '@renderer/features/recent/RecentPage'

// 设置子页按需懒加载
const GeneralSetting = lazy(() => import('@renderer/features/settings/GeneralSetting').then((m) => ({ default: m.GeneralSetting })))
const AppearanceSetting = lazy(() => import('@renderer/features/settings/AppearanceSetting').then((m) => ({ default: m.AppearanceSetting })))
const DesktopLyricSetting = lazy(() => import('@renderer/features/settings/DesktopLyricSetting').then((m) => ({ default: m.DesktopLyricSetting })))
const LocalDownloadSetting = lazy(() => import('@renderer/features/settings/LocalDownloadSetting').then((m) => ({ default: m.LocalDownloadSetting })))
const HotkeySetting = lazy(() => import('@renderer/features/settings/HotkeySetting').then((m) => ({ default: m.HotkeySetting })))
const PluginSetting = lazy(() => import('@renderer/features/settings/PluginSetting').then((m) => ({ default: m.PluginSetting })))
const AboutSetting = lazy(() => import('@renderer/features/settings/AboutSetting').then((m) => ({ default: m.AboutSetting })))
const PluginSettingsView = lazy(() => import('@renderer/features/settings/PluginSettingsView').then((m) => ({ default: m.PluginSettingsView })))

// 路由表
export const router = createHashRouter([
    {
        path: '/',
        element: <App />,
        children: [
            { index: true, element: <Navigate to="/recent" replace /> },
            { path: 'recent', element: <RecentPage /> },
            { path: 'liked', element: <LikedPage /> },
            { path: 'local-download', element: <LocalDownloadPage /> },
            { path: 'playlist/:id', element: <PlaylistPage /> },
            { path: 'search', element: <SearchPage /> },
            {
                path: 'settings',
                element: <Settings />,
                children: [
                    { index: true, element: <Navigate to="/settings/general" replace /> },
                    { path: 'general', element: <GeneralSetting /> },
                    { path: 'appearance', element: <AppearanceSetting /> },
                    { path: 'desktopLyric', element: <DesktopLyricSetting /> },
                    { path: 'local-download', element: <LocalDownloadSetting /> },
                    { path: 'hotkey', element: <HotkeySetting /> },
                    { path: 'plugin', element: <PluginSetting /> },
                    { path: 'about', element: <AboutSetting /> },
                    // 动态插件设置子页：渲染插件 contributions.views 中 container==='settings' 的视图（?view=<viewId> 指定具体视图）。
                    { path: 'plugin-settings/:id', element: <PluginSettingsView /> },
                ],
            },
        ],
    },
])
