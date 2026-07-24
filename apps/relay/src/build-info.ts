const bakedCommit = String(import.meta.env.KILN_BUILD_SHA ?? "").trim()

/** Full commit SHA baked at pack time, or empty when unavailable. */
export const relayBuildCommit = bakedCommit

/** Short SHA for display, or `development` when no commit was baked. */
export function relayBuildLabel(): string {
  return relayBuildCommit ? relayBuildCommit.slice(0, 7) : "development"
}
