(() => {
  const button = document.getElementById('next-step');
  const openWelcome = document.getElementById('open-welcome');
  const vscode = acquireVsCodeApi();
  const dependencyStatus = document.getElementById('dependency-status');
  const dependencyProgress = document.getElementById('dependency-progress');
  const installButton = document.getElementById('install-dependencies');

  installButton?.addEventListener('click', () => {
    vscode.postMessage({ type: 'installDependencies' });
  });

  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'dependencyState') return;
    const state = event.data.state;
    dependencyStatus.textContent = state.message;
    const installing = state.phase === 'installing';
    dependencyProgress.hidden = !installing;
    installButton.disabled = installing || state.phase === 'none' || state.phase === 'checking';
    installButton.textContent = installing ? '正在检测/安装…' : '一键检测/安装依赖';
  });

  vscode.postMessage({ type: 'webviewReady' });
  openWelcome?.addEventListener('click', () => vscode.postMessage({ type: 'openWelcome' }));
  button?.addEventListener('click', () => {
    // The sidebar is a UI shell for now; extension messages can be added as workflow actions are defined.
    button.querySelector('span').textContent = '准备就绪';
    window.setTimeout(() => {
      button.querySelector('span').textContent = '继续当前步骤';
    }, 1200);
  });
})();
