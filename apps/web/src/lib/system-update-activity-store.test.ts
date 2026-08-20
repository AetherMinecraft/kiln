import { describe, expect, it, vi } from "vite-plus/test"

import { createSystemUpdateActivityStore } from "./system-update-activity-store"

describe("system update activity store", () => {
  it("only notifies the operation whose phase changed", () => {
    const store = createSystemUpdateActivityStore()
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    const activitiesListener = vi.fn()
    const targetListener = vi.fn()
    const unsubscribe = store.subscribePhase("first", firstListener)
    store.subscribePhase("second", secondListener)
    store.subscribeActivities(activitiesListener)
    store.subscribeTargetActivity("first-target", targetListener)

    store.setPhase("first", "Preparing")
    store.setPhase("first", "Preparing")

    expect(store.getPhaseSnapshot("first")).toBe("Preparing")
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(secondListener).not.toHaveBeenCalled()
    expect(activitiesListener).not.toHaveBeenCalled()
    expect(targetListener).not.toHaveBeenCalled()

    unsubscribe()
    store.setPhase("first", "Downloading")
    expect(firstListener).toHaveBeenCalledTimes(1)
  })

  it("only notifies targets whose active operation changed", () => {
    const store = createSystemUpdateActivityStore()
    const activitiesListener = vi.fn()
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    store.subscribeActivities(activitiesListener)
    store.subscribeTargetActivity("first", firstListener)
    store.subscribeTargetActivity("second", secondListener)

    store.setActivities([
      { name: "First", operationId: "operation-1", targetKey: "first" },
    ])
    store.setActivities([
      {
        name: "First",
        operationId: "operation-1",
        targetKey: "first",
        phase: "Preparing",
      },
    ])

    expect(store.getBusySnapshot()).toBe(true)
    expect(store.getTargetActivitySnapshot("first")?.operationId).toBe(
      "operation-1"
    )
    expect(activitiesListener).toHaveBeenCalledTimes(1)
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(secondListener).not.toHaveBeenCalled()

    store.setActivities([])
    expect(store.getBusySnapshot()).toBe(false)
    expect(firstListener).toHaveBeenCalledTimes(2)
  })

  it("notifies controls once when Hearth requires a reload", () => {
    const store = createSystemUpdateActivityStore()
    const listener = vi.fn()
    store.subscribeHearthReloadRequired(listener)

    store.setHearthReloadRequired(true)
    store.setHearthReloadRequired(true)

    expect(store.getHearthReloadRequiredSnapshot()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
