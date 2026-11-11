(() => {
  const vscode = acquireVsCodeApi();
  const title = document.getElementById('welcome-title');
  const description = document.getElementById('welcome-description');
  const version = document.getElementById('welcome-version');
  const setupList = document.getElementById('setup-list');
  const errorMessage = document.getElementById('welcome-error');

  const setValue = (id, value) => {
    const field = document.getElementById(id);
    if (field) field.value = value;
  };

  const renderSteps = (steps) => {
    setupList.replaceChildren();
    for (const step of steps) {
      const item = document.createElement('li');
      item.className = step.complete ? 'setup-item is-complete' : 'setup-item';

      const marker = document.createElement('span');
      marker.className = 'setup-marker';
      marker.textContent = step.complete ? '✓' : '•';
      marker.setAttribute('aria-hidden', 'true');

      const content = document.createElement('div');
      content.className = 'setup-content';
      const heading = document.createElement('strong');
      heading.textContent = step.title;
      const details = document.createElement('span');
      details.textContent = step.description;
      content.append(heading, details);
      item.append(marker, content);

      if (step.action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'setup-action';
        button.dataset.action = step.action;
        button.textContent = step.action === 'openWorkspace' ? '选择文件夹' : '检查并安装';
        item.append(button);
      }
      setupList.append(item);
    }
  };

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'welcomeData') {
      const payload = message.payload;
      const system = payload.system;
      title.textContent = payload.title;
      description.textContent = payload.description;
      version.textContent = `版本 ${payload.version}`;
      setValue('system-os', `${system.operatingSystem} (${system.platform})`);
      setValue('system-arch', `${system.architecture} (${system.arch})`);
      setValue('system-python', system.python.installed
        ? `${system.python.version} · ${system.python.command}` : '未安装');
      setValue('system-git', system.git.installed
        ? `${system.git.version} · ${system.git.command}` : '未安装');
      document.getElementById('report-path').textContent = `检查结果：${payload.reportPath}`;
      renderSteps(payload.configurationSteps);
      errorMessage.hidden = true;
    } else if (message?.type === 'welcomeError') {
      errorMessage.textContent = `系统检查或读取结果失败：${message.message}`;
      errorMessage.hidden = false;
      description.textContent = '检查未能完成。你可以重新检查，或查看下方错误信息。';
    } else if (message?.type === 'ack') {
      description.textContent = message.message || '已打开侧边栏。';
    }
  });

  document.getElementById('open-sidebar')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSidebar' });
  });
  document.getElementById('rerun-check')?.addEventListener('click', () => {
    title.textContent = '正在检查运行环境';
    description.textContent = '正在重新检测系统并读取结果…';
    vscode.postMessage({ type: 'runSystemCheck' });
  });
  setupList?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button) vscode.postMessage({ type: button.dataset.action });
  });
  vscode.postMessage({ type: 'ready' });
})();
