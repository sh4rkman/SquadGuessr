// every live hint image is exactly this size
export const IMAGE_SIZE = 900;
// measured on 1000×1000 game screenshots: 0.85 ≈ 88 KB / 39 dB PSNR, 0.95 ≈ 189 KB / 42.5 dB, lossless ≈ 840 KB;
// 0.95 averages about the size of the live hint images (100–250 KB)
const WEBP_QUALITY = 0.95;

/**
 * The largest square in the middle of the image
 * @param {{width: number, height: number}} image
 * @returns {{sx: number, sy: number, size: number}}
 */
export function centredSquare({ width, height }) {
    const size = Math.min(width, height);
    return { sx: (width - size) / 2, sy: (height - size) / 2, size };
}

/**
 * A square of the image as a 900×900 webp. The image is drawn before this returns, so the caller may close it right away
 * @param {ImageBitmap} bitmap
 * @param {{sx: number, sy: number, size: number}} [crop] - defaults to the centred square
 * @returns {Promise<Blob|null>} null when the browser cannot encode webp (Safari silently hands back a png)
 */
export function squareWebp(bitmap, crop = centredSquare(bitmap)) {
    const canvas = document.createElement("canvas");
    canvas.width = IMAGE_SIZE;
    canvas.height = IMAGE_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, crop.sx, crop.sy, crop.size, crop.size, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
    return new Promise(resolve => canvas.toBlob(blob => resolve(blob?.type === "image/webp" ? blob : null), "image/webp", WEBP_QUALITY));
}
