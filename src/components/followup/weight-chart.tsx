import type { WeightPoint } from "@/lib/followup/load-client-programme"
import { formatWeight } from "@/lib/format"

const W = 560
const H = 150
const PAD = { top: 18, right: 56, bottom: 22, left: 8 }

/**
 * Weight across the programme: counselling weight, then each week's check-in.
 * One series, so no legend — the card title names it. Goal weight is a dashed
 * reference line. Each point has a hover tooltip on a hit target larger than
 * the marker, and the list below the chart is the table view.
 */
export function WeightChart({ points, targetWeightKg }: { points: WeightPoint[]; targetWeightKg: number | null }) {
  if (points.length < 2) return null

  const values = points.map((p) => p.weightKg)
  if (targetWeightKg !== null) values.push(targetWeightKg)
  const lo = Math.min(...values) - 0.5
  const hi = Math.max(...values) + 0.5
  const x = (i: number) => PAD.left + (i * (W - PAD.left - PAD.right)) / (points.length - 1)
  const y = (kg: number) => PAD.top + ((hi - kg) * (H - PAD.top - PAD.bottom)) / (hi - lo)
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.weightKg).toFixed(1)}`).join(" ")
  const last = points.length - 1

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Weight: ${points.map((p) => `${p.label} ${formatWeight(p.weightKg)} kg`).join(", ")}`}
    >
      {targetWeightKg !== null && (
        <g className="text-muted-foreground">
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(targetWeightKg)}
            y2={y(targetWeightKg)}
            className="stroke-border"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
          <text x={W - PAD.right + 6} y={y(targetWeightKg) + 4} className="fill-muted-foreground text-[11px]">
            Goal {formatWeight(targetWeightKg)}
          </text>
        </g>
      )}
      <path d={path} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <g key={p.label}>
          <circle cx={x(i)} cy={y(p.weightKg)} r={4} className="fill-primary stroke-background" strokeWidth={2} />
          <text x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === last ? "end" : "middle"} className="fill-muted-foreground text-[11px]">
            {p.label}
          </text>
          {/* Hit target, larger than the mark. */}
          <circle cx={x(i)} cy={y(p.weightKg)} r={14} fill="transparent">
            <title>{`${p.label}: ${formatWeight(p.weightKg)} kg`}</title>
          </circle>
        </g>
      ))}
      {/* Direct labels on the first and last points only. */}
      {[0, last].map((i) => (
        <text
          key={`v${i}`}
          x={x(i)}
          y={y(points[i].weightKg) - 9}
          textAnchor={i === 0 ? "start" : "end"}
          className="fill-foreground text-[11px] font-medium tabular-nums"
        >
          {formatWeight(points[i].weightKg)} kg
        </text>
      ))}
    </svg>
  )
}
