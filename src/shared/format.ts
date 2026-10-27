const numFix = (n: number): string => n < 10 ? (`0${n}`) : n.toString()

/**
 * 格式化播放时间，返回 mm:ss 格式字符串
 * @param time 秒数
 *
 * @example
 * formatPlayTime(125) // '02:05'
 */
export const formatPlayTime = (time: number): string => {
    let m = Math.trunc(time / 60)
    let s = Math.trunc(time % 60)
    return numFix(m) + ':' + numFix(s)
}

/**
 * 格式化时长，返回 "X小时Y分钟" 或 "Y分钟" 格式字符串
 * @param seconds 秒数
 *
 * @example
 * formatDuration(3661) // '1小时1分钟'
 * formatDuration(61) // '1分钟'
 */
export const formatDuration = (seconds: number): string => {
    if (seconds < 60) return '不到1分钟'
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (hours > 0) {
        return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`
    }
    return `${minutes}分钟`
}

/**
 * 格式化字节大小为可读字符串，或原样返回已经是格式化后的字符串
 * @param {number | string} size 输入的字节大小（数字）或已经格式化的字符串（如 "3.13 MB"）
 * @param {number} [decimalPlaces = 2] 保留的小数位数，默认为 2
 * @returns {string} 格式化后的字符串，如 "1.23 MB"；如果输入已经是格式化字符串，则原样返回
 *
 * @example
 * sizeFormat(1024); // "1.00 KB"
 * sizeFormat(1024 * 1024 * 2.5); // "2.50 MB"
 * sizeFormat("3.13 MB"); // "3.13 MB" （原样返回）
 * sizeFormat(1099511627776); // "1.00 TB"
 * sizeFormat(1500, 0); // "1.00 KB" 或根据参数为 "1 KB"
 */
export const formatSize = (size: number | string, decimalPlaces: number = 2): string => {
    // 如果输入是字符串，尝试判断它是不是已经格式化好的（如 "3.13 MB"）
    if (typeof size === 'string') {
        // 简单启发式判断：是否包含空格且后一部分是常见单位
        const spaceIndex = size.lastIndexOf(' ');
        if (spaceIndex > 0) {
            const numPart = size.slice(0, spaceIndex).trim();
            const unitPart = size.slice(spaceIndex + 1).trim();

            // 判断数字部分是否为合法数字，单位部分是否为已知单位
            const numValid = !isNaN(Number(numPart)) && !isNaN(parseFloat(numPart));
            const shortUnits = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
            const longUnits = ['Byte', 'Bytes', 'Kilobyte', 'Megabyte', 'Gigabyte', 'Terabyte', 'Petabyte'];

            const unit = unitPart.toUpperCase(); // 统一转大写比较
            const isShortUnitValid = shortUnits.includes(unit as any);
            const isLongUnitValid = longUnits.some(u => u.toLowerCase() === unitPart.toLowerCase());

            // 如果数字合法，且单位是已知单位之一，我们认为这已经是格式化好的字符串
            if (numValid && (isShortUnitValid || isLongUnitValid)) {
                return size; // 原样返回，不做二次格式化
            }
        }

        // 其他情况，无法判定为格式化字符串，尝试按数字解析（不推荐，但为了健壮性可后续扩展）
    }

    // 如果是数字，则进行格式化
    if (typeof size === 'number') {
        if (size < 0) return '0 B'; // 不支持负数

        const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        let bytes = size;
        let unitIndex = 0;

        while (bytes >= 1024 && unitIndex < units.length - 1) {
            bytes /= 1024;
            unitIndex++;
        }

        const formattedNumber = bytes.toFixed(decimalPlaces);
        // 可选：去掉末尾无意义的 .00，比如 1.00 KB -> 1 KB（可选功能，当前保留 decimalPlaces）
        return `${formattedNumber} ${units[unitIndex]}`;
    }

    // 兜底：如果输入既不是数字也不是可识别的格式化字符串，返回原始值或默认值
    return size;
}

/**
 * 格式化日期时间字符串
 *
 * @param {number | string | Date} [value = Date.now()] 待格式化的日期时间值，支持数字、字符串和 Date 类型，默认为当前时间戳
 * @param {string} [format = 'YYYY-MM-DD HH:mm:ss'] 格式化字符串，默认为'YYYY-MM-DD HH:mm:ss'，支持格式化参数：YY：年，M：月，D：日，H：时，m：分钟，s：秒，SSS：毫秒
 * @returns {string} 返回格式化后的日期时间字符串
 */
export const formatDate = (value: number | string | Date = Date.now(), format: string = 'YYYY-MM-DD HH:mm:ss'): string => {
    try {
        let date: Date
        if (typeof value === 'number' || typeof value === 'string') {
            date = new Date(value)
            if (isNaN(date.getTime())) {
                return ''
            }
        } else {
            date = value
        }
        const padZero = (value: number, len: number = 2): string => {
            // 左侧补零函数
            return String(value).padStart(len, '0')
        }
        const replacement = (match: string) => {
            switch (match) {
                case 'YYYY':
                    return padZero(date.getFullYear())
                case 'YY':
                    return padZero(date.getFullYear()).slice(2, 4)
                case 'MM':
                    return padZero(date.getMonth() + 1)
                case 'M':
                    return String(date.getMonth() + 1)
                case 'DD':
                    return padZero(date.getDate())
                case 'D':
                    return String(date.getDate())
                case 'HH':
                    return padZero(date.getHours())
                case 'H':
                    return String(date.getHours())
                case 'mm':
                    return padZero(date.getMinutes())
                case 'm':
                    return String(date.getMinutes())
                case 'ss':
                    return padZero(date.getSeconds())
                case 's':
                    return String(date.getSeconds())
                case 'SSS':
                    return padZero(date.getMilliseconds(), 3)
                default:
                    return match
            }
        }
        return format.replace(/(YYYY|YY|M{1,2}|D{1,2}|H{1,2}|m{1,2}|s{1,2}|SSS)/g, replacement)
    } catch (error) {
        return ''
    }
}

/**
 * 格式化路径字符串
 * 功能：
 * 1. 将反斜杠统一转换为正斜杠
 * 2. 移除连续的多个斜杠
 * 3. 移除末尾的斜杠（可选）
 * 4. 处理相对路径（如 ./ 和 ../）
 *
 * @param {string} path 待格式化的路径
 * @param {boolean} [removeTrailingSlash = true] 是否移除末尾斜杠，默认为 true
 * @returns {string} 格式化后的路径
 *
 * @example
 * formatPath('C:\\Users\\test\\file.txt') // 'C:/Users/test/file.txt'
 * formatPath('path//to//file/') // 'path/to/file'
 * formatPath('./src/../src/interaction') // 'src/interaction'
 * formatPath('/var/www/html/', false) // '/var/www/html/'
 */
export const formatPath = (path: string, removeTrailingSlash: boolean = true): string => {
    if (!path) {
        return path || ''
    }

    try {
        let formattedPath = path

        // 1. 统一斜杠方向：将反斜杠转换为正斜杠
        formattedPath = formattedPath.replace(/\\/g, '/')

        // 2. 移除连续的多个斜杠（保留开头的双斜杠，如网络路径 //server/path）
        if (formattedPath.startsWith('//')) {
            formattedPath = '//' + formattedPath.slice(2).replace(/\/+/g, '/')
        } else {
            formattedPath = formattedPath.replace(/\/+/g, '/')
        }

        // 3. 处理相对路径
        const parts = formattedPath.split('/')
        const resultParts: string[] = []

        for (const part of parts) {
            if (part === '..') {
                // 上级目录：弹出最后一个有效部分
                if (resultParts.length > 0 && resultParts[resultParts.length - 1] !== '..') {
                    resultParts.pop()
                } else {
                    resultParts.push('..')
                }
            } else if (part === '.' || part === '') {
                // 当前目录或空部分：跳过，但保留开头的空部分（表示根目录）
                if (part === '' && resultParts.length === 0) {
                    resultParts.push('')
                }
            } else {
                resultParts.push(part)
            }
        }

        formattedPath = resultParts.join('/')

        // 4. 处理末尾斜杠
        if (removeTrailingSlash && formattedPath.endsWith('/') && formattedPath.length > 1) {
            formattedPath = formattedPath.slice(0, -1)
        }

        // 5. 特殊处理：根目录保持为单个斜杠
        if (formattedPath === '') {
            formattedPath = '/'
        }

        return formattedPath
    } catch (error) {
        return path
    }
}

/**
 * 音频质量格式化函数
 * 根据音频的技术参数（比特率、采样率、位深度、编码格式等）判断并返回对应的音质等级
 * 质量等级优先级：Master > Hi-Res > SQ > HQ > Standard
 *
 * @param {Object} option 音频参数对象
 * @param {number} [option.br=0] 比特率（bitrate），单位：bps
 * @param {number} [option.sr=0] 采样率（sample rate），单位：Hz
 * @param {number} [option.bd=0] 位深度（bit depth），单位：bit
 * @param {string} [option.codec=''] 编码格式（如 'MP3', 'FLAC', 'E-AC-3' 等）
 * @param {string} [option.format=''] 音频格式（如 'MP3', 'FLAC', 'WAV' 等）
 * @param {any} [option.metadata={}] 音频元数据，用于高级音质检测
 * @returns {Quality} 音质等级字符串
 *
 * @example
 * formatQuality({ br: 320000, sr: 44100, format: 'MP3' }) // 'HQ'
 * formatQuality({ br: 1411200, sr: 96000, bd: 24, format: 'FLAC' }) // 'Master'
 */
export const formatQuality = (option: {
    br?: number;    // 比特率
    sr?: number;    // 采样率
    bd?: number; // 位深度
    codec?: string;   // 编码格式
    format?: string; // 音频格式
    metadata?: any;
}): Quality => {
    const {
        br = 0,
        sr = 0,
        bd = 0,
        codec = '',
        format = '',
        metadata = {}
    } = option;


    const isLossless = (): boolean => {
        const losslessFormats = ['FLAC', 'ALAC', 'WAV', 'AIFF', 'APE', 'PCM'];
        const combinedFormat = (format || codec).toUpperCase();
        const highBitrateThreshold = 500; // 近似无损的比特率阈值

        // 如果是无损格式
        if (losslessFormats.some(f => combinedFormat.includes(f))) {
            return true;
        }

        // 或者极高比特率(近似无损)
        return br >= highBitrateThreshold;
    };

    // 无损音质判断 - 优先检查
    if (isLossless()) {
        // 母带级通常需要极高采样率和位深度
        if (sr >= 96000 && bd >= 24) {
            return 'Master';
        }
        // 高解析度音频标准
        if (sr > 44100 || bd > 16) {
            return 'Hi-Res';
        }
        // 标准无损 (CD音质)
        return 'SQ';
    }

    // 有损音质判断
    if (br >= 256000 || (br >= 192000 && sr >= 44100)) {
        return 'HQ';
    }

    // 默认标准音质
    return 'Standard';
}

/** 音质档位的中文展示名 */
const QUALITY_LABELS: Record<Quality, string> = {
    Standard: '标准',
    HQ: '高品HQ',
    SQ: '无损SQ',
    'Hi-Res': '高解析Hi-Res',
    Master: '母带Master',
}

/**
 * 音质档位的中文展示名：列表音质标签、控制栏当前音质、设置项选项文案共用这一份。
 * 未收录的档位原样返回（兼容插件给出的未知值）。
 */
export const qualityLabel = (q: Quality): string => QUALITY_LABELS[q] ?? q

/**
 * 音质档位的短展示名：「标准」保留中文，其余只用品类缩写
 */
export const qualityShortLabel = (q: Quality): string => (q === 'Standard' ? QUALITY_LABELS.Standard : q)