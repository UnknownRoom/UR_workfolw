(() => {
  const vscode = acquireVsCodeApi();
  const form = document.getElementById('workflow-form');
  const status = document.getElementById('save-status');
  const fields = {
    name: document.getElementById('workflow-name'),
    trigger: document.getElementById('workflow-trigger'),
    steps: document.getElementById('workflow-steps'),
    notes: document.getElementById('workflow-notes')
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    vscode.postMessage({
      type: 'saveWorkflow',
      payload: {
        name: fields.name.value.trim(),
        trigger: fields.trigger.value,
        steps: fields.steps.value.split('\n').map((step) => step.trim()).filter(Boolean),
        notes: fields.notes.value.trim()
      }
    });
    status.textContent = '正在保存…';
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'workflowData') {
      const data = message.payload;
      fields.name.value = data.name ?? '';
      fields.trigger.value = data.trigger ?? 'manual';
      fields.steps.value = Array.isArray(data.steps) ? data.steps.join('\n') : '';
      fields.notes.value = data.notes ?? '';
    } else if (message?.type === 'saveResult') {
      status.textContent = message.ok ? '配置已保存' : (message.error || '保存失败');
    }
  });

  vscode.postMessage({ type: 'webviewReady' });
})();
