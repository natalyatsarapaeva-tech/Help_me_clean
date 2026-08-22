// Пайплайн фото «Наведи и убери» (перенос Twin js/image.js).
// Кадр для сканера сжимается до 1024px по длинной стороне, JPEG q=0.7 (§228).
// Эталонные фото — до 1600px. Плюс проверка яркости кадра до отправки (§470).
// Чистая математика (fitWithin, brightness) тестируется в Node.

export const MAX_SCAN = 1024;      // кадр для /scan (§228)
export const MAX_REFERENCE = 1600; // эталонное фото
export const MAX_CARD = 900;       // карточка коллекции (её смотрят с планшета)
export const SCAN_Q = 0.7;
export const REFERENCE_Q = 0.8;
export const CARD_Q = 0.8;
export const MIN_BRIGHTNESS = 0.28; // ниже — «Включи свет» (§470)

// Вписать (w,h) в квадрат maxSide, сохранив пропорции. Не увеличивает.
export function fitWithin(w, h, maxSide) {
  if (!w || !h) return { w: 0, h: 0 };
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

// Средняя воспринимаемая яркость 0..1 по массиву RGBA (Rec.601). Чистая.
export function averageBrightness(rgba, step = 4) {
  if (!rgba || !rgba.length) return 0;
  let sum = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4 * step) {
    sum += (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255;
    n++;
  }
  return n ? sum / n : 0;
}
export function isTooDark(brightness) { return brightness < MIN_BRIGHTNESS; }

// ── Ниже — браузерный код (canvas/Image/File), в Node не вызывается ──────────

export function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Размер источника: <img> отдаёт naturalWidth, <video> — videoWidth, canvas — width.
// Один helper, чтобы стоп-кадр с живой камеры шёл тем же путём, что и файл.
export function sourceSize(src) {
  if (!src) return { w: 0, h: 0 };
  const w = src.naturalWidth || src.videoWidth || src.width || 0;
  const h = src.naturalHeight || src.videoHeight || src.height || 0;
  return { w, h };
}

// File → Image; <img>/<video>/canvas — уже можно рисовать как есть.
async function toDrawable(source) {
  const drawable = source && typeof source === 'object'
    && ('naturalWidth' in source || 'videoWidth' in source || source.tagName === 'CANVAS');
  return drawable ? source : fileToImage(source);
}

function drawToCanvas(img, maxSide) {
  const src = sourceSize(img);
  const { w, h } = fitWithin(src.w, src.h, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx, w, h };
}

function canvasToBlob(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality));
}

// Кадр для сканера: сжать до 1024px + проверить яркость. Возвращает
// { blob, base64, url, w, h, brightness, tooDark }. Клиент решает, слать ли в /scan.
// Источник — File (галерея/`capture`), Image, <video> (стоп-кадр живой камеры)
// или canvas: подсветка потом рисуется поверх ЭТОГО кадра, поэтому важно, чтобы
// координаты от модели и картинка на экране были из одного и того же кадра.
export async function prepareScanFrame(source, { maxSide = MAX_SCAN, quality = SCAN_Q } = {}) {
  const img = await toDrawable(source);
  const { canvas, ctx, w, h } = drawToCanvas(img, maxSide);
  const brightness = averageBrightness(ctx.getImageData(0, 0, w, h).data);
  const blob = await canvasToBlob(canvas, quality);
  const base64 = await blobToBase64(blob);
  // url — для показа стоп-кадра на экране (освобождать через revokeFrame).
  return { blob, base64, url: URL.createObjectURL(blob), w, h, brightness, tooDark: isTooDark(brightness) };
}

// Эталонное фото: сжать до 1600px для загрузки в Storage. Источник — тот же
// набор, что и у кадра сканера: родитель снимает эталон живой камерой.
export async function compressReference(source, { maxSide = MAX_REFERENCE, quality = REFERENCE_Q } = {}) {
  const img = await toDrawable(source);
  const { canvas, w, h } = drawToCanvas(img, maxSide);
  const blob = await canvasToBlob(canvas, quality);
  return { blob, w, h, url: URL.createObjectURL(blob) };
}

// Карточка коллекции: родитель фотографирует наклейку/рисунок или берёт файл.
// 900px хватает: карточку смотрят в сетке на планшете, а не печатают.
export async function compressCard(source, { maxSide = MAX_CARD, quality = CARD_Q } = {}) {
  const img = await toDrawable(source);
  const { canvas, w, h } = drawToCanvas(img, maxSide);
  const blob = await canvasToBlob(canvas, quality);
  return { blob, w, h, url: URL.createObjectURL(blob) };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Освободить object URL стоп-кадра, когда он больше не на экране.
export function revokeFrame(frame) {
  if (frame?.url) URL.revokeObjectURL(frame.url);
}
