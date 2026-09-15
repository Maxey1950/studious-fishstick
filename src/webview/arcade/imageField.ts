/**
 * `field_arcade_image` — MakeCode Arcade's sprite image editor.
 *
 * On the block it draws the sprite itself; clicking it opens a pixel painter
 * with Arcade's palette. Edits flow back through the block's value into the
 * text document, which is what makes them visible to other Live Share
 * participants like any other change.
 */
import {
  type ArcadeImage,
  cloneImage,
  createImage,
  formatImageLiteral,
  parseImageLiteral,
} from './imageLiteral';
import { ARCADE_PALETTE, TRANSPARENT_INDEX, colourOf, toDataUri } from './imageRender';

const DEFAULT_SIZE = 16;
/** On-block preview size, in CSS pixels. */
const PREVIEW_MAX = 40;
/** Painter cell size, in CSS pixels. */
const CELL = 18;

class FieldArcadeImage extends Blockly.Field {
  /** The literal exactly as it was read, so an untouched image is written back
   * byte for byte rather than reformatted. */
  private originalText: string;
  private image: ArcadeImage;
  private previewElement: SVGImageElement | null = null;
  private selectedColour = 1;
  private painting = false;

  constructor(text: string) {
    super(text ?? '');
    this.originalText = text ?? '';
    this.image = parseImageLiteral(this.originalText) ?? createImage(DEFAULT_SIZE, DEFAULT_SIZE);
    this.SERIALIZABLE = true;
    this.CURSOR = 'pointer';
  }

  static fromJson(options: { text?: string }): FieldArcadeImage {
    return new FieldArcadeImage(options.text ?? '');
  }

  /** Keeps whatever the document held; only an edit rewrites it. */
  protected doClassValidation_(value?: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  protected doValueUpdate_(value: string): void {
    super.doValueUpdate_(value);
    this.originalText = value;
    this.image = parseImageLiteral(value) ?? createImage(DEFAULT_SIZE, DEFAULT_SIZE);
  }

  initView(): void {
    this.previewElement = Blockly.utils.dom.createSvgElement(
      'image',
      { height: `${PREVIEW_MAX}px`, width: `${PREVIEW_MAX}px`, x: '4', y: '2' },
      this.fieldGroup_
    ) as SVGImageElement;
    // Keeps the art crisp when a 16x16 sprite is blown up to 40px.
    this.previewElement.style.imageRendering = 'pixelated';
    this.updatePreview();
  }

  protected render_(): void {
    this.updatePreview();
    this.size_.width = PREVIEW_MAX + 8;
    this.size_.height = PREVIEW_MAX + 4;
  }

  getText(): string {
    return `${this.image.width}x${this.image.height} image`;
  }

  private updatePreview(): void {
    if (!this.previewElement) {
      return;
    }
    // Fit the sprite inside the preview box without distorting its aspect ratio.
    const scale = PREVIEW_MAX / Math.max(this.image.width, this.image.height);
    const width = Math.round(this.image.width * scale);
    const height = Math.round(this.image.height * scale);
    this.previewElement.setAttribute('width', `${width}`);
    this.previewElement.setAttribute('height', `${height}`);
    this.previewElement.setAttribute('x', `${4 + (PREVIEW_MAX - width) / 2}`);
    this.previewElement.setAttribute('y', `${2 + (PREVIEW_MAX - height) / 2}`);
    this.previewElement.setAttributeNS(
      'http://www.w3.org/1999/xlink',
      'xlink:href',
      toDataUri(this.image)
    );
  }

  protected showEditor_(): void {
    const draft = cloneImage(this.image);
    const editor = document.createElement('div');
    editor.className = 'arcade-painter';

    const grid = this.buildGrid(draft);
    editor.appendChild(grid.element);
    editor.appendChild(this.buildPalette());
    editor.appendChild(this.buildActions(draft, grid.redraw));

    Blockly.DropDownDiv.getContentDiv().appendChild(editor);
    Blockly.DropDownDiv.setColour('var(--vscode-editorWidget-background, #fff)', '#8888');
    Blockly.DropDownDiv.showPositionedByField(this, () => {
      this.painting = false;
      Blockly.Events.setGroup(false);
      editor.remove();
    });
  }

  /** The paint surface: one canvas, hit-tested to cells. */
  private buildGrid(draft: ArcadeImage): { element: HTMLElement; redraw: () => void } {
    const canvas = document.createElement('canvas');
    canvas.width = draft.width * CELL;
    canvas.height = draft.height * CELL;
    canvas.className = 'arcade-painter-canvas';

    const context = canvas.getContext('2d')!;
    const redraw = (): void => drawGrid(context, draft);
    redraw();

    const paintAt = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor(((event.clientX - rect.left) / rect.width) * draft.width);
      const y = Math.floor(((event.clientY - rect.top) / rect.height) * draft.height);
      if (x < 0 || y < 0 || x >= draft.width || y >= draft.height) {
        return;
      }
      // Right button (or holding shift) erases, as it does in MakeCode.
      const colour = event.buttons === 2 || event.shiftKey ? TRANSPARENT_INDEX : this.selectedColour;
      const offset = y * draft.width + x;
      if (draft.pixels[offset] === colour) {
        return;
      }
      draft.pixels[offset] = colour;
      redraw();
      this.commit(draft);
    };

    canvas.addEventListener('pointerdown', (event) => {
      this.painting = true;
      canvas.setPointerCapture(event.pointerId);
      // One stroke is one undo step; without a group, dragging across the canvas
      // would leave a separate undo entry for every pixel touched.
      Blockly.Events.setGroup(true);
      paintAt(event);
      event.preventDefault();
    });
    canvas.addEventListener('pointermove', (event) => {
      if (this.painting) {
        paintAt(event);
      }
    });
    canvas.addEventListener('pointerup', () => {
      this.painting = false;
      Blockly.Events.setGroup(false);
    });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    return { element: canvas, redraw };
  }

