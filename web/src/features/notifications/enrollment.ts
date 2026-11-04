import { browserRequest } from '../../lib/browser-request'

type Port<T> = {
  permission: () => NotificationPermission
  requestPermission: () => Promise<NotificationPermission>
  getSubscription: () => Promise<T | null>
  matches?: (subscription: T) => boolean
  unsubscribe?: (subscription: T) => Promise<boolean>
  subscribe: () => Promise<T>
}

/** A late native response must never resume a cancelled attempt and register it on the server. */
export async function enrollPush<T>(port: Port<T>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  const request = <V,>(operation: () => Promise<V>) => {
    if (Date.now() >= deadline) throw new Error('browser_timeout')
    return browserRequest(operation, { signal, timeoutMs: deadline - Date.now() })
  }
  if (port.permission() === 'default' && await request(port.requestPermission) !== 'granted') throw new Error('denied')
  if (port.permission() !== 'granted') throw new Error('denied')
  let existing = await request(port.getSubscription)
  if (existing && port.matches && !port.matches(existing)) {
    if (!port.unsubscribe) throw new Error('subscription_key_changed')
    await request(() => port.unsubscribe!(existing!))
    existing = null
  }
  return existing || await request(port.subscribe)
}

/** First install can activate after the settings card mounts. Ready may wait forever when SWs are blocked. */
export async function activeRegistration<T extends { active: unknown }>(port: {
  current: () => Promise<T | null>
  ready: () => Promise<T>
}, signal?: AbortSignal, timeoutMs = 5_000): Promise<T | null> {
  try {
    const result = await browserRequest(async () => {
      const current = await port.current()
      if (current?.active) return current
      signal?.throwIfAborted()
      return port.ready()
    }, { signal, timeoutMs })
    return result.active ? result : null
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    return null
  }
}
