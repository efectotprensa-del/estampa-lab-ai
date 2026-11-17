import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPENAI_API_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD;
const MAX_UPLOAD = 25 * 1024 * 1024;

function safeEqual(a, b) {
  const ah = createHash('sha256').update(String(a)).digest();
  const bh = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ah, bh);
}
function authorized(req) {
  if (!APP_PASSWORD) return false;
  const value = req.headers.authorization || '';
  if (!value.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = Buffer.from(value.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  return safeEqual(decoded.slice(sep + 1), APP_PASSWORD);
}

const server = http.createServer(async (req, res) => {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  };
  const send = (status, obj) => {
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  if (!APP_PASSWORD) return send(503, { error: 'Falta APP_PASSWORD en las variables del servidor.' });
  if (!authorized(req)) {
    res.writeHead(401, { ...headers, 'WWW-Authenticate': 'Basic realm="Estampa Lab AI", charset="UTF-8"' });
    return res.end('Acceso protegido. Ingresá la contraseña de Estampa Lab.');
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    return send(200, { configured: Boolean(API_KEY) });
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = await readFile(path.join(__dirname, 'estampa-lab-ai.html'));
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      return send(500, { error: 'No se encontró estampa-lab-ai.html' });
    }
  }
  if (req.method !== 'POST' || !['/api/generate', '/api/edit'].includes(req.url)) {
    return send(404, { error: 'Ruta no encontrada' });
  }
  if (!API_KEY) return send(503, { error: 'Falta OPENAI_API_KEY en las variables del servidor.' });

  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_UPLOAD) return send(413, { error: 'La solicitud supera el límite de 25 MB.' });
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    const type = req.headers['content-type'] || '';
    const boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.slice(1).find(Boolean);
    if (!boundary) return send(400, { error: 'Solicitud multipart inválida.' });

    const parts = parseMultipart(raw, boundary);
    const field = name => parts.find(p => p.name === name)?.data.toString('utf8');
    const prompt = field('prompt');
    if (!prompt) return send(400, { error: 'Falta la descripción del diseño.' });

    const allowedModels = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
    const model = allowedModels.includes(field('model')) ? field('model') : 'gpt-image-2.5-flare';
    const size = ['1024x1024', '1024x1536', '1536x1024'].includes(field('size')) ? field('size') : '1024x1024';
    const quality = ['low', 'medium', 'high', 'xhigh', 'max'].includes(field('quality')) ? field('quality') : 'high';
    const background = field('background') === 'transparent' ? 'transparent' : 'opaque';
    const n = Math.max(1, Math.min(4, Number(field('n')) || 1));
    const image = parts.find(p => p.name === 'image');
    const isEdit = req.url === '/api/edit';
    if (isEdit && !image) return send(400, { error: 'No se recibió la imagen de referencia.' });

    const endpoint = isEdit
      ? 'https://api.openai.com/v1/images/edits'
      : 'https://api.openai.com/v1/images/generations';

    let upstream;
    if (isEdit) {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('size', size);
      form.append('quality', quality);
      form.append('background', background);
      form.append('n', String(n));
      const mime = image.contentType || 'image/png';
      form.append('image', new Blob([image.data], { type: mime }), image.filename || 'reference.png');
      upstream = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}` },
        body: form
      });
    } else {
      upstream = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, size, quality, background, n, output_format: 'png' })
      });
    }

    const payload = await upstream.json();
    if (!upstream.ok) {
      const message = payload?.error?.message || `OpenAI devolvió HTTP ${upstream.status}`;
      return send(upstream.status, { error: message });
    }
    const images = (payload.data || []).filter(x => x.b64_json).map(x => ({ b64_json: x.b64_json }));
    if (!images.length) return send(502, { error: 'La API respondió sin imágenes.' });
    return send(200, { id: randomUUID(), model, images });
  } catch (err) {
    return send(500, { error: err.message || 'Error interno del servidor.' });
  }
});

function parseMultipart(buf, boundary) {
  const marker = Buffer.from('--' + boundary);
  const parts = [];
  let pos = 0;
  while ((pos = buf.indexOf(marker, pos)) !== -1) {
    pos += marker.length;
    if (buf[pos] === 45) break;
    if (buf[pos] === 13 && buf[pos + 1] === 10) pos += 2;
    const headEnd = buf.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headEnd < 0) break;
    const head = buf.subarray(pos, headEnd).toString('utf8');
    const next = buf.indexOf(marker, headEnd + 4);
    if (next < 0) break;
    let end = next;
    if (buf[end - 2] === 13 && buf[end - 1] === 10) end -= 2;
    const disp = head.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
    const name = disp.match(/name="([^"]+)"/)?.[1];
    const filename = disp.match(/filename="([^"]*)"/)?.[1];
    const contentType = head.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
    if (name) parts.push({ name, filename, contentType, data: buf.subarray(headEnd + 4, end) });
    pos = next;
  }
  return parts;
}

server.listen(PORT, '0.0.0.0', () => console.log(`Estampa Lab AI activo en puerto ${PORT}`));
