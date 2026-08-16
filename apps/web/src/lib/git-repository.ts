import { getRouteApi } from "@tanstack/react-router"
import { kilnGitRepositorySlug } from "@workspace/contracts"

const rootRouteApi = getRouteApi("__root__")

export function useKilnGitRepository(): string {
  return rootRouteApi.useLoaderData().gitRepository
}

export function useKilnGitRepositorySlug(): string {
  return kilnGitRepositorySlug(useKilnGitRepository())
}
