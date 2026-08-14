import * as React from "react"

import { Button } from "@workspace/ui/components/button"

type LogoOption = {
  asset: string
  favicon: string
  label: string
  value: "k" | "oven"
}

const logoOptions: ReadonlyArray<LogoOption> = [
  {
    asset: "/branding/kiln-oven.svg",
    favicon: "/favicon.svg",
    label: "Oven",
    value: "oven",
  },
  {
    asset: "/branding/kiln-k.svg",
    favicon: "/favicon-k.svg",
    label: "K",
    value: "k",
  },
]

function applyLogo(option: LogoOption) {
  document.documentElement.style.setProperty(
    "--kiln-logo",
    `url("${option.asset}")`
  )
  document
    .querySelector<HTMLLinkElement>('link[rel="icon"]')
    ?.setAttribute("href", option.favicon)
}

export function KilnLogoSwitcher() {
  const [selectedLogo, setSelectedLogo] =
    React.useState<LogoOption["value"]>("oven")

  function selectLogo(option: LogoOption) {
    applyLogo(option)
    setSelectedLogo(option.value)
  }

  return (
    <div
      aria-label="Compare Kiln logos"
      className="fixed right-52 bottom-4 z-[2147483646] flex h-10 items-center gap-1 border border-border/80 bg-background/95 p-1 shadow-lg shadow-black/25 backdrop-blur-md"
      role="group"
    >
      <span className="px-1.5 font-mono text-[0.5625rem] tracking-[0.08em] text-muted-foreground uppercase">
        Logo
      </span>
      {logoOptions.map((option) => (
        <Button
          aria-pressed={selectedLogo === option.value}
          className="h-7 gap-1.5 px-2 font-mono text-[0.625rem] text-muted-foreground aria-pressed:border-primary/40 aria-pressed:bg-primary/10 aria-pressed:text-primary"
          key={option.value}
          onClick={() => selectLogo(option)}
          size="xs"
          type="button"
          variant="ghost"
        >
          <span
            aria-hidden="true"
            className="size-4 bg-current [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain]"
            style={{
              WebkitMaskImage: `url("${option.asset}")`,
              maskImage: `url("${option.asset}")`,
            }}
          />
          {option.label}
        </Button>
      ))}
    </div>
  )
}
