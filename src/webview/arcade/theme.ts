/**
 * A Blockly theme that matches MakeCode Arcade.
 *
 * Arcade's own blocks carry explicit colours from the generated definitions, so
 * the theme's job is the built-in Blockly categories (logic, loops, math, text,
 * lists, variables, procedures), which otherwise render in Blockly's default
 * palette and look nothing like MakeCode.
 */
import { BUILTIN_COLOURS } from './palette';

export function createArcadeTheme(): any {
  return Blockly.Theme.defineTheme('makecode-arcade', {
    name: 'makecode-arcade',
    base: Blockly.Themes.Classic,
    blockStyles: {
      logic_blocks: { colourPrimary: BUILTIN_COLOURS.logic },
      loop_blocks: { colourPrimary: BUILTIN_COLOURS.loops },
      math_blocks: { colourPrimary: BUILTIN_COLOURS.math },
      text_blocks: { colourPrimary: BUILTIN_COLOURS.text },
      list_blocks: { colourPrimary: BUILTIN_COLOURS.arrays },
      variable_blocks: { colourPrimary: BUILTIN_COLOURS.variables },
      variable_dynamic_blocks: { colourPrimary: BUILTIN_COLOURS.variables },
      procedure_blocks: { colourPrimary: BUILTIN_COLOURS.functions },
    },
    categoryStyles: {
      logic_category: { colour: BUILTIN_COLOURS.logic },
      loop_category: { colour: BUILTIN_COLOURS.loops },
      math_category: { colour: BUILTIN_COLOURS.math },
      text_category: { colour: BUILTIN_COLOURS.text },
      list_category: { colour: BUILTIN_COLOURS.arrays },
      variable_category: { colour: BUILTIN_COLOURS.variables },
      procedure_category: { colour: BUILTIN_COLOURS.functions },
    },
    componentStyles: {
      // Left to the VS Code theme rather than hard-coded, so the canvas does not
      // glare white inside a dark editor.
      workspaceBackgroundColour: 'transparent',
      toolboxBackgroundColour: 'rgba(127, 127, 127, 0.08)',
      flyoutBackgroundColour: 'rgba(127, 127, 127, 0.12)',
      flyoutOpacity: 1,
      scrollbarColour: 'rgba(127, 127, 127, 0.55)',
      insertionMarkerColour: '#ffffff',
      insertionMarkerOpacity: 0.4,
    },
    startHats: true,
  });
}
