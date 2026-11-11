-- ============================================================
-- 003_song_pic_to_url.sql — songs.pic 从 JSON({url,path}) 收敛成单个地址
-- ============================================================
-- 背景：插件歌的封面不再落盘，
--       `url` 与 `path` 不再同时存在，「一个可直接渲染的地址」就够了。
--       JSON 让两列语义混在一起：本地歌是 `{url:'', path}`、插件歌是 `{url, path}`，
--       空值判断散落在各处，改成字符串后只按 scheme 区分：
--         http(s):// → 远程（插件歌）
--         file://    → 本地抽出的内嵌图（本地歌）
--         ''         → 确认没有封面（终态）
--         NULL       → 还没试过
--
-- 顺序：先取 url，再取 path，最后把「两样都空」的 JSON 清成 NULL。

-- 1) 有在线地址 → 直接用（插件歌）
UPDATE songs
SET pic = json_extract(pic, '$.url')
WHERE pic IS NOT NULL
  AND json_valid(pic)
  AND COALESCE(json_extract(pic, '$.url'), '') <> '';

-- 2) 没有在线地址、有本地路径 → 转 file:// 地址（本地歌）
--    路径统一用正斜杠存；`C:/a/b.jpg` → `file:///C:/a/b.jpg`
UPDATE songs
SET pic = 'file:///' || ltrim(replace(json_extract(pic, '$.path'), '\', '/'), '/')
WHERE pic IS NOT NULL
  AND json_valid(pic)
  AND COALESCE(json_extract(pic, '$.url'), '') = ''
  AND COALESCE(json_extract(pic, '$.path'), '') <> '';

-- 3) 剩下的 JSON（url 与 path 都为空）→ NULL：交给封面管道重新试一次
UPDATE songs
SET pic = NULL
WHERE pic IS NOT NULL
  AND json_valid(pic);

-- 4) 空串统一成 NULL（上一步之后理论上不会再有，防手工写入的脏数据）
UPDATE songs
SET pic = NULL
WHERE pic = '';
