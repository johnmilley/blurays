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

// Must match #scan-reticle's `inset` in styles.css and #scan-stage's
// aspect-ratio — the fallback decoder only looks at what the reticle box
// shows the user, both so "point the barcode at the box" is literally true
// and so we're not wasting resolution decoding the whole camera frame.
const RETICLE = { top: 0.2, bottom: 0.8, left: 0.12, right: 0.88 };
const STAGE_ASPECT = 4 / 3;

/** Open the camera into `video` and resolve with the first barcode read.
 * Resolves null if `stopScan` is called first. Rejects if the camera is
 * unavailable. `onCandidate` (optional) is called with each raw decode
 * attempt from the fallback decoder — including ones not yet confirmed —
 * so the caller can show live feedback. */
export async function startScan(video, onCandidate) {
  const detector = "BarcodeDetector" in window ? new BarcodeDetector({ formats: FORMATS }) : null;

  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  // homemade decoder: require the same read three times running before
  // trusting it (checksum already rules out most noise; this rules out the
  // rest without needing the user to hold dead still for long)
  let lastRead = null;
  let streak = 0;
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
            onCandidate?.(hit);
            streak = hit === lastRead ? streak + 1 : 1;
            lastRead = hit;
            if (streak >= 3) value = hit;
          } else {
            streak = 0;
            lastRead = null;
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

// Native video pixel rect corresponding to the on-screen reticle, accounting
// for the CSS `object-fit: cover` crop between the camera's native aspect
// ratio and the stage's fixed 4:3 box.
function reticleRect(video) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  let visW = vw;
  let visH = vh;
  let offX = 0;
  let offY = 0;
  if (vw / vh > STAGE_ASPECT) {
    visW = vh * STAGE_ASPECT;
    offX = (vw - visW) / 2;
  } else {
    visH = vw / STAGE_ASPECT;
    offY = (vh - visH) / 2;
  }
  return {
    x: offX + visW * RETICLE.left,
    y: offY + visH * RETICLE.top,
    w: visW * (RETICLE.right - RETICLE.left),
    h: visH * (RETICLE.bottom - RETICLE.top),
  };
}

function decodeCanvasFrame(video) {
  const rect = reticleRect(video);
  const w = 800;
  const h = Math.round((rect.h / rect.w) * w);
  if (!canvas) canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
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
