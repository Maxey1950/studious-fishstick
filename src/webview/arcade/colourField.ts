/**
 * `field_arcade_colour` — picks one of Arcade's 16 palette colours.
 *
 * Arcade stores the palette *index* (a number), not a CSS colour, so this shows
 * swatches and writes back the index.
 */
import { ARCADE_PALETTE, TRANSPARENT_INDEX, colourOf } from './imageRender';

class FieldArcadeColour extends Blockly.Field {
  private swatchElement: SVGRectElement | null = null;

  constructor(text: string) {
    super(text ?? '1');
    this.SERIALIZABLE = true;
    this.CURSOR = 'pointer';
  }

  static fromJson(options: { text?: string }): FieldArcadeColour {
    return new FieldArcadeColour(options.text ?? '1');
  }

  protected doClassValidation_(value?: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
  }

  private get index(): number {
    const parsed = Number.parseInt(String(this.getValue() ?? '1'), 10);
    return Number.isFinite(parsed) && parsed >= 0 && parsed < 16 ? parsed : 1;
  }

  initView(): void {
    this.swatchElement = Blockly.utils.dom.createSvgElement(
      'rect',
      { height: '18', width: '26', x: '2', y: '2', rx: '4', stroke: 'rgba(0,0,0,0.35)' },
      this.fieldGroup_
    ) as SVGRectElement;
    this.updateSwatch();
  }

  protected render_(): void {
    this.updateSwatch();
    this.size_.width = 30;
    this.size_.height = 22;
  }

  getText(): string {
    return String(this.index);
  }

  private updateSwatch(): void {
    this.swatchElement?.setAttribute(
      'fill',
      this.index === TRANSPARENT_INDEX ? 'rgba(255,255,255,0.25)' : colourOf(this.index)
    );
  }

  protected showEditor_(): void {
    const grid = document.createElement('div');
    grid.className = 'arcade-painter-palette arcade-colour-picker';

    ARCADE_PALETTE.forEach((_, index) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'arcade-swatch';
      swatch.title = index === TRANSPARENT_INDEX ? 'Transparent' : `Colour ${index}`;
      if (index === TRANSPARENT_INDEX) {
        swatch.classList.add('arcade-swatch-transparent');
      } else {
        swatch.style.background = colourOf(index);
      }
      if (index === this.index) {
        swatch.classList.add('arcade-swatch-selected');
      }
      swatch.addEventListener('click', () => {
        this.setValue(String(index));
        this.updateSwatch();
        Blockly.DropDownDiv.hideIfOwner(this);
      });
      grid.appendChild(swatch);
    });

    Blockly.DropDownDiv.getContentDiv().appendChild(grid);
    Blockly.DropDownDiv.setColour('var(--vscode-editorWidget-background, #fff)', '#8888');
    Blockly.DropDownDiv.showPositionedByField(this, () => grid.remove());
  }
}

export function installColourField(): void {
  Blockly.fieldRegistry.register('field_arcade_colour', FieldArcadeColour);
}
