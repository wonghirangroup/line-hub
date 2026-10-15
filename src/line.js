// ไคลเอนต์ LINE Messaging API เฉพาะส่วน Rich Menu (ใช้ fetch ในตัวของ Node ไม่มี dependency)
// LINE_API_BASE / LINE_API_DATA_BASE ใช้ชี้ไปเซิร์ฟเวอร์จำลองตอนเทสต์เท่านั้น
const API = process.env.LINE_API_BASE ?? 'https://api.line.me'
const API_DATA = process.env.LINE_API_DATA_BASE ?? 'https://api-data.line.me'

export class LineError extends Error {
  constructor(method, url, status, body) {
    super(`LINE API ${method} ${url} → ${status} ${body}`)
    this.status = status
  }
}

export class LineClient {
  constructor(token) {
    if (!token) throw new Error('ไม่พบ LINE_CHANNEL_ACCESS_TOKEN (ตั้งในไฟล์ .env)')
    this.token = token
  }

  async #req(method, url, { json, body, contentType } = {}) {
    const headers = { Authorization: `Bearer ${this.token}` }
    if (json !== undefined) headers['Content-Type'] = 'application/json'
    if (contentType) headers['Content-Type'] = contentType
    const res = await fetch(url, { method, headers, body: json !== undefined ? JSON.stringify(json) : body })
    const text = await res.text()
    if (!res.ok) throw new LineError(method, url.replace(/^https?:\/\/[^/]+/, ''), res.status, text)
    return text ? JSON.parse(text) : {}
  }

  async listMenus() { return (await this.#req('GET', `${API}/v2/bot/richmenu/list`)).richmenus ?? [] }
  async createMenu(body) { return (await this.#req('POST', `${API}/v2/bot/richmenu`, { json: body })).richMenuId }
  uploadImage(menuId, buf, contentType = 'image/jpeg') { return this.#req('POST', `${API_DATA}/v2/bot/richmenu/${menuId}/content`, { body: buf, contentType }) }
  deleteMenu(menuId) { return this.#req('DELETE', `${API}/v2/bot/richmenu/${menuId}`) }

  async listAliases() { return (await this.#req('GET', `${API}/v2/bot/richmenu/alias/list`)).aliases ?? [] }
  createAlias(aliasId, menuId) { return this.#req('POST', `${API}/v2/bot/richmenu/alias`, { json: { richMenuAliasId: aliasId, richMenuId: menuId } }) }
  deleteAlias(aliasId) { return this.#req('DELETE', `${API}/v2/bot/richmenu/alias/${aliasId}`) }

  setDefault(menuId) { return this.#req('POST', `${API}/v2/bot/user/all/richmenu/${menuId}`) }
}
