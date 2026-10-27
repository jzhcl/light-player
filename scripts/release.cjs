#!/usr/bin/env node
/**
 * 发布到 GitHub Releases。
 *
 * 用法：
 *   pnpm pack:win                                  # 先出产物（release/<version>/ 下应有 exe + blockmap + latest.yml）
 *   GH_TOKEN=xxx pnpm release                      # 发布：建 draft → 传 asset → publish
 *   GH_TOKEN=xxx pnpm release -- --dry-run         # 只校验并打印要传什么
 *   GH_TOKEN=xxx pnpm release -- --publish-only    # asset 已传好，只把 draft 改成发布态
 *
 * ⚠️ 重跑是幂等的：发现同名 tag 的 draft 就复用它、先删掉旧 asset 再重传。
 *   上传中断很常见，没有这条就得每次手动去网页删 draft。
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const PROJECT_DIR = path.resolve(__dirname, '..')
const API = 'https://api.github.com'
const USER_AGENT = 'light-player-release'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const publishOnly = argv.includes('--publish-only')
const notesFlag = argv.indexOf('--notes')
const notesArgFile = notesFlag >= 0 ? path.resolve(argv[notesFlag + 1]) : null

// 一个只看不发、一个只发不看，凑在一起语义矛盾
if (dryRun && publishOnly) {
    console.error('✗ --dry-run 和 --publish-only 不能同时用')
    process.exit(1)
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`
const die = (msg) => {
    console.error(`\n✗ ${msg}\n`)
    process.exit(1)
}

// ---------------------------------------------------------------- 读配置

const { version } = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'))

// owner / repo 以 electron-builder.yml 为唯一真相，避免两处配置漂移
const builderYml = fs.readFileSync(path.join(PROJECT_DIR, 'electron-builder.yml'), 'utf8')
const owner = builderYml.match(/^\s*owner:\s*(\S+)\s*$/m)?.[1]
const repo = builderYml.match(/^\s*repo:\s*(\S+)\s*$/m)?.[1]
if (!owner || !repo) die('electron-builder.yml 里缺 publish.owner / publish.repo')

const tag = `v${version}`

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token && !dryRun) {
    die(
        '缺少 GH_TOKEN。\n' +
            '  建一个 fine-grained PAT（仓库只给 Contents: Read and write），然后：\n' +
            '    set GH_TOKEN=github_pat_xxx    (cmd)\n' +
            '    $env:GH_TOKEN="github_pat_xxx" (powershell)',
    )
}

// ---------------------------------------------------------------- release notes

function collectNotes() {
    if (notesArgFile) return fs.readFileSync(notesArgFile, 'utf8').trim()

    const changelog = path.join(PROJECT_DIR, 'CHANGELOG.md')
    if (!fs.existsSync(changelog)) return null

    const lines = fs.readFileSync(changelog, 'utf8').split(/\r?\n/)
    const start = lines.findIndex((l) => /^##\s/.test(l) && l.includes(version))
    if (start < 0) return null

    let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
    if (end < 0) end = lines.length

    const body = lines
        .slice(start + 1, end)
        .join('\n')
        .trim()
    return body || null
}

// ---------------------------------------------------------------- 收集产物

/**
 * 只在「要上传」的路径上调用。--publish-only 不碰本地文件：
 * asset 已经在 draft 上了，这时候发布目录删了也不该失败。
 */