  private buildPalette(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'arcade-painter-palette';

    ARCADE_PALETTE.forEach((_, index) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'arcade-swatch';
      swatch.title = index === TRANSPARENT_INDEX ? 'Transparent' : `Colour ${index.toString(16)}`;
      if (index === TRANSPARENT_INDEX) {
        swatch.classList.add('arcade-swatch-transparent');
      } else {
        swatch.style.background = colourOf(index);
      }
      if (index === this.selectedColour) {
        swatch.classList.add('arcade-swatch-selected');
      }
      swatch.addEventListener('click', () => {
        this.selectedColour = index;
        for (const other of Array.from(row.children)) {
          other.classList.remove('arcade-swatch-selected');
        }
        swatch.classList.add('arcade-swatch-selected');
      });
      row.appendChild(swatch);
    });

    return row;
  }

  private buildActions(draft: ArcadeImage, redraw: () => void): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'arcade-painter-actions';

    const size = document.createElement('span');
    size.className = 'arcade-painter-size';
    size.textContent = `${draft.width} × ${draft.height}`;
    bar.appendChild(size);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'arcade-painter-button';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => {
      draft.pixels.fill(TRANSPARENT_INDEX);
      redraw();
      this.commit(draft);
    });
    bar.appendChild(clear);

    return bar;
  }

  /** Writes the edit through the field, which reaches the document. */
  private commit(draft: ArcadeImage): void {
    this.setValue(formatImageLiteral(draft));
    this.updatePreview();
    if (this.sourceBlock_ && !this.sourceBlock_.isDisposed()) {
      (this.sourceBlock_ as any).render?.();
    }
  }
}

function drawGrid(context: CanvasRenderingContext2D, image: ArcadeImage): void {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const index = image.pixels[y * image.width + x];
      const left = x * CELL;
      const top = y * CELL;

      if (index === TRANSPARENT_INDEX) {
        // Checkerboard, so transparency reads as transparency and not as black.
        context.fillStyle = (x + y) % 2 === 0 ? '#f0f0f0' : '#d8d8d8';
      } else {
        context.fillStyle = colourOf(index);
      }
      context.fillRect(left, top, CELL, CELL);

      context.strokeStyle = 'rgba(0,0,0,0.18)';
      context.lineWidth = 1;
      context.strokeRect(left + 0.5, top + 0.5, CELL - 1, CELL - 1);
    }
  }
}

export function installImageField(): void {
  Blockly.fieldRegistry.register('field_arcade_image', FieldArcadeImage);
}
