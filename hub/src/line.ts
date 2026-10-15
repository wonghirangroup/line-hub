// ไคลเอนต์ LINE จริง (Messaging API + ตรวจ LIFF ID token) — ใช้ fetch ในตัวของ Node
import { HttpError, type LineApi, type LineIdentity } from './types.js'

export interface LineClientOptions {
  accessToken: string
  loginChannelId: string
  apiBase?: string // ใช้ชี้เซิร์ฟเวอร์จำลองตอนเทสต์
  dataApiBase?: string
}

export class LineClient implements LineApi {
  private base: string
  private dataBase: string
  constructor(private o: LineClientOptions) {
    this.base = o.apiBase ?? 'https://api.line.me'
    this.dataBase = o.dataApiBase ?? 'https://api-data.line.me'
  }

  private async call(method: string, pathname: string, opts: { json?: unknown; form?: URLSearchParams; allow404?: boolean } = {}) {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.o.accessToken}` }
    let body: BodyInit | undefined
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json) }
    const res = await fetch(`${this.base}${pathname}`, { method, headers, body })
    const text = await res.text()
    if (opts.allow404 && res.status === 404) return null
    if (!res.ok) throw new Error(`LINE ${method} ${pathname} → ${res.status} ${text}`)
    return text ? JSON.parse(text) : {}
  }

  async verifyIdToken(idToken: string): Promise<LineIdentity> {
    const res = await fetch(`${this.base}/oauth2/v2.1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: this.o.loginChannelId }),
    })
    if (!res.ok) throw new HttpError(401, 'ID token ไม่ถูกต้องหรือหมดอายุ', 'INVALID_ID_TOKEN')
    const data = (await res.json()) as { sub?: string; name?: string }
    if (!data.sub) throw new HttpError(401, 'ID token ไม่ถูกต้อง', 'INVALID_ID_TOKEN')
    return { sub: data.sub, name: data.name ?? null }
  }

  async getAliasMenuId(alias: string) {
    const r = (await this.call('GET', `/v2/bot/richmenu/alias/${encodeURIComponent(alias)}`, { allow404: true })) as { richMenuId?: string } | null
    return r?.richMenuId ?? null
  }
  async linkMenu(lineUserId: string, richMenuId: string) {
    await this.call('POST', `/v2/bot/user/${encodeURIComponent(lineUserId)}/richmenu/${encodeURIComponent(richMenuId)}`)
  }
  async botInfo() {
    const r = (await this.call('GET', '/v2/bot/info')) as { displayName?: string; basicId?: string }
    return { displayName: r.displayName ?? '', basicId: r.basicId ?? '' }
  }
  async webhookEndpoint() {
    const r = (await this.call('GET', '/v2/bot/channel/webhook/endpoint')) as { endpoint?: string; active?: boolean }
    return { endpoint: r.endpoint ?? '', active: !!r.active }
  }
  async listMenus() {
    const r = (await this.call('GET', '/v2/bot/richmenu/list')) as { richmenus?: { richMenuId: string; name: string }[] }
    return (r.richmenus ?? []).map(m => ({ richMenuId: m.richMenuId, name: m.name }))
  }
  async createMenu(body: unknown) {
    return ((await this.call('POST', '/v2/bot/richmenu', { json: body })) as { richMenuId: string }).richMenuId
  }
  async uploadMenuImage(richMenuId: string, data: Buffer, contentType: string) {
    // ภาพต้องส่งไปที่ api-data.line.me
    const res = await fetch(`${this.dataBase}/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.o.accessToken}`, 'Content-Type': contentType }, body: new Uint8Array(data),
    })
    if (!res.ok) throw new Error(`LINE upload image → ${res.status} ${await res.text()}`)
  }
  async deleteMenu(richMenuId: string) { await this.call('DELETE', `/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`) }
  async listAliases() {
    const r = (await this.call('GET', '/v2/bot/richmenu/alias/list')) as { aliases?: { richMenuAliasId: string; richMenuId: string }[] }
    return r.aliases ?? []
  }
  async createAlias(alias: string, richMenuId: string) { await this.call('POST', '/v2/bot/richmenu/alias', { json: { richMenuAliasId: alias, richMenuId } }) }
  async deleteAlias(alias: string) { await this.call('DELETE', `/v2/bot/richmenu/alias/${encodeURIComponent(alias)}`) }
  async setDefaultMenu(richMenuId: string) { await this.call('POST', `/v2/bot/user/all/richmenu/${encodeURIComponent(richMenuId)}`) }

  async unlinkMenu(lineUserId: string) {
    await this.call('DELETE', `/v2/bot/user/${encodeURIComponent(lineUserId)}/richmenu`, { allow404: true })
  }
}
