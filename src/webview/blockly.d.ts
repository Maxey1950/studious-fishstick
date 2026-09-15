/**
 * Blockly is loaded as a UMD bundle by a <script> tag rather than bundled into
 * this file, so it is only visible as a global. This is the narrow slice of its
 * surface the editor actually touches.
 */
declare const Blockly: any;

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
