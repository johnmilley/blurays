// Camera barcode scanning. Uses the native BarcodeDetector API where it
// exists (Chrome on Android); everywhere else — notably iOS Safari — falls
// back to our own EAN-13/UPC-A decoder over canvas frames (see ean13.js).

import { decodeFrame } from "./ean13.js";

const FORMATS = ["ean_13", "upc_a", "ean_8", "upc_e"];

export function scanSupported() {
  return !!navigator.mediaDevices?.getUserMedia;
}

let stream = null;
let raf = 0;
let canvas = null;

/** Open the camera into `video` and resolve with the first barcode read.
 * Resolves null if `stopScan` is called first. Rejects if the camera is
 * unavailable. */
export async function startScan(video) {
  const detector = "BarcodeDetector" in window ? new BarcodeDetector({ formats: FORMATS }) : null;

  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  // homemade decoder: require the same read twice in a row before trusting it
  let lastRead = null;
  let lastTime = 0;

  return new Promise((resolve) => {
    const tick = async () => {
      if (!stream) return resolve(null);

      let value = null;
      if (detector) {
        try {
          const codes = await detector.detect(video);
          if (codes.length) value = codes[0].rawValue;
        } catch {
          // detector can throw while the video warms up; keep trying
        }
      } else if (video.videoWidth) {
        const now = performance.now();
        if (now - lastTime > 100) {
          lastTime = now;
          const hit = decodeCanvasFrame(video);
          if (hit) {
            if (hit === lastRead) value = hit;
            lastRead = hit;
          }
        }
      }

      if (value) {
        stopScan(video);
        navigator.vibrate?.(80);
        return resolve(value);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
}

function decodeCanvasFrame(video) {
  const w = 800;
  const h = Math.round((video.videoHeight / video.videoWidth) * w);
  if (!canvas) canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 3 + data[p + 1] * 4 + data[p + 2]) >> 3;
  }
  return decodeFrame(gray, w, h);
}

export function stopScan(video) {
  cancelAnimationFrame(raf);
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (video) video.srcObject = null;
}
