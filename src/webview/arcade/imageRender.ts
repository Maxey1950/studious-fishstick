/** Draws Arcade sprite images, for both the on-block preview and the painter. */
import palette from '../../generated/arcade-palette.json';
import type { ArcadeImage } from './imageLiteral';

export const ARCADE_PALETTE = palette as string[];

/** Index 0 is the transparent slot, drawn as a checkerboard rather than black. */
export const TRANSPARENT_INDEX = 0;

export function colourOf(index: number): string {
  return ARCADE_PALETTE[index] ?? '#000000';
}

/**
 * Renders an image to a data URI for the block preview.
 *
 * One device pixel per image pixel; the preview is scaled up by CSS with
 * `image-rendering: pixelated`, so the art stays crisp instead of blurring.
 */
export function toDataUri(image: ArcadeImage): string {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;

  const context = canvas.getContext('2d');
  if (!context) {
    return '';
  }

  const data = context.createImageData(image.width, image.height);
  for (let i = 0; i < image.pixels.length; i++) {
    const index = image.pixels[i];
    const offset = i * 4;
    if (index === TRANSPARENT_INDEX) {
      data.data[offset + 3] = 0;
      continue;
    }
    const [r, g, b] = hexToRgb(colourOf(index));
    data.data[offset] = r;
    data.data[offset + 1] = g;
    data.data[offset + 2] = b;
    data.data[offset + 3] = 255;
  }

  context.putImageData(data, 0, 0);
  return canvas.toDataURL('image/png');
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
