import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import svgr from 'vite-plugin-svgr'
import electron from 'vite-plugin-electron'
import { fileURLToPath, URL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))

const alias = {
    '@main': fileURLToPath(new URL('./src/main', import.meta.url)),
    '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    '@assets': fileURLToPath(new URL('./src/shared/assets', import.meta.url))
}

// ============================================================
// 构建信息注入（关于页要显示「代码版本 / 提交日期」）
// 打包后的应用里没有 .git，所以只能在构建期把值烤进产物。
// ============================================================

function viaGit(args: string[]): string | null {
    try {
        return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim() || null
    } catch {
        return null
    }
}

/**
 * 退化路径：解析 .git/logs/HEAD 的 reflog 末行。
 * 格式 `<old> <new> <name> <<email>> <unix秒> <±hhmm>\t<动作>` —— 末行的 new 就是当前 HEAD。
 * 存在的意义是一些受限环境里 child_process 完全不可用，但这两处的答案一样准。
 */
function viaReflog(): { commit: string; date: string } | null {
    const file = join(ROOT, '.git', 'logs', 'HEAD')
    if (!existsSync(file)) return null

    const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/)
    const parts = (lines[lines.length - 1] ?? '').split('\t')[0].trim().split(' ')
    const tz = parts.pop()
    const ts = parts.pop()
    const hash = parts[1]

    if (!hash || !ts || !/^\d+$/.test(ts)) return null
    // 用全量 hash
    return { commit: hash, date: new Date(Number(ts) * 1000).toISOString() }
}

function readGitInfo(): { commit: string; date: string } {
    const commit = viaGit(['rev-parse', 'HEAD'])
    const date = viaGit(['log', '-1', '--format=%cI'])
    if (commit) return { commit, date: date ?? '' }
    return viaReflog() ?? { commit: 'unknown', date: '' }
}

/** owner/repo 以 electron-builder.yml 为唯一真相，别在代码里第二处硬编码 */
function readRepo(): { owner: string; repo: string } {
    try {
        const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
        return {
            owner: yml.match(/^\s*owner:\s*(\S+)\s*$/m)?.[1] ?? '',
            repo: yml.match(/^\s*repo:\s*(\S+)\s*$/m)?.[1] ?? '',
        }
    } catch {
        return { owner: '', repo: '' }
    }
}

const git = readGitInfo()
const repo = readRepo()
console.log(`[build] 构建信息 commit=${git.commit} date=${git.date || '(空)'} repo=${repo.owner}/${repo.repo}`)

/** 构建期常量 */
const buildDefines = {
    __APP_COMMIT__: JSON.stringify(git.commit),
    __APP_COMMIT_DATE__: JSON.stringify(git.date),
    __APP_REPO_OWNER__: JSON.stringify(repo.owner),
    __APP_REPO_NAME__: JSON.stringify(repo.repo),
}

export default defineConfig({
    resolve: {
        alias,
    },
    define: buildDefines,
    plugins: [
        react({ compiler: true }),
        svgr(),
        electron([
            {
                entry: 'src/main/main.ts',
                vite: {
                    resolve: { alias },
                    define: buildDefines,
                    build: {
                        outDir: 'dist/main',
                        rollupOptions: {
                            external: ['node:sqlite']
                        },
                    },
                },
            },
            {
                entry: 'src/preload/index.ts',
                vite: {
                    resolve: { alias },
                    build: {
                        outDir: 'dist/preload',
                        rollupOptions: {
                            external: ['electron']
                        },
                    },
                },
            }
        ]),
    ],
    build: {
        rollupOptions: {
            input: {
                main: fileURLToPath(new URL('index.html', import.meta.url)),
                lyric: fileURLToPath(new URL('lyric.html', import.meta.url)),
                trayMenu: fileURLToPath(new URL('tray-menu.html', import.meta.url)),
            },
        },
    },
})
