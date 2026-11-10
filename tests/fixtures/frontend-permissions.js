globalThis.splitChunks = globalThis.splitChunks || [];
globalThis.splitChunks.push([[1], {
  111(module, exports, load) {
const detection = {
  isDev: selected => selected.editorType === 2,
  hasDevAccess: () => true,
};

function exportAllowed({ copyExportRestrictedArgs: file }) {
  return !file || file.canExport;
}

function visible(state) {
  "use strict";
  return detection.isDev(state.selectedView)
    ? detection.hasDevAccess(state) && exportAllowed({ copyExportRestrictedArgs: state.openFile })
    : !!state.openFile?.teamId && !state.mirror.appModel.isReadOnly;
}

function runnable(state) {
  if (!state.user?.id || !state.openFile) return false;
  const { canRunExtensions: run, canAccessFullDevMode: dev } = state.openFile;
  return detection.isDev(state.selectedView) ? dev : run;
}

    load.register(exports, { alpha: () => visible, beta: () => runnable });
  },
  333(module, exports, load) {
    const privateExports = load(111);
    function nativeMenu(state, action) {
      send({ openFile: state.openFile, allSavedPlugins: {}, localExtensions: {},
        userCanViewPlugins: privateExports.alpha(state), userCanRunExtensions: privateExports.beta(state),
        publishedPlugins: state.publishedPlugins }, "osmenu", action.pluginMenuAction);
    }
    load.register(exports, { nativeMenu: () => nativeMenu });
  }
}]);
