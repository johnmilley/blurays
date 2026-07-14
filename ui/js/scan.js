// Camera barcode scanning via the BarcodeDetector API (Chrome on Android —
// i.e. the phone this PWA is built for). Where unsupported the scan buttons
// stay hidden and barcodes are typed (a USB scanner types digits anyway).

const FORMATS = ["ean_13", "upc_a", "ean_8", "upc_e"];

export function scanSupported() {
  return "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
}

let stream = null;
let raf = 0;

/** Open the camera into `video` and resolve with the first barcode read.
 * Resolves null if `stopScan` is called first. Rejects if the camera is
 * unavailable. */
export async function startScan(video) {
  const detector = new BarcodeDetector({ formats: FORMATS });
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  return new Promise((resolve) => {
    const tick = async () => {
      if (!stream) return resolve(null);
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          const value = codes[0].rawValue;
          stopScan(video);
          navigator.vibrate?.(80);
          return resolve(value);
        }
      } catch {
        // detector can throw while the video warms up; keep trying
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
}

export function stopScan(video) {
  cancelAnimationFrame(raf);
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (video) video.srcObject = null;
}
