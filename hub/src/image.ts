// อ่านชนิด/ขนาดภาพจากไบต์ (PNG, JPEG) โดยไม่ต้องใช้ไลบรารี — ใช้ตรวจภาพ Rich Menu ก่อนอัปโหลด

export interface ImageInfo { type: 'image/png' | 'image/jpeg'; width: number; height: number }

export function imageInfo(buf: Buffer): ImageInfo | null {
  // PNG: signature 8 ไบต์ แล้ว IHDR (กว้าง/สูงที่ offset 16/20)
  if (buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // JPEG: เดินตาม marker จนเจอ SOF (C0–CF ยกเว้น C4, C8, CC)
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]!
      if (marker === 0xff) { i++; continue }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  return null
}
