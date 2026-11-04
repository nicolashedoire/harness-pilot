/** Native permission/service-worker calls can remain pending; cancellation stops our continuation. */
export function browserRequest<T>(operation: () => Promise<T>, { signal, timeoutMs = 30_000 }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      callback()
    }
    const aborted = () => finish(() => reject(new DOMException('Request cancelled', 'AbortError')))
    if (signal?.aborted) return aborted()
    signal?.addEventListener('abort', aborted, { once: true })
    timer = setTimeout(() => finish(() => reject(new Error('browser_timeout'))), timeoutMs)
    Promise.resolve().then(() => {
      if (settled) throw new DOMException('Request cancelled', 'AbortError')
      return operation()
    }).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)))
  })
}
