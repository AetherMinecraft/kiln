import * as React from "react"
import { Check, ChevronDown, LoaderCircle, Search } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { cn } from "@workspace/ui/lib/utils"

export const BrickVersionPicker = React.memo(function BrickVersionPicker({
  disabled = false,
  emptyMessage = "No matching versions",
  labelledBy,
  loading = false,
  name,
  onChange,
  placeholder = "Select a version",
  required = false,
  searchPlaceholder = "Search versions…",
  value,
  versions,
}: {
  disabled?: boolean
  emptyMessage?: string
  labelledBy: string
  loading?: boolean
  name: string
  onChange: (value: string) => void
  placeholder?: string
  required?: boolean
  searchPlaceholder?: string
  value: string
  versions: ReadonlyArray<string>
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleVersions = React.useMemo(
    () =>
      normalizedQuery
        ? versions.filter((version) =>
            version.toLocaleLowerCase().includes(normalizedQuery)
          )
        : versions,
    [normalizedQuery, versions]
  )
  const selectVersion = React.useCallback(
    (version: string) => {
      onChange(version)
      setOpen(false)
    },
    [onChange]
  )

  return (
    <>
      <input name={name} type="hidden" value={value} required={required} />
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen)
          if (!nextOpen) setQuery("")
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            aria-labelledby={labelledBy}
            aria-required={required}
            className="h-8 w-full justify-between px-3 font-mono text-xs font-normal tabular-nums"
          >
            <span className="min-w-0 truncate">
              {value || (
                <span className="font-sans text-muted-foreground">
                  {loading ? "Loading versions…" : placeholder}
                </span>
              )}
            </span>
            {loading ? (
              <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="z-[70] w-(--radix-popover-trigger-width) p-1.5"
        >
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              aria-label="Search versions"
              className="h-8 pl-8"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <div
            role="listbox"
            aria-label="Supported versions"
            className="no-scrollbar max-h-72 space-y-0.5 overflow-y-auto overscroll-contain"
          >
            {loading && versions.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                Loading versions…
              </p>
            ) : visibleVersions.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {emptyMessage}
              </p>
            ) : (
              visibleVersions.map((version) => {
                const selected = version === value
                return (
                  <button
                    key={version}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150",
                      selected
                        ? "bg-primary/14 ring-1 ring-primary/35"
                        : "hover:bg-accent/55"
                    )}
                    onClick={() => selectVersion(version)}
                  >
                    <span className="truncate font-mono text-xs tabular-nums">
                      {version}
                    </span>
                    {selected ? (
                      <Check className="size-4 shrink-0 text-primary" />
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
})