function collectAssets() {
    const outDir = path.join(PROJECT_DIR, 'release', version)
    if (!fs.existsSync(outDir)) {
        die(`产物目录不存在：${outDir}\n先跑 pnpm pack:win`)
    }

    const allNames = fs.readdirSync(outDir)
    // 三件套是配套的：exe 给新装用户，blockmap 给差分下载，latest.yml 是版本清单。
    // 少任何一件都不该发 —— 缺 latest.yml 客户端不会知道有新版本，缺 blockmap 每次都全量下载。
    const list = allNames
        .filter((n) => /\.exe$/i.test(n) || /\.blockmap$/i.test(n) || /^latest.*\.yml$/i.test(n))
        .map((n) => ({ name: n, file: path.join(outDir, n), size: fs.statSync(path.join(outDir, n)).size }))
        .sort((a, b) => a.size - b.size)

    if (list.length === 0) die(`release/${version}/ 里没有 exe / blockmap / latest.yml，先打包`)

    const ymlAsset = list.find((a) => /^latest.*\.yml$/i.test(a.name))
    if (!ymlAsset) die('缺 latest.yml —— publish 配置没生效，检查 electron-builder.yml 的 publish 段')

    const ymlText = fs.readFileSync(ymlAsset.file, 'utf8')
    const strip = (v) => v?.trim().replace(/^['"]|['"]$/g, '')

    const declaredVersion = strip(ymlText.match(/^version:\s*(.+)$/m)?.[1])
    if (declaredVersion !== version) {
        die(
            `latest.yml 里写着 version: ${declaredVersion}，package.json 是 ${version}。\n` +
                '产物和源码不匹配 —— 改过版本号后忘了重新打包？',
        )
    }

    const declaredPath = strip(ymlText.match(/^path:\s*(.+)$/m)?.[1])
    if (declaredPath && !allNames.includes(declaredPath)) {
        die(`latest.yml 指向 ${declaredPath}，但目录里没有这个文件`)
    }
    if (declaredPath && !/\.exe$/i.test(declaredPath)) {
        die(`latest.yml 的 path 是 ${declaredPath}，不是 .exe —— NSIS 客户端会下到错误的文件`)
    }

    return list
}

// ---------------------------------------------------------------- GitHub API

async function api(pathname, options = {}) {
    const res = await fetch(`${API}${pathname}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': USER_AGENT,
            ...options.headers,
        },
    })
    if (!res.ok) {
        const body = await res.text()
        throw new Error(`GitHub API ${res.status} ${options.method ?? 'GET'} ${pathname}\n${body.slice(0, 400)}`)
    }
    return res.status === 204 ? null : res.json()
}

/**
 * release 的 tag 必须指向一个真实 commit。空仓库时 PATCH 会 422，
 * 而那时 asset 已经传完 —— 所以提前查。空仓库的 /commits 返回 409。
 */
async function assertRepoHasCommits() {
    let commits
    try {
        commits = await api(`/repos/${owner}/${repo}/commits?per_page=1`)
    } catch (err) {
        if (/\b409\b|empty repository/i.test(String(err.message))) commits = []
        else throw err
    }
    if (!Array.isArray(commits) || commits.length === 0) {
        die(
            'GitHub 仓库还是空的 —— release 的 tag 必须指向一个 commit。\n' +
                '  先把代码推上去：\n' +
                '    git add -A && git commit -m "..."\n' +
                '    git push -u origin master\n' +
                '  再发布：pnpm release -- --publish-only（asset 已经在 draft 上，不用重传）',
        )
    }
}

/** 已有同名 tag 的 release：draft 就复用，正式发布过就拒绝 */
async function findRelease() {
    try {
        return await api(`/repos/${owner}/${repo}/releases/tags/${tag}`)
    } catch (err) {
        if (String(err.message).includes('404')) return null
        throw err
    }
}

async function createDraft(notes) {
    return api(`/repos/${owner}/${repo}/releases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            tag_name: tag,
            name: `LightPlayer ${tag}`,
            body: notes ?? `LightPlayer ${tag}`,
            draft: true,
            prerelease: false,
        }),
    })
}

async function deleteAsset(assetId) {
    await api(`/repos/${owner}/${repo}/releases/assets/${assetId}`, { method: 'DELETE' })
}

