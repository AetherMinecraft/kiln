import {
  kilnGitRepositorySlug,
  resolveKilnGitRepository,
} from "@workspace/contracts"

export const kilnGitRepository = resolveKilnGitRepository(
  import.meta.env.VITE_KILN_GIT_REPO
)
export const kilnGitRepositorySlugValue =
  kilnGitRepositorySlug(kilnGitRepository)
