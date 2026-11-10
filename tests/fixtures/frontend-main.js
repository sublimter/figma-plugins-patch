globalThis.splitChunks = globalThis.splitChunks || [];
globalThis.splitChunks.push([[2], {
  222(module, exports, load) {
    const privateExports = load(111);
function menu(properties, state) {
  const labels = ["plugins-menu-view-only", "plugins-menu-dev-import-from-manifest", "widgets.development"];
  return { isReadOnly: properties.isReadOnly, editorType: properties.editorType, canView: privateExports.alpha(state), labels };
}

function published(state) {
  return {
    isReadOnly: state.mirror.appModel.isReadOnly,
    userCanViewPlugins: privateExports.alpha(state),
    userCanRunExtensions: privateExports.beta(state),
    publishedPlugins: state.publishedPlugins,
  };
}

    load.register(exports, { menu: () => menu, published: () => published });
  }
}]);
