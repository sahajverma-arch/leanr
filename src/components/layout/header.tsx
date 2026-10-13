import { Button } from "@/components/ui/button"
import { signOutAction } from "@/app/(app)/actions"
import { ThemeToggle } from "@/components/layout/theme-toggle"

export function Header({ email }: { email: string }) {
  return (
    <header className="flex h-14 items-center justify-between border-b px-6">
      <span className="text-sm text-muted-foreground">{email}</span>
      <div className="flex items-center gap-3">
        <ThemeToggle />
        <form action={signOutAction}>
          <Button type="submit" variant="outline" size="sm">
            Sign out
          </Button>
        </form>
      </div>
    </header>
  )
}
