import qrcode from './vendor/qrcode-generator.js';

/**
 * @param {string} text
 * @param {{ cell?: number, margin?: number }} [opts]
 * @returns {string} SVG markup
 */
export function makeQrSvg(text, opts = {}) {
  const cell = Number.isFinite(opts.cell) ? opts.cell : 4;
  const margin = Number.isFinite(opts.margin) ? opts.margin : 2;
  const qr = qrcode(0, 'M');
  qr.addData(String(text || ''));
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + margin * 2) * cell;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" height="100%" shape-rendering="crispEdges">`,
    `<rect width="${size}" height="${size}" fill="#fff"/>`,
  ];
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        parts.push(
          `<rect x="${(c + margin) * cell}" y="${(r + margin) * cell}" width="${cell}" height="${cell}" fill="#111"/>`
        );
      }
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

export function newRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function isLocalEngineHost(hostname) {
  const h = String(hostname || '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}
