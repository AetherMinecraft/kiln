import { cn } from "@workspace/ui/lib/utils"

export function HearthMark({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative grid size-8 shrink-0 place-items-center text-primary",
        className
      )}
    >
      <span
        className="size-full scale-[1.35] bg-current [mask-image:url('/branding/kiln-oven.svg')] [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain]"
      />
    </div>
  )
}
