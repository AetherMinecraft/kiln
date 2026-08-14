export type SystemUpdateBatchState<Failure, HearthCompletion> = {
  active: boolean
  failures: ReadonlyArray<Failure>
  hearthCompletion: HearthCompletion | null
  versionName: string | null
}

export function inactiveSystemUpdateBatch<
  Failure,
  HearthCompletion,
>(): SystemUpdateBatchState<Failure, HearthCompletion> {
  return {
    active: false,
    failures: [],
    hearthCompletion: null,
    versionName: null,
  }
}

export function beginSystemUpdateBatch<Failure, HearthCompletion>(
  state: SystemUpdateBatchState<Failure, HearthCompletion>,
  versionName: string
): SystemUpdateBatchState<Failure, HearthCompletion> {
  if (state.active) return state
  return {
    active: true,
    failures: [],
    hearthCompletion: null,
    versionName,
  }
}

export function recordSystemUpdateFailure<Failure, HearthCompletion>(
  state: SystemUpdateBatchState<Failure, HearthCompletion>,
  failure: Failure
): SystemUpdateBatchState<Failure, HearthCompletion> {
  return { ...state, failures: [...state.failures, failure] }
}

export function recordHearthUpdateCompletion<Failure, HearthCompletion>(
  state: SystemUpdateBatchState<Failure, HearthCompletion>,
  completion: HearthCompletion
): SystemUpdateBatchState<Failure, HearthCompletion> {
  return { ...state, hearthCompletion: completion }
}

export function isHearthUpdateLocked<Failure, HearthCompletion>(
  state: SystemUpdateBatchState<Failure, HearthCompletion>
): boolean {
  return state.active && state.hearthCompletion !== null
}

export function systemUpdateCompletionDisposition(
  component: "hearth" | "relay",
  outcome: "failed" | "succeeded"
): { clearPresence: boolean; lockUntilReload: boolean } {
  const lockUntilReload = component === "hearth" && outcome === "succeeded"
  return {
    clearPresence: !lockUntilReload,
    lockUntilReload,
  }
}
