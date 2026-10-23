/**
 * Loads Blockly as a module and publishes it as a global.
 *
 * Blockly used to be loaded from a <script> tag as a UMD bundle, which made it
 * a global but left it unreachable to anything using `import ... from "blockly"`.
 * MakeCode's renderer plugin (see arcade/renderer/) imports it that way, so
 * Blockly is now bundled properly and re-published as a global for the code in
 * this webview that still reads it that way.
 *
 * Import this module before anything that touches Blockly.
 */
import * as Blockly from 'blockly';

(globalThis as unknown as { Blockly: unknown }).Blockly = Blockly;

export { Blockly };
