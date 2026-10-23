/**
 * MakeCode Arcade's palette, taken verbatim from the target bundle's
 * `appTheme.blockColors`. Category colours for Arcade's own namespaces come
 * from the generated toolbox; these are the ones pxt supplies for the built-in
 * categories, which have no API metadata of their own.
 */
export const BUILTIN_COLOURS = {
  loops: '#20BF6B',
  logic: '#45AAF2',
  math: '#A55EEA',
  variables: '#EC3B59',
  text: '#F5D547',
  arrays: '#FF8F08',
  functions: '#1446A0',
} as const;

/** `on start` has no colour of its own in the bundle; pxt draws it as a loop. */
export const ON_START_COLOUR = BUILTIN_COLOURS.loops;