async function uploadAsset(uploadUrl, asset) {
    const url = `${uploadUrl.replace('{?name,label}', '')}?name=${encodeURIComponent(asset.name)}`
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/octet-stream',
            // 必须显式给长度：不给就转成 chunked，GitHub 的上传接口会拒
            'Content-Length': String(asset.size),
            'User-Agent': USER_AGENT,
        },
        body: fs.createReadStream(asset.file),
        // Node 18+ 流式请求体的硬要求
        duplex: 'half',
    })
    if (!res.ok) {
        const body = await res.text()
        throw new Error(`上传 ${asset.name} 失败：${res.status}\n${body.slice(0, 400)}`)
    }
}

/** 把 draft 改成正式发布 —— 到这一步客户端的 releases.atom 才能看见它 */
async function publishRelease(releaseId) {
    await api(`/repos/${owner}/${repo}/releases/${releaseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: false }),
    })
}

// ---------------------------------------------------------------- 主流程

function warnGitState() {
    try {
        const dirty = execFileSync('git', ['status', '--porcelain'], {
            cwd: PROJECT_DIR,
            encoding: 'utf8',
        })
        if (dirty.trim()) {
            console.warn('⚠️  工作区有未提交改动，发布出来的 tag 会指向旧的 commit（asset 不受影响）')
        }
    } catch {
        // 拿不到 git 状态不影响发布
    }
}

async function main() {
    console.log(`\n发布 ${owner}/${repo}  ${tag}\n`)

    if (publishOnly) {
        const existing = await findRelease()
        if (!existing) die(`没找到 ${tag} 的 draft —— 先正常跑一次 pnpm release`)
        if (!existing.draft) {
            console.log(`  v${version} 已经是发布状态，无需操作\n`)
            return
        }

        const count = existing.assets?.length ?? 0
        console.log(`  复用 draft（id=${existing.id}），已有 ${count} 个 asset`)
        // 0 个 asset 说明状态不对，别把一个没有安装包的版本发出去
        if (count === 0) die('这个 draft 里没有任何 asset —— 别发布，先正常跑一次 pnpm release')

        await assertRepoHasCommits()
        await publishRelease(existing.id)
        console.log(`\n✓ 已发布 https://github.com/${owner}/${repo}/releases/tag/${tag}\n`)
        return
    }

    const assets = collectAssets()
    const notes = collectNotes()
    if (!notes) {
        console.warn(`⚠️  CHANGELOG.md 里没找到 v${version} 的段落，release notes 用默认标题`)
    }

    console.log(`  产物目录  release/${version}/`)
    for (const a of assets) console.log(`    ${a.name}  ${mb(a.size)}`)
    console.log(`  notes     ${notes ? '来自 CHANGELOG.md / --notes' : '默认标题'}`)

    if (dryRun) {
        console.log('\n--dry-run：只校验，没有发出任何请求。\n')
        return
    }

    warnGitState()
    await assertRepoHasCommits()

    let release = await findRelease()
    if (release && !release.draft) {
        die(`v${version} 已经正式发布过了。改版本号重新打包，别再覆盖已发布的 release。`)
    }
    if (release) {
        console.log(`\n复用已有 draft（id=${release.id}），先清掉旧 asset`)
        for (const asset of release.assets ?? []) await deleteAsset(asset.id)
    } else {
        release = await createDraft(notes)
        console.log(`\n已创建 draft（id=${release.id}）`)
    }

    for (const asset of assets) {
        process.stdout.write(`  上传 ${asset.name} (${mb(asset.size)}) ... `)
        await uploadAsset(release.upload_url, asset)
        process.stdout.write('ok\n')
    }

    // 最后一步才让它对客户端可见
    await publishRelease(release.id)

    console.log(`\n✓ 已发布 https://github.com/${owner}/${repo}/releases/tag/${tag}\n`)
}

main().catch((err) => {
    console.error(`\n✗ ${err.message}\n`)
    console.error('若 draft 已建好但上传/发布中断，直接重跑本命令即可：')
    console.error('  中断在上传阶段 → pnpm release（复用 draft 覆盖 asset）')
    console.error('  中断在最后一步 → pnpm release -- --publish-only（不重传）\n')
    process.exit(1)
})
