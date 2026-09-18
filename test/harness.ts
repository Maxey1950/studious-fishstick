/**
 * Test entry point. Re-exports the exact pieces of the webview the round-trip
 * test exercises, so the test cannot drift from the shipping code.
 */
// Bundles Blockly and publishes it as a global, exactly as the webview does.
import '../src/webview/blocklyRuntime';
// Registers MakeCode's renderer so the tests exercise what actually ships.
import '../src/webview/arcade/renderer';
export { defineStubsFor } from '../src/webview/stubBlocks';
export { serializeWorkspace } from '../src/webview/serialize';
export { parseBlocksXml } from '../src/webview/parse';
export { registerArcadeBlocks, preserveUnknownFields } from '../src/webview/arcade/register';
export { parseImageLiteral, formatImageLiteral, createImage } from '../src/webview/arcade/imageLiteral';
