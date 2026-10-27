#!/usr/bin/env node
/**
 * 打包后收尾：把 release/<version>/ 里只留「能直接发给用户的东西」。
 *
 * 留下的：
 *   *.exe                         NSIS 安装包
 *   *.blockmap                    差分更新的块索引（electron-updater 靠它只下变化的部分）
 *   latest*.yml                   更新源清单
 *
 * 删掉的（electron-builder 的中间产物 / 调试文件，对它自己之外的任何人都没用）：
 *   win-unpacked/            解包目录，installer 用完就没价值了（--keep-unpacked 可保留）
 *   .icon-ico/               png → ico 转换的临时目录
 *   builder-debug.yml        构建期 debug 记录
 *   builder-effective-config.yaml  合并后的配置快照
 *
 * 以后要加 zip / msi，记得在 KEEP_EXT 里补扩展名，否则新产物会被当成垃圾删掉。
 */
const fs = require('node:fs')
const path = require('node:path')

const KEEP_EXT = new Set(['.exe', '.blockmap'])
const KEEP_UPDATE_META = /^latest.*\.yml$/
const DROP_ROOTS = ['win-unpacked', '.icon-ico']
const DROP_FILES = ['builder-debug.yml', 'builder-effective-config.yaml']

const keepUnpacked = process.argv.includes('--keep-unpacked')

const projectDir = path.resolve(__dirname, '..')
const { version } = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
const outDir = path.join(projectDir, 'release', version)

if (!fs.existsSync(outDir)) {
    console.error(`[clean-release] 目录不存在，跳过：${outDir}`)
    process.exit(0)
}

/** 删 win-unpacked 之前把 app-update.yml 打出来 */
function reportAppUpdateYml() {
    const file = path.join(outDir, 'win-unpacked', 'resources', 'app-update.yml')
    if (!fs.existsSync(file)) {
        console.warn('[clean-release] ⚠️  包里没有 app-update.yml —— publish 没生效，自动更新不会工作')
        return
    }
    console.log('[clean-release] app-update.yml（已打进安装包）：')
    for (const line of fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)) {
        console.log(`    ${line}`)
    }
}

const removed = []
const kept = []

if (fs.existsSync(path.join(outDir, 'win-unpacked'))) reportAppUpdateYml()

for (const name of fs.readdirSync(outDir)) {
    const full = path.join(outDir, name)
    const stat = fs.statSync(full)
    const ext = path.extname(name).toLowerCase()

    let drop = false
    if (stat.isDirectory()) drop = !(keepUnpacked && DROP_ROOTS[0] === name) && DROP_ROOTS.includes(name)
    else if (DROP_FILES.includes(name)) drop = true
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
