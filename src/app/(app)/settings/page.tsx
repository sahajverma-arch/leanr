import Link from "next/link"

import { ThemeToggle } from "@/components/layout/theme-toggle"

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-2 text-muted-foreground">
          <Link href="/settings/generation-log" className="underline">
            Generation log
          </Link>{" "}
          — every plan-generation LLM attempt, for self-diagnosing a plan that looks wrong.
        </p>
      </div>

      <section>
        <h2 className="text-lg font-semibold">Appearance</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Light or dark, or follow this device&apos;s setting. Saved in this browser only. Printing a plan and the
          downloaded PDF are always light.
        </p>
        <div className="mt-3">
          <ThemeToggle showLabels />
        </div>
      </section>
    </div>
  )
}
