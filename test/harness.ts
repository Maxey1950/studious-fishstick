/**
 * Test entry point. Re-exports the exact pieces of the webview the round-trip
 * test exercises, so the test cannot drift from the shipping code.
 */
export { defineStubsFor } from '../src/webview/stubBlocks';
export { serializeWorkspace } from '../src/webview/serialize';
export { parseBlocksXml } from '../src/webview/parse';
