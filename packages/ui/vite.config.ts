import { defineConfig } from "vite-plus"

export default defineConfig({
  run: {
    tasks: {
      typecheck: "tsc --noEmit",
    },
  },
})
