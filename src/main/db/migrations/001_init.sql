-- ============================================================
-- 001_init.sql — 初始建表（数据库初始化）
-- ============================================================

-- 歌曲信息表
CREATE TABLE IF NOT EXISTS songs
(
    `id`                 TEXT PRIMARY KEY,                               -- 歌曲ID（唯一标识）
    `plugin_id`          TEXT NOT NULL,                                  -- 歌曲源ID
    `plugin_song_id`     TEXT NOT NULL,                                  -- 歌曲在源中的ID
    `name`               TEXT NOT NULL,                                  -- 歌曲名称（必填）
    `name_pinyin`        TEXT,                                           -- 歌曲名称拼音
    `album`              TEXT,                                           -- 专辑名称
    `album_pinyin`       TEXT,                                           -- 专辑名称拼音
    `singer`             TEXT NOT NULL,                                  -- 歌手（必填）
    `singer_pinyin`      TEXT,                                           -- 歌手拼音
    `pic`                TEXT,                                           -- 歌曲封面图片（JSON格式）
    `duration`           INTEGER DEFAULT 0,                              -- 歌曲时长（秒）
    `is_liked`           INTEGER DEFAULT 0,                              -- 是否喜欢（默认否）
    `download_qualities` TEXT,                                           -- 本地音质数组（JSON格式）
    `support_qualities`    TEXT,                                           -- 支持的音质列表（JSON格式）
    `meta`               TEXT,                                           -- 歌曲元数据（JSON格式）
    `created_at`         TEXT    DEFAULT (datetime('now', 'localtime')), -- 创建时间（默认当前时间）
    `updated_at`         TEXT    DEFAULT (datetime('now', 'localtime'))  -- 最后更新时间（默认当前时间）
);

-- 歌曲歌词表
CREATE TABLE IF NOT EXISTS song_lyrics
(
    `song_id`    TEXT PRIMARY KEY,                            -- 歌曲ID
    `lyric`      TEXT,                                        -- 歌词
    `klyric`     TEXT,                                        -- 卡拉ok式逐字歌词（JSON格式）
    `tlyric`     TEXT,                                        -- 翻译歌词
    `rlyric`     TEXT,                                        -- 罗马音歌词
    `created_at` TEXT DEFAULT (datetime('now', 'localtime')), -- 创建时间（默认当前时间）
    `updated_at` TEXT DEFAULT (datetime('now', 'localtime'))  -- 最后更新时间（默认当前时间）
);

-- 歌单表
CREATE TABLE IF NOT EXISTS playlists
(
    `id`          TEXT PRIMARY KEY,                            -- 歌单ID（唯一标识）
    `plugin_id`   TEXT NOT NULL,                               -- 歌单源ID
    `name`        TEXT NOT NULL,                               -- 歌单名称（必填）
    `description` TEXT,                                        -- 歌单描述（可选）
    `pic`         TEXT,                                        -- 歌单封面图片（JSON格式）
    `meta`        TEXT,                                        -- 歌单元数据（JSON格式）
    `created_at`  TEXT DEFAULT (datetime('now', 'localtime')), -- 创建时间（默认当前时间）
    `updated_at`  TEXT DEFAULT (datetime('now', 'localtime'))  -- 最后更新时间（默认当前时间）
);

-- 歌单歌曲关联表
CREATE TABLE IF NOT EXISTS playlist_songs
(
    `playlist_id` TEXT    NOT NULL,                            -- 歌单ID
    `song_id`     TEXT    NOT NULL,                            -- 歌曲ID
    `position`    INTEGER NOT NULL,                            -- 歌曲在歌单中的位置（从0开始）
    `added_at`    TEXT DEFAULT (datetime('now', 'localtime')), -- 添加时间（默认当前时间）
    PRIMARY KEY (playlist_id, song_id)                         -- 联合主键
);

-- 歌曲播放统计表
CREATE TABLE IF NOT EXISTS song_played_stats
(
    `song_id`        TEXT PRIMARY KEY,                              -- 歌曲ID（唯一标识）
    `played_count`   INTEGER DEFAULT 0,                             -- 累计播放次数（默认0）
    `last_played_at` TEXT    DEFAULT (datetime('now', 'localtime')) -- 最后播放时间（默认当前时间）
);

-- 应用设置表
CREATE TABLE IF NOT EXISTS main_settings
(
    `id`         TEXT PRIMARY KEY,                           -- 设置项ID
    `value`      TEXT,                                       -- 设置项值（JSON格式）
    `updated_at` TEXT DEFAULT (datetime('now', 'localtime')) -- 最后更新时间（默认当前时间）
);

-- 下载记录表
CREATE TABLE IF NOT EXISTS download_records
(
    `id`         TEXT PRIMARY KEY,                            -- 下载任务ID（唯一标识）
    `song_id`    TEXT,                                        -- 关联的歌曲ID
    `url`        TEXT,                                        -- 下载URL
    `file_path`  TEXT,                                        -- 保存路径
    `file_name`  TEXT,                                        -- 文件名
    `quality`    TEXT,                                        -- 音质
    `size`       TEXT,                                        -- 文件大小（字符串格式）
    `status`     TEXT DEFAULT 'waiting',                      -- 下载状态（waiting, downloading, paused, completed, failed）
    `scanned`    INTEGER NOT NULL DEFAULT 0,                  -- 启动残留清理标记
    `error`      TEXT,                                        -- 失败原因
    `progress`   REAL DEFAULT 0,                              -- 已下载进度（0~1）
    `created_at` TEXT DEFAULT (datetime('now', 'localtime')), -- 创建时间
    `updated_at` TEXT DEFAULT (datetime('now', 'localtime'))  -- 更新时间
);

