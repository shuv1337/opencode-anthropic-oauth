// Shared test harness that drives the real V2 plugin `setup` against a faithful
// mock of the OpenCode host Context (integration/catalog/aisdk/event domains).
// Not a *.test.mjs file, so the `tests/*.test.mjs` runner never executes it.
//
// The harness never touches real credential files or the network: callers
// supply the resolved credential and fallback flags explicitly.

const INTEGRATION_ID = "anthropic"

// Runs the plugin's captured catalog.transform callback against a fresh mock
// draft and returns what it mutated (provider body + per-model cost overrides).
export function runCatalogTransform(state) {
  const providerBody = {}
  const modelCosts = {}
  const models = new Map([["claude-sonnet", { id: "claude-sonnet" }]])
  const draft = {
    provider: {
      list: () => [],
      get: (id) => (id === INTEGRATION_ID ? { provider: { id: INTEGRATION_ID }, models } : undefined),
      update: (id, fn) => {
        const provider = { body: providerBody }
        fn(provider)
        if (provider.body) Object.assign(providerBody, provider.body)
      },
      remove() {},
    },
    model: {
      get: () => undefined,
      update: (_pid, mid, fn) => {
        const candidate = {}
        fn(candidate)
        modelCosts[mid] = candidate.cost
      },
      remove() {},
      default: { get: () => undefined, set() {} },
    },
  }
  if (!state.catalogTransformFn) throw new Error("catalog.transform never registered")
  state.catalogTransformFn(draft)
  return { providerBody, modelCosts }
}

function makeEventStream(state, signal) {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (signal?.aborted || state.eventDone) return Promise.resolve({ done: true, value: undefined })
          if (state.eventQueue.length) return Promise.resolve({ done: false, value: state.eventQueue.shift() })
          return new Promise((resolve) => {
            const entry = { resolve }
            const onAbort = () => resolve({ done: true, value: undefined })
            entry.onAbort = onAbort
            state.eventResolvers.push(entry)
            if (signal) signal.addEventListener("abort", onAbort, { once: true })
          })
        },
        return() {
          state.eventDone = true
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
}

export function pushEvent(state, event) {
  const waiter = state.eventResolvers.shift()
  if (waiter) waiter.resolve({ done: false, value: event })
  else state.eventQueue.push(event)
}

// Waits until `predicate()` is truthy, polling on the microtask/macrotask queue.
export async function waitFor(predicate, { timeout = 2000 } = {}) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 5))
  }
}

export function makeMockCtx({ options = {}, credential = undefined, resolveThrows = false } = {}) {
  const state = {
    credential,
    resolveThrows,
    catalogReloads: 0,
    integrationReloads: 0,
    methodRegistration: null,
    catalogTransformFn: null,
    aisdkSdkHook: null,
    disposed: [],
    eventQueue: [],
    eventResolvers: [],
    eventDone: false,
    activeCalls: 0,
    resolveCalls: 0,
  }

  const ctx = {
    options,
    integration: {
      transform: async (cb) => {
        const draft = {
          list: () => [],
          get: () => undefined,
          update() {},
          remove() {},
          method: {
            list: () => [],
            update: (registration) => {
              state.methodRegistration = registration
            },
            remove() {},
          },
        }
        cb(draft)
        return { dispose: async () => state.disposed.push("integration") }
      },
      reload: async () => {
        state.integrationReloads++
      },
      connection: {
        active: async () => {
          state.activeCalls++
          return state.credential === undefined ? undefined : { integrationID: INTEGRATION_ID }
        },
        resolve: async () => {
          state.resolveCalls++
          if (state.resolveThrows) throw new Error("connection resolve failed")
          return state.credential
        },
      },
    },
    catalog: {
      transform: async (cb) => {
        state.catalogTransformFn = cb
        return { dispose: async () => state.disposed.push("catalog") }
      },
      reload: async () => {
        state.catalogReloads++
      },
    },
    aisdk: {
      hook: async (name, cb) => {
        if (name === "sdk") state.aisdkSdkHook = cb
        return { dispose: async () => state.disposed.push(`aisdk:${name}`) }
      },
    },
    event: {
      subscribe: ({ signal } = {}) => makeEventStream(state, signal),
    },
  }

  return { ctx, state }
}
