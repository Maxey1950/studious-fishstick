/**
 * Registers the Arcade block library with Blockly, and makes every block
 * tolerant of the parts of MakeCode's format this editor does not model.
 *
 * Tolerance is the point. The generated definitions are derived from MakeCode's
 * metadata, but a few details of how pxt writes `.blocks` XML — the field names
 * on enum dropdowns, the `<mutation>` on expandable blocks — could not be
 * confirmed against a real Arcade file. Blockly silently discards fields and
 * mutations a block does not declare, which on save would delete parts of
 * someone's game. So anything unrecognized is captured and written back out
 * unchanged, whether or not the guesses were right.
 */
import arcadeBlocks from '../../generated/arcade-blocks.json';
import { CORE_BLOCKS } from './coreBlocks';
import { installColourField } from './colourField';
import { absorbUnknownDropdownValues, registerArcadeDropdowns } from './dropdowns';
import { installImageField } from './imageField';

let registered = false;

export function registerArcadeBlocks(): number {
  if (registered) {
    return 0;
  }
  // Custom fields must exist before any block definition referring to them.
  installImageField();
  installColourField();

  const definitions = [...(arcadeBlocks as unknown as Record<string, unknown>[]), ...CORE_BLOCKS];
  Blockly.defineBlocksWithJsonArray(definitions);
  const dropdowns = registerArcadeDropdowns();

  for (const definition of definitions) {
    preserveUnknownMutations(String(definition.type));
  }

  registered = true;
  return definitions.length + dropdowns;
}

/**
 * Keeps a `<mutation>` element the definition does not understand, so it
 * survives a load/save round trip.
 */
function preserveUnknownMutations(type: string): void {
  const block = Blockly.Blocks[type];
  if (!block || block.mutationToDom || block.domToMutation) {
    return;
  }
  block.mutationToDom = function (this: any): Element | null {
    return this.savedArcadeMutation ? (this.savedArcadeMutation.cloneNode(true) as Element) : null;
  };
  block.domToMutation = function (this: any, mutation: Element): void {
    this.savedArcadeMutation = mutation.cloneNode(true) as Element;
  };
}

/**
 * Adds a field to a block definition for every `<field>` in the document that
 * the definition does not already declare.
 *
 * Called before loading, because Blockly drops unknown fields with only a
 * console warning — which would quietly strip, for example, an enum selection
 * whose field name does not match what this editor generated.
 */
export function preserveUnknownFields(dom: Element): string[] {
  const added: string[] = [];

  // Done first: a kind the game defines for itself is a known field with an
  // unknown *value*, and belongs in the dropdown rather than in a text stand-in.
  absorbUnknownDropdownValues(dom);

  for (const element of Array.from(dom.querySelectorAll('block, shadow'))) {
    const type = element.getAttribute('type');
    if (!type || !Blockly.Blocks[type]) {
      continue;
    }

    for (const field of Array.from(element.children)) {
      if (field.tagName.toLowerCase() !== 'field') {
        continue;
      }
      const name = field.getAttribute('name');
      if (!name || blockDeclaresField(type, name)) {
        continue;
      }
      appendField(type, name);
      added.push(`${type}.${name}`);
    }
  }

  return added;
}

/** Field names a block declares, cached per block type. */
const declaredFields = new Map<string, Set<string>>();

/** A throwaway workspace used only to inspect what a block declares. */
let probeWorkspace: any;

function blockDeclaresField(type: string, name: string): boolean {
  let names = declaredFields.get(type);
  if (!names) {
    names = collectDeclaredFields(type);
    declaredFields.set(type, names);
  }
  return names.has(name);
}

/**
 * Reads a block's field names off a real instance.
 *
 * Blockly builds JSON definitions into an `init` that calls `jsonInit`, so the
 * declared fields are not readable from the definition object — but they are
 * plain to see on a constructed block. This also covers Blockly's own built-in
 * blocks, whose definitions this editor never sees.
 */
function collectDeclaredFields(type: string): Set<string> {
  const names = new Set<string>();
  if (!Blockly.Blocks[type]) {
    return names;
  }

  if (!probeWorkspace) {
    probeWorkspace = new Blockly.Workspace();
  }

  let probe: any;
  try {
    probe = probeWorkspace.newBlock(type);
    for (const input of probe.inputList ?? []) {
      for (const field of input.fieldRow ?? []) {
        if (field.name) {
          names.add(field.name);
        }
      }
    }
  } catch {
    // A block that cannot be constructed headlessly tells us nothing; treating
    // it as declaring no fields is safe, since the worst outcome is preserving
    // a field it already had.
  } finally {
    probe?.dispose(false);
  }

  for (const name of (Blockly.Blocks[type] as any).arcadeExtraFields ?? []) {
    names.add(name);
  }
  return names;
}

/**
 * Extends a registered block with an extra text field, preserving whatever the
 * document stored under that name.
 */
function appendField(type: string, name: string): void {
  const definition = Blockly.Blocks[type] as any;
  if (!definition) {
    return;
  }

  const originalInit = definition.init;
  definition.arcadeExtraFields = [...(definition.arcadeExtraFields ?? []), name];
  declaredFields.get(type)?.add(name);

  definition.init = function (this: any): void {
    originalInit.call(this);
    // Hidden behind the block's own label: it exists to carry the value, not to
    // add visual noise to a block that already looks right.
    this.appendDummyInput(`ARCADE_EXTRA_${name}`).appendField(
      new Blockly.FieldTextInput(''),
      name
    );
  };
}
