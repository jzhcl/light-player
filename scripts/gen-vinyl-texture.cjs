/**
 * 生成唱盘的「划痕反光」纹理。
 *
 *   node_modules/electron/dist/electron.exe scripts/gen-vinyl-texture.cjs
 *
 * 产物：src/renderer/styles/assets/vinyl-scratch.png —— 透明底 + 白色细弧，
 *       主题侧用 `mix-blend-mode: screen` 叠到黑盘上，就是"发亮的划痕"而不是墨线。
 *
 * 参数都在下面的 CONFIG 里，改完重跑即可。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CONFIG = {
    /** 画布边长（纹理是正方形，铺满整个盘的盒子） */
    size: 1024,
    /** 固定种子：图案可复现 */
    seed: 20261017,
    /** 弧的圈数（每圈再切 1~4 段） */
    rings: 900,
    /** 径向范围：占盘半径的比例 —— 封面圆窗是 0.52，所以从 0.52 起 */
    rMin: 0.52,
    rMax: 0.97,
    /** 弧段长度（rad） */
    lenMin: 0.10,
    lenMax: 0.65,
    /** 线宽（px，1024 画布上） */
    lwMin: 0.6,
    lwMax: 1.7,
    /** 单段基础 alpha 的上限（再乘角向权重） */
    alphaMax: 0.30,
}

const OUT = path.join(__dirname, '..', 'src', 'renderer', 'styles', 'assets', 'vinyl-scratch.png')

/** 在页面里跑的生成代码（拼成字符串交给 executeJavaScript） */
const GEN = `
(() => {
  const C = ${JSON.stringify(CONFIG)}
  let s = C.seed
  // 线性同余，够用且可复现
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }

  const cv = document.createElement('canvas')
  cv.width = cv.height = C.size
  const ctx = cv.getContext('2d')
  const R = C.size / 2
  ctx.lineCap = 'round'

  // X 形角向权重：主瓣 45° / 225°，次瓣 135° / 315°（0.22），
  // 上下左右四个正方向（0/90/180/270）落在 cos 的零点上 ⇒ 压到 0.04，几乎留空。
  // ⚠️ 这个 0.04 的底是「X 有多明显」的总开关：调大 → 全盘均匀（X 就看不出来）。
  const weight = (deg) => {
    const cos = Math.cos(2 * (deg - 45) * Math.PI / 180)
    const main = cos > 0 ? cos * cos : 0
    const sec = cos < 0 ? cos * cos : 0
    return 0.04 + 0.96 * main + 0.22 * sec
  }

  let drawn = 0
  for (let k = 0; k < C.rings; k++) {
    const r = (C.rMin + rnd() * (C.rMax - C.rMin)) * R
    const chunks = 1 + Math.floor(rnd() * 4)
    const baseAlpha = 0.05 + rnd() * (C.alphaMax - 0.05)
    const lw = C.lwMin + rnd() * (C.lwMax - C.lwMin)
    for (let j = 0; j < chunks; j++) {
      const start = rnd() * Math.PI * 2
      const len = C.lenMin + rnd() * (C.lenMax - C.lenMin)
      const midDeg = (((start + len / 2) * 180 / Math.PI) % 360 + 360) % 360
      const a = baseAlpha * weight(midDeg)
      if (a < 0.025) continue
      ctx.strokeStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')'
      ctx.lineWidth = lw
      ctx.beginPath()
      // 带轻微径向抖动的弧：避免"完美同心圆"的机械感
      const steps = 8
      for (let t = 0; t <= steps; t++) {
        const ang = start + len * (t / steps)
        const rr = r + (rnd() - 0.5) * 1.6
        const x = R + Math.cos(ang) * rr
        const y = R + Math.sin(ang) * rr
        if (t === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      drawn++
    }
  }
  return { dataUrl: cv.toDataURL('image/png'), drawn }
})()
`

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
    const tmpHtml = path.join(os.tmpdir(), 'gen-vinyl-texture.html')
    fs.writeFileSync(tmpHtml, '<!doctype html><meta charset="utf-8"><body></body>')

    const win = new BrowserWindow({ show: false, width: 200, height: 200 })
    await win.loadFile(tmpHtml)
    const { dataUrl, drawn } = await win.webContents.executeJavaScript(GEN)

    const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '')
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, Buffer.from(b64, 'base64'))

    const size = fs.statSync(OUT).size
    fs.writeFileSync(
        path.join(os.tmpdir(), 'gen-vinyl-texture.log'),
        `drawn=${drawn} bytes=${size} out=${OUT}\n`,
    )
    console.log(`drawn=${drawn}  bytes=${size}  ->  ${OUT}`)
    app.exit(0)
})

// 兜底：别让脚本把 CI 卡死
setTimeout(() => {
    console.error('超时退出')
    app.exit(1)
}, 60000)
