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

function menu(properties, state) {
  const labels = ["plugins-menu-view-only", "plugins-menu-dev-import-from-manifest", "widgets.development"];
  return { isReadOnly: properties.isReadOnly, editorType: properties.editorType, canView: visible(state), labels };
}

function published(state) {
  return {
    isReadOnly: state.mirror.appModel.isReadOnly,
    userCanViewPlugins: visible(state),
    userCanRunExtensions: runnable(state),
    publishedPlugins: state.publishedPlugins,
  };
}

function editor(state) {
  return {
    publishedPlugins: state.publishedPlugins,
    userCanRunExtensions: runnable(state),
    editorType: state.selectedView.editorType,
    isReadOnly: state.mirror.appModel.isReadOnly,
    userCanViewPlugins: visible(state),
  };
}

globalThis.fixture = { visible, runnable, menu, published, editor };
