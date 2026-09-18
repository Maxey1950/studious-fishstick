/**
 * MakeCode `.blocks` files reference block types defined by the MakeCode target
 * (`device_forever`, `basic_show_leds`, …), not by core Blockly. Loading such a
 * file into a stock Blockly workspace would throw on the first unknown type and
 * lose the file's contents.
 *
 * Instead, every unknown type is given a generated placeholder definition whose
 * shape is inferred from how the file actually uses it. The block renders as a
 * neutral stub the user can move and delete, and — crucially — serializes back
 * to the same XML, so opening a MakeCode project in this editor does not
 * silently destroy blocks it does not understand.
 */

const STUB_COLOUR = '#8A8A8A';

interface StubShape {
  fields: Set<string>;
  values: Set<string>;
  statements: Set<string>;
  /** True when the type is ever used in a `<value>` slot, i.e. it reports a value. */
  hasOutput: boolean;
}

/**
 * Defines placeholder blocks for every type in `dom` that Blockly does not
 * already know about. Returns the list of types that were stubbed.
 */
export function defineStubsFor(dom: Element): string[] {
  const shapes = collectShapes(dom);
  const stubbed: string[] = [];

  for (const [type, shape] of shapes) {
    if (Blockly.Blocks[type]) {
      continue;
    }
    Blockly.Blocks[type] = createStub(type, shape);
    stubbed.push(type);
  }

  return stubbed;
}

function collectShapes(dom: Element): Map<string, StubShape> {
  const shapes = new Map<string, StubShape>();

  for (const element of Array.from(dom.querySelectorAll('block, shadow'))) {
    const type = element.getAttribute('type');
    if (!type) {
      continue;
    }

    let shape = shapes.get(type);
    if (!shape) {
      shape = { fields: new Set(), values: new Set(), statements: new Set(), hasOutput: false };
      shapes.set(type, shape);
    }

    // Only direct children describe *this* block's own inputs; descendants
    // belong to nested blocks.
    for (const child of Array.from(element.children)) {
      const name = child.getAttribute('name');
      if (!name) {
        continue;
      }
      switch (child.tagName.toLowerCase()) {
        case 'field':
          shape.fields.add(name);
          break;
        case 'value':
          shape.values.add(name);
          break;
        case 'statement':
          shape.statements.add(name);
          break;
      }
    }

    const parentTag = element.parentElement?.tagName.toLowerCase();
    if (parentTag === 'value') {
      shape.hasOutput = true;
    }
  }

  return shapes;
}

function createStub(type: string, shape: StubShape): Record<string, unknown> {
  return {
    /** Stored verbatim so an unrecognized `<mutation>` survives a round trip. */
    savedMutation: null as Element | null,

    init(this: any): void {
      this.setColour(STUB_COLOUR);
      this.setTooltip(
        `"${type}" is not a block this editor knows how to draw. It is shown as a ` +
          `placeholder and will be saved back to the file unchanged.`
      );
      this.appendDummyInput().appendField(type);

      for (const name of shape.fields) {
        this.appendDummyInput().appendField(name).appendField(new Blockly.FieldTextInput(''), name);
      }
      for (const name of shape.values) {
        this.appendValueInput(name).appendField(name);
      }
      for (const name of shape.statements) {
        this.appendStatementInput(name).appendField(name);
      }

      if (shape.hasOutput) {
        this.setOutput(true);
      } else {
        this.setPreviousStatement(true);
        this.setNextStatement(true);
      }
    },

    mutationToDom(this: any): Element | null {
      return this.savedMutation ? (this.savedMutation.cloneNode(true) as Element) : null;
    },

    domToMutation(this: any, mutation: Element): void {
      this.savedMutation = mutation.cloneNode(true) as Element;
    },
  };
}
