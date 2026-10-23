/**
 * The blocks MakeCode's editor supplies itself rather than through a target's
 * API metadata: `on start`, and pxt's variants of the standard Blockly loops,
 * math and variable blocks.
 *
 * These are written by hand because they do not appear in the Arcade target
 * bundle at all — the generator cannot see them. Their ids match the ones pxt
 * writes into `.blocks` files, so files that use them load correctly.
 */
import { BUILTIN_COLOURS, ON_START_COLOUR } from './palette';

export const CORE_BLOCKS: Record<string, unknown>[] = [
  {
    // The block every Arcade project starts with. It is top-level: no notches.
    type: 'pxt-on-start',
    message0: 'on start %1 %2',
    args0: [
      { type: 'input_dummy' },
      { type: 'input_statement', name: 'HANDLER' },
    ],
    colour: ON_START_COLOUR,
    tooltip: 'Code that runs once, when the game starts.',
    helpUrl: 'https://arcade.makecode.com/blocks/on-start',
  },
  {
    // pxt's `while` block; Blockly's own is `controls_whileUntil`.
    type: 'device_while',
    message0: 'while %1 %2 %3',
    args0: [
      { type: 'input_value', name: 'COND', check: 'Boolean' },
      { type: 'input_dummy' },
      { type: 'input_statement', name: 'DO' },
    ],
    colour: BUILTIN_COLOURS.loops,
    previousStatement: null,
    nextStatement: null,
    tooltip: 'Run code while a condition is true.',
    helpUrl: 'https://arcade.makecode.com/blocks/loops/while',
  },
  {
    type: 'pxt_controls_for',
    message0: 'for %1 from 0 to %2 %3 %4',
    args0: [
      { type: 'input_value', name: 'VAR' },
      { type: 'input_value', name: 'TO', check: 'Number' },
      { type: 'input_dummy' },
      { type: 'input_statement', name: 'DO' },
    ],
    colour: BUILTIN_COLOURS.loops,
    previousStatement: null,
    nextStatement: null,
    tooltip: 'Count from zero up to a number, running code each time.',
    helpUrl: 'https://arcade.makecode.com/blocks/loops/for',
  },
  {
    type: 'variables_change',
    message0: 'change %1 by %2',
    args0: [
      { type: 'field_variable', name: 'VAR', variable: 'item' },
      { type: 'input_value', name: 'VALUE', check: 'Number' },
    ],
    colour: BUILTIN_COLOURS.variables,
    previousStatement: null,
    nextStatement: null,
    inputsInline: true,
    tooltip: 'Add a number to a variable.',
    helpUrl: 'https://arcade.makecode.com/blocks/variables/change',
  },
  {
    type: 'device_random',
    message0: 'pick random 0 to %1',
    args0: [{ type: 'input_value', name: 'limit', check: 'Number' }],
    colour: BUILTIN_COLOURS.math,
    output: 'Number',
    inputsInline: true,
    tooltip: 'Pick a random number between zero and a limit.',
    helpUrl: 'https://arcade.makecode.com/blocks/math/random',
  },
  {
    type: 'math_op2',
    message0: '%1 of %2 and %3',
    args0: [
      {
        type: 'field_dropdown',
        name: 'op',
        options: [
          ['min', 'min'],
          ['max', 'max'],
        ],
      },
      { type: 'input_value', name: 'x', check: 'Number' },
      { type: 'input_value', name: 'y', check: 'Number' },
    ],
    colour: BUILTIN_COLOURS.math,
    output: 'Number',
    inputsInline: true,
    tooltip: 'The smaller or larger of two numbers.',
    helpUrl: '',
  },
  {
    type: 'math_op3',
    message0: 'absolute of %1',
    args0: [{ type: 'input_value', name: 'x', check: 'Number' }],
    colour: BUILTIN_COLOURS.math,
    output: 'Number',
    inputsInline: true,
    tooltip: 'The absolute value of a number.',
    helpUrl: '',
  },
];
