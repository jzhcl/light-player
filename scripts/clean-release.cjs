#!/usr/bin/env node
/**
 * 打包后收尾：把 release/<version>/ 里只留「能直接发给用户的东西」。
 *
 * 留下的：
 *   *.exe                         NSIS 安装包
 *   *.dmg                         mac 安装镜像（拖进「应用程序」）
 *   *.zip                         mac 自动更新的载体（Squirrel.Mac 只认 zip，dmg 不参与更新）
 *   *.blockmap                    差分更新的块索引（electron-updater 靠它只下变化的部分）
 *   latest*.yml                   更新源清单（latest.yml / latest-mac.yml）
 *
 * 删掉的（electron-builder 的中间产物 / 调试文件，对它自己之外的任何人都没用）：
 *   win-unpacked/            解包目录，installer 用完就没价值了（--keep-unpacked 可保留）
 *   mac-arm64/ mac-universal/   mac 的解包目录，同理
 *   .icon-ico/ .icon-icns/   png → ico / icns 转换的临时目录
 *   builder-debug.yml        构建期 debug 记录
 *   builder-effective-config.yaml  合并后的配置快照
 *
 * 以后要加新 target，记得在 KEEP_EXT 里补扩展名，否则新产物会被当成垃圾删掉。
 */
const fs = require('node:fs')
const path = require('node:path')

const KEEP_EXT = new Set(['.exe', '.blockmap', '.dmg', '.zip'])
const KEEP_UPDATE_META = /^latest.*\.yml$/
const DROP_ROOTS = ['win-unpacked', 'mac', 'mac-arm64', 'mac-x64', 'mac-universal']
const DROP_ROOTS_EXTRA = ['.icon-ico', '.icon-icns']
const DROP_FILES = ['builder-debug.yml', 'builder-effective-config.yaml']

const keepUnpacked = process.argv.includes('--keep-unpacked')

const projectDir = path.resolve(__dirname, '..')
const { version } = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
const outDir = path.join(projectDir, 'release', version)

if (!fs.existsSync(outDir)) {
    console.error(`[clean-release] 目录不存在，跳过：${outDir}`)
    process.exit(0)
}

/** 删解包目录之前把 app-update.yml 打出来：它是「publish 有没有生效」的唯一证据 */
function reportAppUpdateYml(dirName) {
    const base = path.join(outDir, dirName)
    // win 是 resources/，mac 是 <ProductName>.app/Contents/Resources/
    const candidates = [path.join(base, 'resources', 'app-update.yml')]
    for (const entry of fs.readdirSync(base)) {
        if (entry.endsWith('.app')) {
            candidates.push(path.join(base, entry, 'Contents', 'Resources', 'app-update.yml'))
        }
    }
    const file = candidates.find((f) => fs.existsSync(f))
    if (!file) {
        console.warn(`[clean-release] ⚠️  ${dirName} 里没有 app-update.yml —— publish 没生效，自动更新不会工作`)
        return
    }
    console.log(`[clean-release] app-update.yml（${dirName}，已打进包）：`)
    for (const line of fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)) {
        console.log(`    ${line}`)
    }
}

const removed = []
const kept = []

for (const dirName of DROP_ROOTS) {
    if (fs.existsSync(path.join(outDir, dirName))) reportAppUpdateYml(dirName)
}

for (const name of fs.readdirSync(outDir)) {
    const full = path.join(outDir, name)
    const stat = fs.statSync(full)
    const ext = path.extname(name).toLowerCase()

    let drop = false
    if (stat.isDirectory()) {
        const disposable = DROP_ROOTS.includes(name) || DROP_ROOTS_EXTRA.includes(name)
        // --keep-unpacked 只对解包目录生效，图标临时目录照删
        drop = disposable && !(keepUnpacked && /unpacked/.test(name))
    } else if (DROP_FILES.includes(name)) drop = true
    else drop = !KEEP_EXT.has(ext) && !KEEP_UPDATE_META.test(name)

    if (drop) {
        fs.rmSync(full, { recursive: true, force: true })
        removed.push(name)
    } else {
        kept.push([name, stat.size])
    }
}

const mb = n => `${(n / 1048576).toFixed(1)} MB`
for (const name of removed) console.log(`[clean-release] 删除  ${name}`)
for (const [name, size] of kept) console.log(`[clean-release] 保留  ${name}  ${mb(size)}`)
console.log(
    kept.length > 0
        ? `[clean-release] 完成：${kept.length} 个产物，合计 ${mb(kept.reduce((a, [, s]) => a + s, 0))}`
        : '[clean-release] 完成：没有产物（构建可能失败了）',
)
