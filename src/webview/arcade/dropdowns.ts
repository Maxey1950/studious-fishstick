/**
 * Registers Arcade's enum and "kind" dropdown blocks.
 *
 * These are defined imperatively rather than as JSON because their option lists
 * have to grow. Sprite kinds are user-extensible — a game declares
 * `SpriteKind.Enemy` or `SpriteKind.Coin` and stores that value in the file —
 * and a fixed Blockly dropdown rejects any value it was not built with, which
 * would drop the selection on load and save the wrong kind back.
 */
import dropdownData from '../../generated/arcade-dropdowns.json';

interface DropdownSpec {
  type: string;
  field: string;
  options: [string, string][];
  extensible: boolean;
  /** For kinds: the `<variable type="...">` that declares the members. */
  variableType?: string;
  colour: string;
  tooltip: string;
}

/** Live option lists, keyed by block type, so they can be extended after load. */
const optionsByType = new Map<string, [string, string][]>();
const specsByType = new Map<string, DropdownSpec>();

export function registerArcadeDropdowns(): number {
  const specs = dropdownData as unknown as DropdownSpec[];

  for (const spec of specs) {
    optionsByType.set(spec.type, [...spec.options]);
    specsByType.set(spec.type, spec);

    Blockly.Blocks[spec.type] = {
      init(this: any): void {
        this.setColour(spec.colour);
        this.setOutput(true, 'Number');
        this.setTooltip(spec.tooltip);
        this.appendDummyInput().appendField(
          // A generator function makes the dropdown read the live list each time
          // it opens, so values added later appear.
          new Blockly.FieldDropdown(() => optionsByType.get(spec.type) ?? spec.options),
          spec.field
        );
      },
    };
  }

  return specs.length;
}

/**
 * Adds any dropdown values the document uses that the Arcade metadata does not
 * know about — the kinds a game defines for itself.
 *
 * Returns the values that were added, for reporting.
 */
export function absorbUnknownDropdownValues(dom: Element): string[] {
  const added: string[] = [];

  // Arcade declares its sprite kinds as typed workspace variables, so a game's
  // own kinds are listed there before any block refers to them.
  for (const variable of Array.from(dom.querySelectorAll('variable'))) {
    const variableType = variable.getAttribute('type');
    const member = variable.textContent?.trim();
    if (!variableType || !member) {
      continue;
    }
    for (const spec of specsByType.values()) {
      if (spec.variableType === variableType) {
        added.push(...addOption(spec.type, member, member));
      }
    }
  }

  for (const element of Array.from(dom.querySelectorAll('block, shadow'))) {
    const type = element.getAttribute('type');
    const spec = type ? specsByType.get(type) : undefined;
    if (!spec) {
      continue;
    }

    for (const field of Array.from(element.children)) {
      if (field.tagName.toLowerCase() !== 'field' || field.getAttribute('name') !== spec.field) {
        continue;
      }
      const value = field.textContent?.trim();
      if (!value) {
        continue;
      }

      added.push(...addOption(type!, labelFor(value), value));
    }
  }

  return added;
}

/** Adds one option to a dropdown if it is not already there. */
function addOption(type: string, label: string, value: string): string[] {
  const options = optionsByType.get(type) ?? [];
  if (options.some(([, existing]) => existing === value)) {
    return [];
  }
  options.push([label, value]);
  optionsByType.set(type, options);
  return [value];
}

/** `SpriteKind.Enemy` reads as `Enemy` in the dropdown, matching MakeCode. */
function labelFor(value: string): string {
  const dot = value.lastIndexOf('.');
  return dot === -1 ? value : value.slice(dot + 1);
}