-- 插件表
CREATE TABLE IF NOT EXISTS plugins
(
    `id`           TEXT PRIMARY KEY,            -- 插件ID
    `name`         TEXT NOT NULL,               -- 插件名称
    `version`      TEXT NOT NULL,               -- 插件版本
    `enabled`      INTEGER DEFAULT 1,           -- 是否启用
    `dir_path`     TEXT NOT NULL,               -- 插件目录路径
    `manifest`     TEXT NOT NULL,               -- plugin.json 完整内容（JSON）
    `config`       TEXT    DEFAULT '{}',        -- 命令与 Provider 的启停配置（JSON格式）
    `state`        TEXT    DEFAULT 'installed', -- 生命周期状态
    `error`        TEXT,                        -- 激活/运行错误信息
    `installed_at` TEXT,                        -- 安装时间
    `updated_at`   TEXT                         -- 更新时间
);

-- 插件存储表（lp.storage API 的持久化）
CREATE TABLE IF NOT EXISTS plugin_storage
(
    `plugin_id` TEXT NOT NULL, -- 插件ID
    `key`       TEXT NOT NULL, -- 键名
    `value`     TEXT,          -- 值（JSON序列化）
    PRIMARY KEY (plugin_id, key),
    FOREIGN KEY (plugin_id) REFERENCES plugins (id) ON DELETE CASCADE
);

-- ============================================================
-- 索引
-- ============================================================

-- 歌曲表索引
CREATE INDEX IF NOT EXISTS idx_songs_name ON songs (name, name_pinyin);
CREATE INDEX IF NOT EXISTS idx_songs_singer ON songs (singer, singer_pinyin);
CREATE INDEX IF NOT EXISTS idx_songs_album ON songs (album, album_pinyin);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_songs_plugin_info ON songs (plugin_id, plugin_song_id);
CREATE INDEX IF NOT EXISTS idx_songs_full_search ON songs (name, name_pinyin, singer, singer_pinyin, album, album_pinyin);

-- 歌曲歌词表索引
CREATE INDEX IF NOT EXISTS idx_song_lyrics_song_id ON song_lyrics (song_id);

-- 歌单表索引
CREATE INDEX IF NOT EXISTS idx_playlists_plugin_id ON playlists (plugin_id);

-- 歌单歌曲关联表索引
CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist_id ON playlist_songs (playlist_id);
CREATE INDEX IF NOT EXISTS idx_playlist_songs_song_id ON playlist_songs (song_id);
CREATE INDEX IF NOT EXISTS idx_playlist_songs_position ON playlist_songs (position);

-- 歌曲播放统计表索引
CREATE INDEX IF NOT EXISTS idx_song_played_stats_song_id ON song_played_stats (song_id);
CREATE INDEX IF NOT EXISTS idx_song_played_stats_played_count ON song_played_stats (played_count);
CREATE INDEX IF NOT EXISTS idx_song_played_stats_last_played_at ON song_played_stats (last_played_at);

-- 应用设置表索引
CREATE INDEX IF NOT EXISTS idx_main_settings_id ON main_settings (id);

-- 下载记录表索引
CREATE INDEX IF NOT EXISTS idx_download_records_song_id ON download_records (song_id);
CREATE INDEX IF NOT EXISTS idx_download_records_status ON download_records (status);
CREATE INDEX IF NOT EXISTS idx_download_records_scanned ON download_records (scanned);

-- ============================================================
-- 触发器：更新记录时自动维护 updated_at / last_played_at
-- ============================================================

-- 歌曲表更新触发器
CREATE TRIGGER IF NOT EXISTS update_songs_time
    AFTER UPDATE
    ON songs
    FOR EACH ROW
BEGIN
    UPDATE songs SET updated_at = datetime('now', 'localtime') WHERE id = OLD.id;
END;

-- 歌曲歌词表更新触发器
CREATE TRIGGER IF NOT EXISTS update_song_lyrics_time
    AFTER UPDATE
    ON song_lyrics
    FOR EACH ROW
BEGIN
    UPDATE song_lyrics SET updated_at = datetime('now', 'localtime') WHERE song_id = OLD.song_id;
END;

-- 歌单表更新触发器
CREATE TRIGGER IF NOT EXISTS update_playlists_time
    AFTER UPDATE
    ON playlists
    FOR EACH ROW
BEGIN
    UPDATE playlists SET updated_at = datetime('now', 'localtime') WHERE id = OLD.id;
END;

-- 应用设置表更新触发器
CREATE TRIGGER IF NOT EXISTS update_main_settings_time
    AFTER UPDATE
    ON main_settings
    FOR EACH ROW
BEGIN
    UPDATE main_settings SET updated_at = datetime('now', 'localtime') WHERE id = OLD.id;
END;

-- 歌曲播放统计表更新触发器（更新最后播放时间）
CREATE TRIGGER IF NOT EXISTS update_song_played_stats_time
    AFTER UPDATE
    ON song_played_stats
    FOR EACH ROW
BEGIN
    UPDATE song_played_stats SET last_played_at = datetime('now', 'localtime') WHERE song_id = OLD.song_id;
END;

-- 下载记录表更新触发器
CREATE TRIGGER IF NOT EXISTS update_download_records_time
    AFTER UPDATE
    ON download_records
    FOR EACH ROW
BEGIN
    UPDATE download_records SET updated_at = datetime('now', 'localtime') WHERE id = OLD.id;
END;

-- 插件表更新触发器
CREATE TRIGGER IF NOT EXISTS trg_plugins_updated_at
    AFTER UPDATE
    ON plugins
    FOR EACH ROW
BEGIN
    UPDATE plugins SET updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime') WHERE id = NEW.id;
END;
