// Задняя камера планшета — один модуль на все экраны, где надо снимать
// (раунд уборки и эталонные фото). Причина выносить: поток надо не только
// открыть, но и ГАРАНТИРОВАННО закрыть (иначе на планшете горит индикатор и
// садится батарея), а забыть про stop() легко, когда код скопирован на два экрана.
//
// Поток в приложении всегда один: открывая новый, закрываем предыдущий.
import { t } from './i18n.js';

let stream = null;

export function isCameraOn() { return !!stream; }

export async function startCamera(videoEl, { facing = 'environment', width = 1920 } = {}) {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    const e = new Error('no-getusermedia'); e.name = 'NotSupportedError'; throw e;
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: width } }, audio: false,
  });
  videoEl.srcObject = stream;
  await videoEl.play();
  return stream;
}

export function stopCamera() {
  if (!stream) return;
  stream.getTracks().forEach(t => t.stop());
  stream = null;
}

// Экран уходит из вида (вкладка, блокировка планшета) — камеру гасим.
if (typeof window !== 'undefined') window.addEventListener('pagehide', stopCamera);

// Текст для ребёнка вместо кода ошибки. Отказ в разрешении — не тупик:
// экраны показывают кнопку «Сделать фото» (<input capture>).
export function cameraErrorText(e) {
  const name = e?.name || '';
  if (name === 'NotAllowedError') return t('camera.notAllowed');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return t('camera.notFound');
  return t('camera.unavailable');
}
