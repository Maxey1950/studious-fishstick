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

  // Blockly 13 emits `<variables>` only for variables some block references, and
  // omits the section entirely when none do — which would silently delete the
  // declarations a MakeCode file carries for variables it has not used yet.
  // Replace whatever it produced with the workspace's complete list, in the
  // leading position MakeCode expects.
  const variables = allVariables(workspace);
  if (variables.length > 0) {
    const complete = Blockly.Xml.variablesToDom(variables);
    const existing = dom.querySelector('variables');
    if (existing) {
      dom.replaceChild(complete, existing);
    } else {
      dom.insertBefore(complete, dom.firstChild);
    }
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
