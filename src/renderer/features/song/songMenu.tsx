import { ContextMenu } from '@renderer/components/ContextMenu'
import { player } from '@renderer/features/player/player'
import { type QueueEntry } from '@renderer/features/song/songKey'

/**
 * 歌曲右键菜单中菜单项的共用实现
 */

/**
 * 「添加到 ▸」子菜单
 */
interface AddToSubMenuProps {
    /** 候选歌单 */
    playlists: LP.Playlist[]
    /** 是否提供「我喜欢」项 */
    includeLiked: boolean
    onPickLiked?: () => void
    onPickPlaylist: (playlist: LP.Playlist) => void
}

export function AddToSubMenu({ playlists, includeLiked, onPickLiked, onPickPlaylist }: AddToSubMenuProps) {
    return (
        <ContextMenu.Sub label="添加到" icon="add">
            {includeLiked ? (
                <ContextMenu.Item icon="heart" onSelect={onPickLiked}>
                    我喜欢
                </ContextMenu.Item>
            ) : null}
            {playlists.map((playlist) => (
                // 有封面就显示缩略图，没有则退回歌单图标
                <ContextMenu.Item
                    key={playlist.id}
                    pic={playlist.pic}
                    icon="music-note-list"
                    onSelect={() => onPickPlaylist(playlist)}
                >
                    {playlist.name}
                </ContextMenu.Item>
            ))}
            {/* 一个可选目标都没有时给一条禁用项，而不是留一个「点开是空的」子菜单 */}
            {!includeLiked && playlists.length === 0 ? (
                <ContextMenu.Item disabled>暂无其他歌单</ContextMenu.Item>
            ) : null}
        </ContextMenu.Sub>
    )
}

/** 音质标签：形如「无损(SQ) - 12.3MB」（无 size 时省略后半段） */
function formatQualityLabel(quality: { type: Quality; size?: string | number }): string {
    const size = quality.size === undefined || quality.size === '' ? '' : ` - ${quality.size}`
    switch (quality.type) {
        case 'Standard':
            return `标准${size}`
        case 'HQ':
            return `高品(HQ)${size}`
        case 'SQ':
            return `无损(SQ)${size}`
        case 'Hi-Res':
            return `高解析(Hi-Res)${size}`
        case 'Master':
            return `臻品母带(Master)${size}`
    }
}

/**
 * 「下载」项
 */
interface DownloadItemProps {
    disabled: boolean
    /** 单选目标的可选音质；不足两项时不展开子菜单 */
    qualityOptions?: { type: Quality; size?: string | number }[]
    /** 选中音质（不传＝推荐音质）。当前不接下载实现 */
    onSelect?: (quality?: Quality) => void
}

export function DownloadItem({ disabled, qualityOptions, onSelect }: DownloadItemProps) {
    if (qualityOptions && qualityOptions.length > 1) {
        return (
            <ContextMenu.Sub label="下载" icon="download" disabled={disabled}>
                {qualityOptions.map((quality) => (
                    <ContextMenu.Item
                        key={quality.type}
                        disabled={disabled}
                        onSelect={() => onSelect?.(quality.type)}
                    >
                        {formatQualityLabel(quality)}
                    </ContextMenu.Item>
                ))}
            </ContextMenu.Sub>
        )
    }
    return (
        <ContextMenu.Item icon="download" disabled={disabled} onSelect={() => onSelect?.()}>
            下载
        </ContextMenu.Item>
    )
}

/**
 * 「播放」项
 */
export interface PlayItemProps {
    /** 待播放的队列项（整批作为新队列） */
    entries: QueueEntry[]
}
export function PlayItem({ entries }: PlayItemProps) {
    return (
        <ContextMenu.Item
            icon="play"
            onSelect={() => {
                if (entries.length === 0) return
                player.setQueue(entries)
                void player.play()
            }}
        >
            播放
        </ContextMenu.Item>
    )
}

/**
 * 「添加到队列」项：整批一次插入当前曲之后、保持选中顺序。
 */
export interface AddToQueueItemProps {
    entries: QueueEntry[]
}
export function AddToQueueItem({ entries }: AddToQueueItemProps) {
    return (
        <ContextMenu.Item
            icon="play-add"
            onSelect={() => {
                if (entries.length === 0) return
                player.addToQueue(entries, 'current')
            }}
        >
            添加到队列
        </ContextMenu.Item>
    )
}
