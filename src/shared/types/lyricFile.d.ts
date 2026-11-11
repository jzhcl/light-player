declare namespace LP {
    /**
     * `<userData>/download_lyric/` 下的歌词文件 —— LightPlayer 私有格式。
     *
     * 写入时机：下载完成、且设置项 `download.saveLyricFile` 打开。
     * 文件名 = 音频文件名去掉音质后缀，所以同一首歌的多个音质共用一份；
     * 也因此文件里刻意不写歌曲 id —— 它与歌曲行解耦，谁拿着音频路径谁就能读到。
     *
     * 存在的意义：插件歌被从曲库删掉、之后以本地歌身份重新加入时，
     * 仍然能拿回逐字 / 翻译 / 罗马音，而内嵌在音频文件里的只有原文 LRC。
     */
    interface LyricFile {
        /** 歌名（仅供人看，不参与匹配） */
        name?: string
        singer?: string
        album?: string
        /** lrc 格式歌词文本 */
        lyric: string
        /** 翻译歌词文本 */
        tlyric?: string
        /** 卡拉 OK 逐字歌词 */
        klyric?: KrcLine[]
        /** 罗马音歌词：lrc 文本 或 与 klyric 对应的逐字 */
        rlyric?: string | KrcLine[]
    }
}
