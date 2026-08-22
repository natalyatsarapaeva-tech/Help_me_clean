// Пайплайн фото «Наведи и убери» (перенос Twin js/image.js).
// Кадр для сканера сжимается до 1024px по длинной стороне, JPEG q=0.7 (§228).
// Эталонные фото — до 1600px. Плюс проверка яркости кадра до отправки (§470).
// Чистая математика (fitWithin, brightness) тестируется в Node.

export const MAX_SCAN = 1024;      // кадр для /scan (§228)
export const MAX_REFERENCE = 1600; // эталонное фото
export const SCAN_Q = 0.7;
export const REFERENCE_Q = 0.8;
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

function drawToCanvas(img, maxSide) {
  const { w, h } = fitWithin(img.naturalWidth, img.naturalHeight, maxSide);
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
// { blob, base64, w, h, brightness, tooDark }. Клиент решает, слать ли в /scan.
export async function prepareScanFrame(fileOrImage, { maxSide = MAX_SCAN, quality = SCAN_Q } = {}) {
  const img = fileOrImage instanceof Image ? fileOrImage : await fileToImage(fileOrImage);
  const { canvas, ctx, w, h } = drawToCanvas(img, maxSide);
  const brightness = averageBrightness(ctx.getImageData(0, 0, w, h).data);
  const blob = await canvasToBlob(canvas, quality);
  const base64 = await blobToBase64(blob);
  return { blob, base64, w, h, brightness, tooDark: isTooDark(brightness) };
}

// Эталонное фото: сжать до 1600px для загрузки в Storage.
export async function compressReference(file, { maxSide = MAX_REFERENCE, quality = REFERENCE_Q } = {}) {
  const img = await fileToImage(file);
  const { canvas, w, h } = drawToCanvas(img, maxSide);
  const blob = await canvasToBlob(canvas, quality);
  return { blob, w, h };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
