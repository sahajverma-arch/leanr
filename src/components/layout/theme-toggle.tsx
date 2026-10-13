"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"

import { cn } from "@/lib/utils"

const OPTIONS = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
] as const

/**
 * Light / Dark / System, as a small segmented control. Used compact (icons
 * only) in the header and with labels on the Settings page.
 */
export function ThemeToggle({ showLabels = false, className }: { showLabels?: boolean; className?: string }) {
  const { theme, setTheme } = useTheme()
  // The server does not know the stored theme, so nothing is marked selected
  // until the first client render — otherwise the server and client markup
  // would differ and React would report a hydration mismatch.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  const current = mounted ? theme : undefined

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn("inline-flex items-center gap-0.5 rounded-lg border p-0.5", className)}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = current === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={showLabels ? undefined : label}
            title={showLabels ? undefined : label}
            onClick={() => setTheme(value)}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              selected ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {showLabels && label}
          </button>
        )
      })}
    </div>
  )
}
