# PulSeed Example Plugins

These example plugins are TypeScript packages. Build a plugin before loading it
from `~/.pulseed/plugins`, because each `plugin.yaml` points at the compiled
`dist/index.js` entry point.

```sh
cd examples/plugins/postgres-datasource
npm install
npm run build
```

Then copy or symlink the plugin directory into your PulSeed plugins directory:

```sh
mkdir -p ~/.pulseed/plugins
ln -s "$PWD" ~/.pulseed/plugins/postgres-datasource
```

If you use a custom state directory, replace `~/.pulseed` with your
`PULSEED_HOME` path.
