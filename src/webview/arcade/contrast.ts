/**
 * WCAG relative-luminance contrast ratio.
 *
 * Supplied locally because pxt's renderer calls `pxt.contrastRatio`, a helper
 * from the MakeCode editor that is not part of the renderer plugin. This is the
 * standard formula from WCAG 2.1, so it behaves the same way.
 */
export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(colour: string): number {
  const [r, g, b] = parseHex(colour).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseHex(colour: string): [number, number, number] {
  let hex = colour.replace('#', '');
  // pxt passes a malformed "#0000000" (seven digits) into this helper; take the
  // leading six so it reads as black rather than producing NaN.
  if (hex.length > 6) {
    hex = hex.slice(0, 6);
  }
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const value = Number.parseInt(hex, 16);
  return Number.isNaN(value)
    ? [0, 0, 0]
    : [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
