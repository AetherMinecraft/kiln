const INVITE_TOKEN_MIN_LENGTH = 32

export function invitePath(token: string): string {
  return `/invite?token=${encodeURIComponent(token)}`
}

export function inviteTokenFromRedirect(
  redirectPath: string | undefined
): string | null {
  if (!redirectPath?.startsWith("/invite?")) return null
  try {
    const token = new URL(redirectPath, "http://kiln.local").searchParams.get(
      "token"
    )
    if (!token || token.length < INVITE_TOKEN_MIN_LENGTH) return null
    return token
  } catch {
    return null
  }
}

export function invitationDestination(invitation: {
  accessType: "platform_admin" | "relay_creator" | "scoped"
  databaseId: string | null
  instanceId: string | null
}): string {
  if (invitation.accessType !== "scoped") return "/infra/relays"
  if (invitation.databaseId) {
    return `/infra/databases?search=${encodeURIComponent(invitation.databaseId)}`
  }
  if (invitation.instanceId) {
    return `/server/${encodeURIComponent(invitation.instanceId)}/console`
  }
  return "/infra/servers"
}
