const BASE = '/api'

// Mutating calls need the per-install token, which the daemon only serves to the dashboard origin.
let tokenPromise
function getToken() {
  tokenPromise ??= fetch(`${BASE}/token`).then((r) => r.json()).then((j) => j.token)
  tokenPromise.catch(() => { tokenPromise = undefined })
  return tokenPromise
}

async function request(path, options = {}) {
  if (options.method && options.method !== 'GET') {
    options = { ...options, headers: { ...options.headers, Authorization: `Bearer ${await getToken()}` } }
  }
  const res = await fetch(`${BASE}${path}`, options)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Request failed: ${res.status}`)
  }
  return res.json()
}

export function getHealth() {
  return request('/health')
}

export function getOverview(days = 30) {
  return request(`/overview?days=${encodeURIComponent(days)}`)
}

export function getProjects() {
  return request('/projects')
}

export function getSessions({ tool, project, limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams()
  if (tool) params.set('tool', tool)
  if (project) params.set('project', project)
  params.set('limit', limit)
  params.set('offset', offset)
  return request(`/sessions?${params.toString()}`)
}

export function getSession(id) {
  return request(`/sessions/${encodeURIComponent(id)}`)
}

export function getSessionMemory(id) {
  return request(`/sessions/${encodeURIComponent(id)}/memory`)
}

export function getPrompt(id) {
  return request(`/prompts/${encodeURIComponent(id)}`)
}

export function postOptimization(body) {
  return request('/optimizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function getOptimization(promptId) {
  return request(`/optimizations/${encodeURIComponent(promptId)}`)
}

export function getSessionContext(id) {
  return request(`/sessions/${encodeURIComponent(id)}/context`)
}

/** Subscribe to the daemon's live event stream; returns an unsubscribe function. */
export function subscribeLive(onEvent, onStatus = () => {}) {
  const source = new EventSource(`${BASE}/live`)
  for (const type of ['turn_started', 'turn_finished', 'session_updated']) {
    source.addEventListener(type, (e) => onEvent({ type, data: JSON.parse(e.data) }))
  }
  source.onopen = () => onStatus(true)
  source.onerror = () => onStatus(false)
  return () => source.close()
}
