# Spark Code VSCode Extension

Local VSCode bridge for Spark Code Desktop.

## Development

```bash
npm install
npm run compile
```

Open this folder in VSCode, press `F5`, then run:

- `Spark Code: Connect`
- `Spark Code: Send Selection`
- `Spark Code: Send Current File`
- `Spark Code: Open App`

The extension reads `~/.sparkc/sparkcode-app-*.lock` to find the local Spark Code backend. You can override it with `sparkCode.backendUrl`.
