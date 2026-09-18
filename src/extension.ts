import * as vscode from 'vscode';
import { BlocksEditorProvider } from './blocksEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new BlocksEditorProvider(context);
  context.subscriptions.push(BlocksEditorProvider.register(context, provider));

  context.subscriptions.push(
    vscode.commands.registerCommand('blocksEditor.restoreVersion', async () => {
      const uri = activeBlocksUri();
      if (!uri) {
        void vscode.window.showInformationMessage('No .blocks file is active.');
        return;
      }
      await provider.restoreVersion(uri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('blocksEditor.openAsText', async () => {
      const uri = activeBlocksUri();
      if (!uri) {
        void vscode.window.showInformationMessage('No .blocks file is active.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('blocksEditor.openAsBlocks', async () => {
      const uri = activeBlocksUri();
      if (!uri) {
        void vscode.window.showInformationMessage('No .blocks file is active.');
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        BlocksEditorProvider.viewType
      );
    })
  );
}

export function deactivate(): void {
  // Nothing to tear down; every subscription is owned by the extension context.
}

/**
 * The URI of whatever is focused, whether that is a text editor or the blocks
 * custom editor (which is not a `TextEditor` and so is absent from
 * `window.activeTextEditor`).
 */
function activeBlocksUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) {
    return input.uri;
  }
  return vscode.window.activeTextEditor?.document.uri;
}
