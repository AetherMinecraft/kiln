import { afterEach, describe, expect, it } from "vite-plus/test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"

import { replaceRelayUpdateVersion } from "./system-update-cache"
import {
  setSystemUpdateOverviewRefetchBlocked,
  systemUpdateOverviewRefetchPolicy,
} from "./system-update-presence"

describe("system update cache", () => {
  afterEach(() => setSystemUpdateOverviewRefetchBlocked(false))

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

  it("blocks automatic overview refetches until the batch finishes", () => {
    const queryClient = new QueryClient()
    const queryKey = ["updates", "overview"] as const
    queryClient.setQueryData(queryKey, { relays: [] })
    const observer = new QueryObserver(queryClient, {
      ...systemUpdateOverviewRefetchPolicy,
      queryFn: async () => ({ relays: [] }),
      queryKey,
      staleTime: 0,
    })

    setSystemUpdateOverviewRefetchBlocked(true)
    expect(systemUpdateOverviewRefetchPolicy.enabled()).toBe(false)
    expect(observer.shouldFetchOnWindowFocus()).toBe(false)
    expect(observer.shouldFetchOnReconnect()).toBe(false)
    expect(systemUpdateOverviewRefetchPolicy.refetchOnMount()).toBe(false)

    setSystemUpdateOverviewRefetchBlocked(false)
    expect(systemUpdateOverviewRefetchPolicy.enabled()).toBe(true)
    expect(observer.shouldFetchOnWindowFocus()).toBe(true)
    expect(observer.shouldFetchOnReconnect()).toBe(true)
    expect(systemUpdateOverviewRefetchPolicy.refetchOnMount()).toBe(true)
    observer.destroy()
  })

  it("does not load an uncached overview while the batch is active", async () => {
    const queryClient = new QueryClient()
    const queryKey = ["updates", "overview"] as const
    let requests = 0
    setSystemUpdateOverviewRefetchBlocked(true)
    const observer = new QueryObserver(queryClient, {
      ...systemUpdateOverviewRefetchPolicy,
      queryFn: async () => {
        requests += 1
        return { relays: [] }
      },
      queryKey,
    })
    const unsubscribe = observer.subscribe(() => undefined)

    await Promise.resolve()
    expect(requests).toBe(0)

    setSystemUpdateOverviewRefetchBlocked(false)
    await queryClient.invalidateQueries({ queryKey })
    expect(requests).toBe(1)
    unsubscribe()
  })
})
