const instrumentation = new URL("../instrument.server.mjs", import.meta.url)
  .href
process.env.NODE_OPTIONS =
  `${process.env.NODE_OPTIONS || ""} --import=${instrumentation}`.trim()
process.argv.splice(2, 0, "dev", "--port", "3000")

await import("vite-plus/bin")
