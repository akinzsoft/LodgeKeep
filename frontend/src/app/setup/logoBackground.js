/**
 * Does this logo have a solid background rather than a transparent one?
 * Judged from its four corners: a logo drawn on a transparent canvas has
 * (almost always) see-through corners; one exported flat — a JPG, or a PNG
 * saved with a white box — has all four fully opaque.
 *
 * @param {Uint8ClampedArray} rgba   Pixel data, 4 bytes per pixel (canvas ImageData.data).
 * @param {number} width
 * @param {number} height
 */
export function hasSolidBackground(rgba, width, height) {
  if (!rgba || width < 1 || height < 1) return false;
  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  return corners.every(([x, y]) => rgba[(y * width + x) * 4 + 3] === 255);
}

/**
 * Reads a loaded <img> through a canvas. Returns null when that isn't
 * possible (no canvas support, or an image the browser won't let a page
 * read) — the caller then simply says nothing.
 */
export function imageHasSolidBackground(img) {
  try {
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(img, 0, 0);
    return hasSolidBackground(context.getImageData(0, 0, width, height).data, width, height);
  } catch {
    return null;
  }
}
