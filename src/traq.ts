const API = 'https://q.trap.jp/api/v3'
const CLIENT_ID = import.meta.env.VITE_TRAQ_CLIENT_ID ?? ''
const REDIRECT_URI = import.meta.env.VITE_TRAQ_REDIRECT_URI ?? `${location.origin}/oauth/callback`

export type TraqUser = { id: string; name: string; displayName: string; state?: number }
type TokenResponse = { access_token: string; token_type: string; expires_in: number; scope?: string }

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomValue(length = 32) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

async function sha256(value: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

export function hasTraqConfig() { return Boolean(CLIENT_ID) }
export function getAccessToken() { return sessionStorage.getItem('traq_access_token') }

export async function beginTraqLogin() {
  if (!CLIENT_ID) throw new Error('OAuth Client IDが設定されていません')
  const verifier = randomValue(64)
  const state = randomValue()
  sessionStorage.setItem('traq_pkce_verifier', verifier)
  sessionStorage.setItem('traq_oauth_state', state)
  const params = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: 'read', state, code_challenge: await sha256(verifier), code_challenge_method: 'S256',
  })
  location.assign(`${API}/oauth2/authorize?${params}`)
}

export async function finishTraqLogin() {
  const query = new URLSearchParams(location.search)
  const code = query.get('code')
  if (!code) return false
  const expectedState = sessionStorage.getItem('traq_oauth_state')
  const verifier = sessionStorage.getItem('traq_pkce_verifier')
  if (!expectedState || query.get('state') !== expectedState || !verifier) throw new Error('OAuth応答を検証できませんでした')
  const body = new URLSearchParams({
    grant_type: 'authorization_code', client_id: CLIENT_ID, code,
    redirect_uri: REDIRECT_URI, code_verifier: verifier,
  })
  const response = await fetch(`${API}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  })
  if (!response.ok) throw new Error(`トークン交換に失敗しました (${response.status})`)
  const token = await response.json() as TokenResponse
  sessionStorage.setItem('traq_access_token', token.access_token)
  sessionStorage.removeItem('traq_pkce_verifier'); sessionStorage.removeItem('traq_oauth_state')
  history.replaceState({}, '', import.meta.env.BASE_URL)
  return true
}

export async function fetchTraqUsers(): Promise<TraqUser[]> {
  const token = getAccessToken()
  if (!token) return []
  const response = await fetch(`${API}/users?include-suspended=false`, { headers: { Authorization: `Bearer ${token}` } })
  if (response.status === 401) { logoutTraq(); throw new Error('ログインの有効期限が切れました') }
  if (!response.ok) throw new Error(`ユーザー取得に失敗しました (${response.status})`)
  return await response.json() as TraqUser[]
}

export function logoutTraq() { sessionStorage.removeItem('traq_access_token') }
