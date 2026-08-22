const fs = require("node:fs");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

let client;

function activate(context) {
  const config = vscode.workspace.getConfiguration("glissaVisions");
  const relayPath = config.get("relayPath", "");
  const port = config.get("port", 0);

  if (!relayPath || !fs.existsSync(relayPath)) {
    vscode.window.showErrorMessage("Set glissaVisions.relayPath to session/visions-relay.js before starting Glissa Visions.");
    return;
  }

  const args = [relayPath];

  if (port > 0) {
    args.push("--port", String(port));
  }

  const serverOptions = {
    command: "node",
    args,
    transport: TransportKind.stdio
  };

  const clientOptions = {
    documentSelector: [
      { language: "markdown" }
    ]
  };

  client = new LanguageClient("glissaVisions", "Glissa Visions", serverOptions, clientOptions);
  context.subscriptions.push(client);
  client.start().catch((startError) => {
    vscode.window.showErrorMessage(`Glissa Visions failed to start: ${startError.message}`);
  });
}

function deactivate() {
  if (!client) {
    return undefined;
  }

  return client.stop();
}

module.exports = {
  activate,
  deactivate
};
