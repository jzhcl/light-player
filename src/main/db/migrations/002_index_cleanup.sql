-- ============================================================
-- 002_index_cleanup.sql — 清理 001 中重复 / 无效的索引
-- ============================================================
-- 背景：001_init.sql 里有一批索引与 PRIMARY KEY / UNIQUE 自动生成的隐式索引
--      （sqlite_autoindex_*）完全同列，或与另一个索引的最左前缀重复。


-- 1) song_lyrics.song_id 已是 PRIMARY KEY ⇒ 隐式 sqlite_autoindex_song_lyrics_1 同列
DROP INDEX IF EXISTS idx_song_lyrics_song_id;

-- 2) song_played_stats.song_id 已是 PRIMARY KEY ⇒ 隐式 sqlite_autoindex_song_played_stats_1 同列
DROP INDEX IF EXISTS idx_song_played_stats_song_id;

-- 3) main_settings.id 已是 PRIMARY KEY ⇒ 隐式 sqlite_autoindex_main_settings_1 同列
DROP INDEX IF EXISTS idx_main_settings_id;

-- 4) idx_songs_name (name, name_pinyin) 是 idx_songs_full_search 的最左前缀
DROP INDEX IF EXISTS idx_songs_name;

-- 5) playlist_songs：
--    主键是 (playlist_id, song_id)，隐式索引的最左前缀就是 playlist_id ⇒ 单列 playlist_id 索引重复；
--    而 (position) 单列索引没有任何查询能用到（position 从不单独作为过滤条件）。
--    替换为 (playlist_id, position)：
--      getPlaylistSongs 的 `WHERE playlist_id = ? ORDER BY position` 可省掉 TEMP B-TREE 排序；
--      addSongToPlaylist / removeSongFromPlaylist 的 position 区间 UPDATE 也走它。
DROP INDEX IF EXISTS idx_playlist_songs_playlist_id;
DROP INDEX IF EXISTS idx_playlist_songs_position;
CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist_position ON playlist_songs (playlist_id, position);
