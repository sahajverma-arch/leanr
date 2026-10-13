"use client"

import { useEffect } from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"

/**
 * Wires next-themes. The chosen theme ("light" | "dark" | "system") is kept
 * in localStorage and applied as a `dark` class on <html>, which is what
 * globals.css's `@custom-variant dark` and its `.dark { ... }` token block
 * key on. Purely presentational: nothing here reaches a target, a macro or
 * a model.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <PrintInLight />
      {children}
    </NextThemesProvider>
  )
}

/**
 * A plan or review page printed from dark mode would come out as a black
 * page: `dark` is only a class, and the browser prints what is on screen.
 * The downloadable PDF (react-pdf) is unaffected, but the plan page itself
 * carries `print:` styles and is printed directly. So while a print is in
 * progress the `dark` class comes off <html> and goes back afterwards.
 */
function PrintInLight() {
  useEffect(() => {
    const root = document.documentElement
    let wasDark = false
    let colorScheme = ""
    const before = () => {
      wasDark = root.classList.contains("dark")
      colorScheme = root.style.colorScheme
      root.classList.remove("dark")
      root.style.colorScheme = "light"
    }
    const after = () => {
      if (wasDark) root.classList.add("dark")
      root.style.colorScheme = colorScheme
    }
    window.addEventListener("beforeprint", before)
    window.addEventListener("afterprint", after)
    return () => {
      window.removeEventListener("beforeprint", before)
      window.removeEventListener("afterprint", after)
    }
  }, [])
  return null
}
