import { Result } from "effect"

export const DEFAULT_KILN_GIT_REPO = "https://github.com/kiln-site/kiln"
export const LEGACY_KILN_GIT_REPO = "https://github.com/kiln-site/hearth"

const repositorySegment = /^[A-Za-z\d_.-]+$/u

export function resolveKilnGitRepository(value?: string): string {
  const configured = value?.trim() || DEFAULT_KILN_GIT_REPO
  const candidate = configured.includes("://")
    ? configured
    : `https://github.com/${configured}`

  const parsed = Result.try(() => new URL(candidate))
  if (Result.isFailure(parsed)) throw invalidRepositoryError()
  const url = parsed.success

  const segments = url.pathname.replace(/\/$/u, "").split("/").filter(Boolean)
  const owner = segments[0]
  const repository = segments[1]?.replace(/\.git$/u, "")
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    segments.length !== 2 ||
    !owner ||
    !repository ||
    !repositorySegment.test(owner) ||
    !repositorySegment.test(repository)
  ) {
    throw invalidRepositoryError()
  }

  return `https://github.com/${owner}/${repository}`
}

export function kilnGitRepositorySlug(value?: string): string {
  return new URL(resolveKilnGitRepository(value)).pathname.slice(1)
}

export function kilnGitHubContainerRegistry(value?: string): string {
  const slug = kilnGitRepositorySlug(value)
  return `ghcr.io/${slug.slice(0, slug.indexOf("/")).toLowerCase()}`
}

export function kilnGitRepositoryApiUrl(
  value: string | undefined,
  path: string
): string {
  return `https://api.github.com/repos/${kilnGitRepositorySlug(value)}/${path.replace(/^\/+/, "")}`
}

export function kilnGitRepositoryRawUrl(
  value: string | undefined,
  path: string
): string {
  return `https://raw.githubusercontent.com/${kilnGitRepositorySlug(value)}/main/${path.replace(/^\/+/, "")}`
}

export function isKilnGitRepositorySource(
  source: string | undefined,
  configuredRepository: string
): boolean {
  return source === configuredRepository || source === LEGACY_KILN_GIT_REPO
}

function invalidRepositoryError(): Error {
  return new Error(
    "KILN_GIT_REPO must be a GitHub repository URL or owner/repository"
  )
}
