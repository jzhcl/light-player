// 图标注册表：新增图标只需在此加一行，组件侧用 <Icon name="文件名" /> 引用
// 图标名与文件名保持一致
import Add from './add.svg?react'
import ArrowBarDown from './arrow-bar-down.svg?react'
import ArrowBarUp from './arrow-bar-up.svg?react'
import ArrowDownShort from './arrow-down-short.svg?react'
import ArrowDownUp from './arrow-down-up.svg?react'
import ArrowUpShort from './arrow-up-short.svg?react'
import Captions from './captions.svg?react'
import CheckCircle from './check-circle.svg?react'
import CheckLg from './check-lg.svg?react'
import ChevronLeft from './chevron-left.svg?react'
import ChevronRight from './chevron-right.svg?react'
import Clock from './clock.svg?react'
import ClockHistory from './clock-history.svg?react'
import Code from './code.svg?react'
import Dash from './dash.svg?react'
import Download from './download.svg?react'
import ExclamationCircle from './exclamation-circle.svg?react'
import Expand from './expand.svg?react'
import Folder from './folder.svg?react'
import Gear from './gear.svg?react'
import Heart from './heart.svg?react'
import HeartBreak from './heart-break.svg?react'
import HeartFill from './heart-fill.svg?react'
import InfoCircle from './info-circle.svg?react'
import LocalBadge from './local-badge.svg?react'
import Lock from './lock.svg?react'
import Loop from './loop.svg?react'
import MusicNote from './music-note.svg?react'
import MusicNoteList from './music-note-list.svg?react'
import Next from './next.svg?react'
import PauseFill from './pause-fill.svg?react'
import Pencil from './pencil.svg?react'
import Play from './play.svg?react'
import PlayAdd from './play-add.svg?react'
import PlayFill from './play-fill.svg?react'
import Power from './power.svg?react'
import Prev from './prev.svg?react'
import Random from './random.svg?react'
import Refresh from './refresh.svg?react'
import Reload from './reload.svg?react'
import Single from './single.svg?react'
import Trash from './trash.svg?react'
import Unlock from './unlock.svg?react'
import VolumeDownFill from './volume-down-fill.svg?react'
import VolumeMuteFill from './volume-mute-fill.svg?react'
import VolumeUpFill from './volume-up-fill.svg?react'
import X from './x.svg?react'
import XCircle from './x-circle.svg?react'

export const icons = {
    add: Add,
    'arrow-bar-down': ArrowBarDown,
    'arrow-bar-up': ArrowBarUp,
    'arrow-down-short': ArrowDownShort,
    'arrow-down-up': ArrowDownUp,
    'arrow-up-short': ArrowUpShort,
    captions: Captions,
    'check-circle': CheckCircle,
    'check-lg': CheckLg,
    'chevron-left': ChevronLeft,
    'chevron-right': ChevronRight,
    clock: Clock,
    'clock-history': ClockHistory,
    code: Code,
    dash: Dash,
    download: Download,
    'exclamation-circle': ExclamationCircle,
    expand: Expand,
    folder: Folder,
    gear: Gear,
    heart: Heart,
    'heart-break': HeartBreak,
    'heart-fill': HeartFill,
    'info-circle': InfoCircle,
    'local-badge': LocalBadge,
    lock: Lock,
    loop: Loop,
    'music-note': MusicNote,
    'music-note-list': MusicNoteList,
    next: Next,
    'pause-fill': PauseFill,
    pencil: Pencil,
    play: Play,
    'play-add': PlayAdd,
    'play-fill': PlayFill,
    power: Power,
    prev: Prev,
    random: Random,
    refresh: Refresh,
    reload: Reload,
    single: Single,
    trash: Trash,
    unlock: Unlock,
    'volume-down-fill': VolumeDownFill,
    'volume-mute-fill': VolumeMuteFill,
    'volume-up-fill': VolumeUpFill,
    x: X,
    'x-circle': XCircle,
}

export type IconName = keyof typeof icons
