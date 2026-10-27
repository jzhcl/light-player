import { dbCreate, dbDelete, dbFind, dbUpdate } from './base'


/** 按歌曲 ID 查询歌词 */
export async function getSongLyricBySongId(songId: string): Promise<Result<LP.SongLyric | null>> {
    return dbFind<LP.SongLyric>('song_lyrics', { songId })
}

/** 新建歌词 */
export async function createSongLyric(
    lyric: Omit<LP.SongLyric, 'createdAt' | 'updatedAt'>,
): Promise<Result<boolean>> {
    return dbCreate('song_lyrics', { ...lyric })
}

/** 更新歌词 */
export async function updateSongLyric(songId: string, data: Partial<LP.SongLyric>): Promise<Result<boolean>> {
    return dbUpdate('song_lyrics', { songId }, { ...data })
}

/** 删除歌词，返回删除行数 */
export async function deleteSongLyric(songId: string): Promise<Result<number>> {
    return dbDelete('song_lyrics', { songId })
}
