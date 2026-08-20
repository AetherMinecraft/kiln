export function replaceRelayUpdateVersion<
  Relay extends { relayId: string; currentVersion: string | null },
>(
  relays: ReadonlyArray<Relay>,
  relayId: string,
  version: string
): Array<Relay> {
  return relays.map((relay) =>
    relay.relayId === relayId
      ? { ...relay, currentVersion: version }
      : relay
  )
}
