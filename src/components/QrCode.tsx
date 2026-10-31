import { encode } from 'uqr'
import { useMemo } from 'react'

// 二维码画成 <svg><path>：每个深色模块一个 1x1 方块，四周留 4 格静区；颜色固定黑白，深色模式下也要能被扫描
export function QrCode({ text, label, className }: { text: string; label: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 0 })
    let d = ''
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`
      }),
    )
    return { size: qr.size, path: d }
  }, [text])
  const quiet = 4
  const total = size + quiet * 2
  return (
    <svg
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label={label}
      className={className}
      shapeRendering="crispEdges"
      data-testid="phone-upload-qr"
    >
      <rect width={total} height={total} fill="#fff" />
      <path transform={`translate(${quiet} ${quiet})`} d={path} fill="#000" />
    </svg>
  )
}
