/**
 * Builds the Arcade toolbox: the generated categories (Sprites, Controller,
 * Game, Scene, Music…) followed by MakeCode's built-in ones, with Advanced
 * categories tucked behind a separator the way Arcade does it.
 */
import toolboxData from '../../generated/arcade-toolbox.json';
import { BUILTIN_COLOURS } from './palette';

interface GeneratedCategory {
  name: string;
  namespace: string;
  colour: string;
  icon: string;
  weight: number;
  advanced: boolean;
  blocks: { type: string; shadows: Record<string, ShadowSpec>; fields: Record<string, string> }[];
}

interface ShadowSpec {
  type: string;
  value?: string;
}

export function buildArcadeToolbox(): any {
  const categories = toolboxData as unknown as GeneratedCategory[];
  injectIconStyles(categories);

  const builtIns = builtInCategories();
  const builtInNames = new Set(builtIns.map((category) => category.name));

  // Arcade defines some blocks (`pause`, `pick random`) in namespaces that share
  // a name with a built-in category. MakeCode shows one merged category, so the
  // generated blocks are folded in rather than producing a second "Loops".
  for (const builtIn of builtIns) {
    const generated = categories.find((c) => c.name === builtIn.name);
    if (generated && builtIn.contents) {
      builtIn.contents.push(...generated.blocks.map(toBlock));
    }
  }

  const contents: any[] = [];
  for (const category of categories) {
    if (category.advanced || builtInNames.has(category.name)) {
      continue;
    }
    contents.push(toCategory(category));
  }

  contents.push({ kind: 'sep' });
  contents.push(...builtIns);

  const advanced = categories.filter((c) => c.advanced && !builtInNames.has(c.name));
  if (advanced.length > 0) {
    contents.push({ kind: 'sep' });
    contents.push({
      kind: 'category',
      name: 'Advanced',
      colour: '#7B8794',
      contents: advanced.map(toCategory),
    });
  }

  return { kind: 'categoryToolbox', contents };
}

/**
 * MakeCode names its category icons by codepoint in a bundled font. Blockly
 * escapes category labels, so the glyph cannot be smuggled into the name — it
 * goes on the category's icon element through a generated CSS class instead.
 */
function injectIconStyles(categories: GeneratedCategory[]): void {
  const codepoints = new Set<string>();
  for (const category of categories) {
    if (category.icon) {
      codepoints.add(category.icon.codePointAt(0)!.toString(16));
    }
  }
  if (codepoints.size === 0 || document.getElementById('arcade-icon-styles')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'arcade-icon-styles';
  style.textContent = [...codepoints]
    .map((code) => `.arcade-icon-${code}::before { content: "\\${code}"; }`)
    .join('\n');
  document.head.appendChild(style);
}

function toCategory(category: GeneratedCategory): any {
  const code = category.icon ? category.icon.codePointAt(0)!.toString(16) : '';
  return {
    kind: 'category',
    name: category.name,
    colour: category.colour,
    cssConfig: {
      label: 'arcade-cat-label',
      icon: code ? `arcade-cat-icon arcade-icon-${code}` : 'arcade-cat-icon',
    },
    contents: category.blocks.map((block) => toBlock(block)),
  };
}

function toBlock(block: {
  type: string;
  shadows: Record<string, ShadowSpec>;
  fields: Record<string, string>;
}): any {
  const entry: any = { kind: 'block', type: block.type };

  const inputs: Record<string, unknown> = {};
  for (const [name, shadow] of Object.entries(block.shadows ?? {})) {
    inputs[name] = { shadow: shadowFor(shadow) };
  }
  if (Object.keys(inputs).length > 0) {
    entry.inputs = inputs;
  }

  if (block.fields && Object.keys(block.fields).length > 0) {
    entry.fields = { ...block.fields };
  }
  return entry;
}

/** Gives each shadow its default value, so a block dragged out is ready to run. */
function shadowFor(shadow: ShadowSpec): any {
  const value = shadow.value;
  switch (shadow.type) {
    case 'math_number':
    case 'math_integer':
    case 'math_whole_number':
      return { type: 'math_number', fields: { NUM: toNumber(value) } };
    case 'text':
      return { type: 'text', fields: { TEXT: stripQuotes(value) ?? '' } };
    case 'logic_boolean':
      return { type: 'logic_boolean', fields: { BOOL: value === 'false' ? 'FALSE' : 'TRUE' } };
    case 'variables_get':
      return { type: 'variables_get', fields: { VAR: stripQuotes(value) ?? 'mySprite' } };
    default:
      return value === undefined
        ? { type: shadow.type }
        : { type: shadow.type, fields: { value: stripQuotes(value) } };
  }
}

function toNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stripQuotes(value: string | undefined): string | undefined {
  return value?.replace(/^["'](.*)["']$/, '$1');
}

/** The categories pxt supplies itself, in Arcade's order and colours. */
function builtInCategories(): any[] {
  return [
    {
      kind: 'category',
      name: 'Loops',
      colour: BUILTIN_COLOURS.loops,
      contents: [
        { kind: 'block', type: 'pxt-on-start' },
        {
          kind: 'block',
          type: 'controls_repeat_ext',
          inputs: { TIMES: { shadow: { type: 'math_number', fields: { NUM: 4 } } } },
        },
        {
          kind: 'block',
          type: 'device_while',
          inputs: { COND: { shadow: { type: 'logic_boolean', fields: { BOOL: 'TRUE' } } } },
        },
        {
          kind: 'block',
          type: 'controls_simple_for',
          inputs: { TO: { shadow: { type: 'math_number', fields: { NUM: 4 } } } },
        },
      ],
    },
    {
      kind: 'category',
      name: 'Logic',
      colour: BUILTIN_COLOURS.logic,
      contents: [
        { kind: 'block', type: 'controls_if' },
        { kind: 'block', type: 'logic_compare' },
        { kind: 'block', type: 'logic_operation' },
        { kind: 'block', type: 'logic_negate' },
        { kind: 'block', type: 'logic_boolean' },
      ],
    },
    {
      kind: 'category',
      name: 'Variables',
      colour: BUILTIN_COLOURS.variables,
      custom: 'VARIABLE',
    },
    {
      kind: 'category',
      name: 'Math',
      colour: BUILTIN_COLOURS.math,
      contents: [
        { kind: 'block', type: 'math_number' },
        { kind: 'block', type: 'math_arithmetic' },
        {
          kind: 'block',
          type: 'device_random',
          inputs: { limit: { shadow: { type: 'math_number', fields: { NUM: 10 } } } },
        },
        { kind: 'block', type: 'math_op2' },
        { kind: 'block', type: 'math_op3' },
        { kind: 'block', type: 'math_modulo' },
      ],
    },
    {
      kind: 'category',
      name: 'Text',
      colour: BUILTIN_COLOURS.text,
      contents: [
        { kind: 'block', type: 'text' },
        { kind: 'block', type: 'text_join' },
        { kind: 'block', type: 'text_length' },
      ],
    },
    {
      kind: 'category',
      name: 'Arrays',
      colour: BUILTIN_COLOURS.arrays,
      contents: [
        { kind: 'block', type: 'lists_create_with' },
        { kind: 'block', type: 'lists_length' },
        { kind: 'block', type: 'lists_getIndex' },
        { kind: 'block', type: 'lists_setIndex' },
      ],
    },
    {
      kind: 'category',
      name: 'Functions',
      colour: BUILTIN_COLOURS.functions,
      custom: 'PROCEDURE',
    },
  ];
}
