import { createServerFn } from "@tanstack/react-start"

export const getPublicRuntimeConfig = createServerFn({ method: "GET" }).handler(
  async () => {
    const { kilnGitRepository } = await import("@/lib/environment")
    return { gitRepository: kilnGitRepository() }
  }
)
