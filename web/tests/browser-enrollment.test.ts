import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { browserRequest } from '../src/lib/browser-request'
import { activeRegistration, enrollPush } from '../src/features/notifications/enrollment'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const subscription = { endpoint: 'https://push.example.test/owner' }
const granted = () => ({ permission: () => 'granted' as NotificationPermission, requestPermission: async () => 'granted' as NotificationPermission, getSubscription: async () => null as typeof subscription | null, subscribe: async () => subscription })

test('an existing granted subscription is reused', async () => {
  let created = 0
  const value = await enrollPush({ ...granted(), getSubscription: async () => subscription, subscribe: async () => { created++; return subscription } })
  assert.equal(value, subscription)
  assert.equal(created, 0)
})

test('permission denial never creates a subscription', async () => {
  let created = 0
  await assert.rejects(enrollPush({ ...granted(), permission: () => 'denied', subscribe: async () => { created++; return subscription } }), /denied/)
  assert.equal(created, 0)
})

test('a cancelled permission prompt cannot resume enrollment after a late grant', async () => {
  const pending = deferred<NotificationPermission>()
  const controller = new AbortController()
  let permission: NotificationPermission = 'default', reads = 0, creates = 0
  const ports = { ...granted(), permission: () => permission, requestPermission: () => pending.promise,
    getSubscription: async () => { reads++; return null }, subscribe: async () => { creates++; return subscription } }
  const attempt = enrollPush(ports, controller.signal)
  await setImmediate()
  controller.abort()
  await assert.rejects(attempt, { name: 'AbortError' })
  permission = 'granted'; pending.resolve('granted')
  await setImmediate()
  assert.equal(reads, 0); assert.equal(creates, 0)
  // A fresh explicit attempt can use the permission the user eventually granted.
  assert.equal(await enrollPush(ports), subscription)
  assert.equal(creates, 1)
})

test('a timed out native permission promise does not trigger later subscription work', async () => {
  const pending = deferred<NotificationPermission>()
  let reads = 0, permission: NotificationPermission = 'default'
  const attempt = enrollPush({ ...granted(), permission: () => permission, requestPermission: () => pending.promise,
    getSubscription: async () => { reads++; return null } }, undefined, 5)
  await assert.rejects(attempt, /browser_timeout/)
  permission = 'granted'; pending.resolve('granted'); await setImmediate()
  assert.equal(reads, 0)
})

test('late subscription completion after cancellation cannot register on the server', async () => {
  const pending = deferred<typeof subscription>()
  const controller = new AbortController()
  let serverWrites = 0
  const attempt = enrollPush({ ...granted(), subscribe: () => pending.promise }, controller.signal).then(() => { serverWrites++ })
  await setImmediate(); controller.abort()
  await assert.rejects(attempt, { name: 'AbortError' })
  pending.resolve(subscription); await setImmediate()
  assert.equal(serverWrites, 0)
})

test('subscription lookup timeout cannot start a new browser subscription', async () => {
  const pending = deferred<typeof subscription | null>()
  let creates = 0
  const attempt = enrollPush({ ...granted(), getSubscription: () => pending.promise,
    subscribe: async () => { creates++; return subscription } }, undefined, 5)
  await assert.rejects(attempt, /browser_timeout/)
  pending.resolve(null); await setImmediate()
  assert.equal(creates, 0)
})

test('an already aborted attempt never invokes the native browser', async () => {
  const controller = new AbortController(); controller.abort()
  let calls = 0
  await assert.rejects(browserRequest(async () => { calls++; return true }, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls, 0)
})

test('native synchronous errors are preserved without an unhandled rejection', async () => {
  await assert.rejects(browserRequest(() => { throw new Error('native failed') }), /native failed/)
})

test('aborting after success cannot replace a settled response', async () => {
  const controller = new AbortController()
  assert.equal(await browserRequest(async () => 42, { signal: controller.signal }), 42)
  controller.abort(); await setImmediate()
})


test('cold settings load waits for the first active service worker', async () => {
  const pending = deferred<{ active: object | null }>()
  const attempt = activeRegistration({ current: async () => ({ active: null }), ready: () => pending.promise })
  await setImmediate()
  const active = { active: {} }; pending.resolve(active)
  assert.equal(await attempt, active)
})

test('an existing active worker needs no readiness wait', async () => {
  let waited = false
  const active = { active: {} }
  assert.equal(await activeRegistration({ current: async () => active, ready: async () => { waited = true; return active } }), active)
  assert.equal(waited, false)
})

test('blocked worker readiness is bounded and can be retried after activation', async () => {
  const pending = deferred<{ active: object | null }>()
  assert.equal(await activeRegistration({ current: async () => null, ready: () => pending.promise }, undefined, 5), null)
  const active = { active: {} }; pending.resolve(active)
  assert.equal(await activeRegistration({ current: async () => active, ready: () => pending.promise }), active)
})

test('worker readiness cancellation prevents late state updates', async () => {
  const pending = deferred<{ active: object | null }>()
  const controller = new AbortController()
  let updates = 0
  const attempt = activeRegistration({ current: async () => null, ready: () => pending.promise }, controller.signal).then(() => { updates++ })
  await setImmediate(); controller.abort()
  await assert.rejects(attempt, { name: 'AbortError' })
  pending.resolve({ active: {} }); await setImmediate()
  assert.equal(updates, 0)
})

test('a different server key replaces the browser subscription', async () => {
  const actions: string[] = []
  const fresh = { endpoint: 'https://push.example.test/new' }
  const result = await enrollPush({ ...granted(), getSubscription: async () => subscription, matches: () => false,
    unsubscribe: async () => { actions.push('unsubscribe'); return true }, subscribe: async () => { actions.push('subscribe'); return fresh } })
  assert.equal(result, fresh)
  assert.deepEqual(actions, ['unsubscribe', 'subscribe'])
})

test('cancellation while replacing a key cannot start a late new subscription', async () => {
  const pending = deferred<boolean>()
  const controller = new AbortController()
  let creates = 0
  const attempt = enrollPush({ ...granted(), getSubscription: async () => subscription, matches: () => false,
    unsubscribe: () => pending.promise, subscribe: async () => { creates++; return subscription } }, controller.signal)
  await setImmediate(); controller.abort()
  await assert.rejects(attempt, { name: 'AbortError' })
  pending.resolve(true); await setImmediate()
  assert.equal(creates, 0)
})
