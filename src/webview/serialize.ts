/** Serializes a Blockly workspace to the XML text written back to the file. */

/**
 * Produces MakeCode-compatible `.blocks` XML for `workspace`.
 *
 * Block ids are deliberately kept: preserving them keeps the file's diff small
 * when one block changes, which is what lets concurrent Live Share edits to
 * different blocks merge instead of colliding.
 */
export function serializeWorkspace(workspace: any): string {
  const dom = Blockly.Xml.workspaceToDom(workspace);

  // Blockly 13's `workspaceToDom` emits blocks only — variable declarations
  // moved to its JSON serializer. Writing that back would silently delete the
  // `<variables>` section every MakeCode file carries, so re-attach it here, as
  // the first child, where MakeCode expects it.
  const variables = allVariables(workspace);
  if (variables.length > 0) {
    dom.insertBefore(Blockly.Xml.variablesToDom(variables), dom.firstChild);
  }

  return `${Blockly.Xml.domToPrettyText(dom)}\n`;
}

/** Reads the workspace's variables across Blockly's pre- and post-13 APIs. */
function allVariables(workspace: any): unknown[] {
  if (typeof workspace.getVariableMap === 'function') {
    return workspace.getVariableMap().getAllVariables();
  }
  return workspace.getAllVariables();
}
