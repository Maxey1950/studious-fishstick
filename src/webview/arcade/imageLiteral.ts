/**
 * Reading and writing MakeCode Arcade sprite images.
 *
 * An image is stored in the block's field as a TypeScript template literal:
 *
 *     img`
 *     . . . . . . . .
 *     . . . 3 3 . . .
 *     `
 *
 * One token per pixel — a hex digit naming a palette index, or `.` for the
 * transparent slot 0.
 */

export interface ArcadeImage {
  width: number;
  height: number;
  /** Palette indices, row-major, `height * width` long. */
  pixels: Uint8Array;
}

const EMPTY_TOKEN = '.';

/**
 * Parses an image literal. Returns undefined for anything that is not one, so
 * callers can leave an unrecognized value untouched rather than mangling it.
 */
export function parseImageLiteral(text: string): ArcadeImage | undefined {
  const match = /^\s*img\s*`([^]*)`\s*$/.exec(text);
  if (!match) {
    return undefined;
  }

  const rows = match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/));

  if (rows.length === 0) {
    return undefined;
  }

  const width = Math.max(...rows.map((row) => row.length));
  const height = rows.length;
  const pixels = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      pixels[y * width + x] = tokenToIndex(rows[y][x]);
    }
  }

  return { width, height, pixels };
}

/** Writes an image back in MakeCode's own layout: one token per pixel, each
 * followed by a space, one row per line. */
export function formatImageLiteral(image: ArcadeImage): string {
  const lines: string[] = [];
  for (let y = 0; y < image.height; y++) {
    let line = '';
    for (let x = 0; x < image.width; x++) {
      line += `${indexToToken(image.pixels[y * image.width + x])} `;
    }
    lines.push(line);
  }
  return `img\`\n${lines.join('\n')}\n\``;
}

export function createImage(width: number, height: number): ArcadeImage {
  return { width, height, pixels: new Uint8Array(width * height) };
}

export function cloneImage(image: ArcadeImage): ArcadeImage {
  return { width: image.width, height: image.height, pixels: new Uint8Array(image.pixels) };
}

function tokenToIndex(token: string): number {
  if (token === EMPTY_TOKEN) {
    return 0;
  }
  const value = Number.parseInt(token, 16);
  return Number.isNaN(value) || value < 0 || value > 15 ? 0 : value;
}

function indexToToken(index: number): string {
  return index === 0 ? EMPTY_TOKEN : index.toString(16);
}
