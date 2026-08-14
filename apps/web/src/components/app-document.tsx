import { HeadContent, Scripts } from "@tanstack/react-router"

import { Toaster } from "@workspace/ui/components/sonner"
import { TooltipProvider } from "@workspace/ui/components/tooltip"

import { KilnLogoSwitcher } from "@/components/kiln-logo-switcher"
import { appearanceBootScript } from "@/lib/appearance"

export function AppDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: appearanceBootScript }} />
        <HeadContent />
      </head>
      <body className="overflow-hidden antialiased">
        <Toaster />
        <TooltipProvider delayDuration={250}>{children}</TooltipProvider>
        {import.meta.env.DEV ? <KilnLogoSwitcher /> : null}
        <Scripts />
      </body>
    </html>
  )
}
