import * as assert from 'assert';
import * as vscode from 'vscode';

// You can import and use your extension code here for testing
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test: Check if commands are registered', async () => {
        // Get all registered commands from package.json
        const allCommands = await vscode.commands.getCommands(true);

        const ourCommands = [
            'lollms_to_vs_code.openPanel',
            'lollms_to_vs_code.generateContext',
            'lollms_to_vs_code.setContextFull'
        ];

        for (const cmd of ourCommands) {
            assert.ok(allCommands.includes(cmd), `Command '${cmd}' should be registered.`);
        }
	});
});