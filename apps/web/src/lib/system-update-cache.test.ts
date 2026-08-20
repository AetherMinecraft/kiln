import { describe, expect, it } from "vite-plus/test"
import { QueryClient } from "@tanstack/react-query"

import { replaceRelayUpdateVersion } from "./system-update-cache"

describe("system update cache", () => {
  it("updates only the relay that completed", () => {
    const relays = [
      { currentVersion: "0.1.0", relayId: "relay-a" },
      { currentVersion: "0.1.0", relayId: "relay-b" },
    ]

    expect(replaceRelayUpdateVersion(relays, "relay-a", "0.2.0")).toEqual([
      { currentVersion: "0.2.0", relayId: "relay-a" },
      { currentVersion: "0.1.0", relayId: "relay-b" },
    ])
  })

  it("ignores an overview response cancelled before the batch starts", async () => {
    const queryClient = new QueryClient()
    const queryKey = ["updates", "overview"] as const
    const staleOverview = {
      relays: [
        { currentVersion: "0.1.0", relayId: "relay-a" },
        { currentVersion: "0.1.0", relayId: "relay-b" },
      ],
    }
    let resolveRequest: (overview: typeof staleOverview) => void = () =>
      undefined
    let markRequestStarted: () => void = () => undefined
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve
    })

    queryClient.setQueryData(queryKey, staleOverview)
    const request = queryClient.fetchQuery({
      queryFn: ({ signal }) =>
        new Promise<typeof staleOverview>((resolve, reject) => {
          resolveRequest = resolve
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true }
          )
          markRequestStarted()
        }),
      queryKey,
    })

    await requestStarted
    await queryClient.cancelQueries({ exact: true, queryKey })
    queryClient.setQueryData(queryKey, {
      relays: replaceRelayUpdateVersion(
        staleOverview.relays,
        "relay-a",
        "0.2.0"
      ),
    })
    resolveRequest(staleOverview)
    await request.catch(() => undefined)

    expect(queryClient.getQueryData(queryKey)).toEqual({
      relays: [
        { currentVersion: "0.2.0", relayId: "relay-a" },
        { currentVersion: "0.1.0", relayId: "relay-b" },
      ],
    })
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false)
  })
})
