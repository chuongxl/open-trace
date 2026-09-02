const BASE = '/api'

async function request(path, options) {
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
