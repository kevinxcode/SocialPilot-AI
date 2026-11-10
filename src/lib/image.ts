/** Blob → data URL. */
export function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read the image'));
    r.readAsDataURL(b);
  });
}

/**
 * Downscales an image for an AI vision request (long side ≤ maxSide, JPEG): far fewer tokens and a faster answer,
 * while text on the image stays readable. Falls back to the original file where a canvas is not available.
 */
export async function shrinkImage(b: Blob, maxSide = 1024, quality = 0.85): Promise<string> {
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') throw new Error('no canvas');
    const bmp = await createImageBitmap(b);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#fff'; // transparent PNG → white, not black, in JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return blobToDataUrl(b);
  }
}
