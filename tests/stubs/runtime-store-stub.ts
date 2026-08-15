/**
 * Dependency-free createSnapshotStore stand-in for tests. A snapshot store is a
 * bare observable (getSnapshot / subscribe / set / update). The real engine
 * (zustand + immer) is not needed to exercise the controller's list/delete
 * sequencing logic, so tests route the @deepseek-ai runtime face here — no
 * peer packages required.
 */
export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
  update(mutator: (draft: T) => void): void
  set(next: T): void
}

export function createSnapshotStore<T>(init: T): SnapshotStore<T> {
  let state = init
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    update: (mutator) => {
      // Shallow clone along the draft path; the controller's `set` replaces the
      // whole snapshot, and `update` is only used by the engine tests (not the
      // controller), so a plain replace is enough here.
      state = { ...(state as object) } as T
      mutator(state as never)
      for (const fn of [...listeners]) fn()
    },
    set: (next) => {
      state = next
      for (const fn of [...listeners]) fn()
    },
  }
}
